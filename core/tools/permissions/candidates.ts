import { isPosixShell, type ShellKind } from "../../util/shell";
import { parseCommand } from "./command";
import { detectCommandShell, familyOf } from "./detectShell";
import { canonicalCmdlet, isPowerShellAlias } from "./powershell";
import {
  commandName,
  dequote,
  splitRawWords,
  stripGrouping,
} from "./shellWords";
import { scanSubstitutions } from "./substitutions";

/**
 * Every string a deny or ask rule should be tried against for a command.
 * It reads the command the way the shell will: quotes and escapes removed
 * (`git 'push'`, `g\it`, `$'\x67it'`), directories and `.exe` dropped from the
 * command name, `git -C x -c y push` read as `git push`, wrappers such as
 * `sudo`, `env` and `timeout` skipped, and the commands inside `$(...)`,
 * `bash -c`, `powershell -Command`, `python -c`, `eval`, `xargs` and pipes
 * into a shell included. It only ever adds candidates, so a deny or ask rule
 * can match more, never less.
 */
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const PS_SHELLS = new Set(["powershell", "pwsh"]);
const INTERPRETER = /^(python|node|nodejs|deno|bun|perl|ruby|php|lua)[\d.]*$/;
const INLINE_FLAGS = new Set(["-c", "-e", "-p", "-r", "--eval", "--print"]);
const GIT_OPTS_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);
const XARGS_OPTS_WITH_ARG = new Set(["-n", "-I", "-P", "-d", "-L", "-s", "-E"]);
const MAX_DEPTH = 4;
const MAX_CANDIDATES = 800;

/** An alias's cmdlet in its usual capitalisation: `Remove-Item`, not `remove-item`. */
function canonicalCmdletName(alias: string): string {
  const cmdlet = canonicalCmdlet(alias) ?? alias;
  // `ise` stands for a program, not a Verb-Noun cmdlet: leave its name alone
  if (!cmdlet.includes("-")) return cmdlet;
  return cmdlet
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("-");
}

/** Text inside matching quotes, for scripts passed to `python -c`, `sh <<<` and similar. */
function quotedLiterals(text: string): string[] {
  const out: string[] = [];
  const re = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[2]);
  return out;
}

function skipGitOptions(tail: string[]): string[] {
  let i = 0;
  while (i < tail.length && tail[i].startsWith("-")) {
    i += GIT_OPTS_WITH_ARG.has(tail[i]) ? 2 : 1;
  }
  return tail.slice(i);
}

function unquoteWord(word: string): string {
  return dequote(stripGrouping(word));
}

/** Scripts a command word can run, so a rule sees the command inside them. */
function nested(
  name: string,
  tail: string[],
  depth: number,
  out: Set<string>,
  cap: CandidateCap,
  shell: ShellKind | undefined,
): void {
  // A script handed to a named shell is that shell's; one handed to an
  // interpreter, awk or eval is read as the current shell reads it
  const run = (
    script: string | undefined,
    as: ShellKind | undefined = shell,
  ) => {
    if (script) addCommand(script, depth + 1, out, cap, as);
  };
  if (POSIX_SHELLS.has(name)) {
    const k = tail.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    const kind: ShellKind | undefined =
      name === "zsh"
        ? "zsh"
        : name === "bash"
          ? "bash"
          : name === "sh" || name === "dash"
            ? "sh"
            : undefined;
    if (k >= 0) run(tail[k + 1], kind);
  } else if (PS_SHELLS.has(name)) {
    const k = tail.findIndex((w) => /^-(c|command)$/i.test(w));
    if (k >= 0) run(tail.slice(k + 1).join(" "), "powershell");
  } else if (name === "cmd") {
    const k = tail.findIndex((w) => /^\/[ck]$/i.test(w));
    if (k >= 0) run(tail.slice(k + 1).join(" "), "cmd");
  } else if (name === "env") {
    // `env -S 'FOO=1 git push'` splits a string into a command
    const k = tail.findIndex((w) => /^(-S|--split-string)/.test(w));
    if (k >= 0) {
      const w = tail[k];
      const attached = w.startsWith("--split-string=")
        ? w.slice(15)
        : w.length > 2 && !w.startsWith("--")
          ? w.slice(2)
          : undefined;
      run(attached ?? tail[k + 1]);
    }
  } else if (name === "eval") {
    run(tail.join(" "));
  } else if (name === "iex" || name === "invoke-expression") {
    run(tail.join(" "), "powershell");
  } else if (INTERPRETER.test(name)) {
    const k = tail.findIndex((w) => INLINE_FLAGS.has(w.toLowerCase()));
    if (k >= 0 && tail[k + 1]) {
      // os.system and the like hand the string to whichever shell is there
      for (const lit of quotedLiterals(tail[k + 1])) run(lit, undefined);
    }
  } else if (
    name === "awk" ||
    name === "gawk" ||
    name === "nawk" ||
    name === "mawk"
  ) {
    const systemCall = /system\s*\(\s*(["'])([\s\S]*?)\1\s*\)/g;
    for (const w of tail) {
      for (const s of [w, ...quotedLiterals(w)]) {
        systemCall.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = systemCall.exec(s))) run(m[2], undefined);
      }
    }
  }
}

const ASSIGN_KEYWORD = /^(?:export|declare|typeset|local|readonly)\b\s+/;

/** `NAME=value`, including `export`/`declare` and their flags. The whole part must be the assignment. */
function assignmentOf(part: string): [string, string] | undefined {
  let body = part.trim();
  if (ASSIGN_KEYWORD.test(body)) {
    body = body.replace(ASSIGN_KEYWORD, "");
    body = body.replace(/^(?:-[A-Za-z]+\s+)+/, "");
  }
  const m = /^([A-Za-z_]\w*)=((?:\S)*)$/.exec(body);
  if (!m) return undefined;
  return [m[1], dequote(m[2])];
}

/** `printf -v NAME value` assigns NAME, the same as `NAME=value`. */
function printfAssignment(part: string): [string, string] | undefined {
  const words = splitRawWords(part).map(unquoteWord);
  if (words[0] !== "printf") return undefined;
  const v = words.findIndex((w, i) => i > 0 && w === "-v");
  if (v < 0 || words[v + 1] === undefined || words[v + 2] === undefined) {
    return undefined;
  }
  return [words[v + 1], words[v + 2]];
}

/** Replace known variables and `$IFS`, repeatedly, so `H=$G` then `$H` resolves. */
function expandKnown(text: string, vars: Record<string, string>): string {
  let cur = text;
  for (let n = 0; n < 8; n++) {
    const next = cur
      .replace(/\$\{IFS\}|\$IFS/g, " ")
      .replace(
        /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
        (s, braced: string | undefined, plain: string | undefined) => {
          const name = braced || plain || "";
          return Object.prototype.hasOwnProperty.call(vars, name)
            ? vars[name]
            : s;
        },
      );
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** `{git,push}` is the words `git` and `push`. Quoted braces are left alone. */
function expandBraceWord(word: string): string[] {
  if (word.startsWith("'") || word.startsWith('"')) return [word];
  const m = /^((?:[^{}\\]|\\.)*)\{([^{}]*)\}(.*)$/.exec(word);
  if (!m || !m[2].includes(",")) return [word];
  const alts = m[2].split(",");
  if (alts.length > 16) return [word];
  const out: string[] = [];
  for (const alt of alts) {
    for (const next of expandBraceWord(m[1] + alt + m[3])) {
      out.push(next);
      if (out.length > 32) return [word];
    }
  }
  return out;
}

function expandBraces(part: string): string | undefined {
  const words = splitRawWords(part);
  if (words.length === 0) return undefined;
  let changed = false;
  const expanded: string[] = [];
  for (const w of words) {
    const pieces = expandBraceWord(w);
    if (pieces.length !== 1 || pieces[0] !== w) changed = true;
    expanded.push(...pieces);
  }
  return changed ? expanded.map(unquoteWord).join(" ") : undefined;
}

/** Set once a command is too large to expand in full. Callers must fail closed. */
type CandidateCap = { truncated: boolean };

function overCap(out: Set<string>, cap: CandidateCap): boolean {
  if (out.size <= MAX_CANDIDATES) return false;
  cap.truncated = true;
  return true;
}

function addPart(
  part: string,
  depth: number,
  out: Set<string>,
  cap: CandidateCap,
  shell?: ShellKind,
): void {
  if (overCap(out, cap)) return;
  out.add(part);
  // PowerShell's escape character: g`it is git. `$ and `( stay literal.
  if (
    shell !== "bash" &&
    shell !== "zsh" &&
    shell !== "sh" &&
    shell !== "cmd"
  ) {
    const plain = part.replace(/`([A-Za-z0-9_./-])/g, "$1");
    if (plain !== part) addPart(plain, depth, out, cap, shell);
  }
  const rawWords = splitRawWords(part).map(stripGrouping).filter(Boolean);
  const words = rawWords.map(dequote).filter(Boolean);
  if (words.length === 0) return;
  out.add(words.join(" "));

  for (let i = 0; i < rawWords.length; i++) {
    if (overCap(out, cap)) return;
    const tail = rawWords.slice(i + 1).map(unquoteWord);
    // A Windows path keeps its backslashes in the raw word; `g\it` loses them.
    // Try both readings of the command word.
    const names = new Set([
      commandName(unquoteWord(rawWords[i])),
      commandName(rawWords[i]),
    ]);
    for (const name of names) {
      if (!name) continue;
      out.add([name, ...tail].join(" "));
      // PowerShell's `rm` is Remove-Item: a rule on either sees both
      if (isPowerShellAlias(name)) {
        out.add([canonicalCmdletName(name), ...tail].join(" "));
      }
      if (name === "git") out.add(["git", ...skipGitOptions(tail)].join(" "));
      // zsh's `=git` is the path of git: the command is git
      if (/^=[a-z]/.test(name)) out.add([name.slice(1), ...tail].join(" "));
      if (depth < MAX_DEPTH) nested(name, tail, depth, out, cap, shell);
    }
  }
}

/** Each part of a command, plus what is inside substitutions, scripts and simple variables. */
function addCommand(
  command: string,
  depth: number,
  out: Set<string>,
  cap: CandidateCap,
  shell?: ShellKind,
): void {
  if (overCap(out, cap)) return;
  const parts = parseCommand(command).parts;
  const vars: Record<string, string> = {};

  for (const p of parts) {
    addPart(p, depth, out, cap, shell);
    const assign = assignmentOf(p) ?? printfAssignment(p);
    if (assign) vars[assign[0]] = expandKnown(assign[1], vars);
    if (/[$\{]/.test(p)) {
      const expanded = expandKnown(p, vars);
      const text = expanded;
      if (text !== p) addPart(text, depth, out, cap, shell);
      const braced = expandBraces(text);
      if (braced && braced !== text) addPart(braced, depth, out, cap, shell);
    }
  }
  if (depth >= MAX_DEPTH) return;

  const found = scanSubstitutions(command, shell);
  // Code the text does not show (zsh `${(e)x}`): any rule must fail closed
  if (found.dynamic.length) cap.truncated = true;
  for (const sub of found.subs) {
    addCommand(sub, depth + 1, out, cap, shell);
  }

  const names = parts.map((p) =>
    commandName(unquoteWord(splitRawWords(p)[0] ?? "")),
  );
  // `echo '...' | sh`, `sh <<< '...'`: text fed to a shell is a script.
  const feedsShell =
    /<<</.test(command) ||
    names.some(
      (n, i) => POSIX_SHELLS.has(n) && !/\s-[a-z]*c\b/.test(" " + parts[i]),
    );
  if (feedsShell) {
    for (const p of parts) {
      for (const lit of quotedLiterals(p)) {
        addCommand(lit, depth + 1, out, cap, "bash");
      }
    }
  }
  // `echo push | xargs git` runs `git push`.
  parts.forEach((p, i) => {
    if (names[i] !== "xargs") return;
    const w = splitRawWords(p).slice(1).map(unquoteWord);
    let k = 0;
    while (k < w.length && w[k].startsWith("-")) {
      k += XARGS_OPTS_WITH_ARG.has(w[k]) ? 2 : 1;
    }
    const tail = w.slice(k).join(" ");
    if (!tail) return;
    parts.forEach((q, j) => {
      if (j !== i && (names[j] === "echo" || names[j] === "printf")) {
        const args = splitRawWords(q).slice(1).map(unquoteWord).join(" ");
        addPart(`${tail} ${args}`.trim(), depth + 1, out, cap, shell);
      }
    });
  });
}

export interface CommandCandidateSet {
  list: string[];
  /**
   * True when the command was too large to expand in full. A later part may
   * be missing, so a deny, ask, effect or protected-path check must fail
   * closed instead of treating the gap as "no match".
   */
  truncated: boolean;
}

/**
 * The shells to read `command` as. With no shell, or one that is not parsed,
 * `undefined`: every grammar at once, which is the conservative reading. With
 * a shell, its own grammar plus any other the text plausibly belongs to
 * (bash text sent to PowerShell is read both ways), so a command cannot look
 * safe in one grammar while the real shell reads it as dangerous. Text that
 * only suggests the shell's own family adds nothing.
 */
export function grammarsToRead(
  command: string,
  shell?: ShellKind,
): (ShellKind | undefined)[] {
  if (!shell || shell === "unknown") return [undefined];
  const family = familyOf(shell);
  const { likely } = detectCommandShell(command);
  const extra: ShellKind[] = [];
  const seen = new Set([family]);
  for (const l of likely) {
    const f = familyOf(l);
    if (f && !seen.has(f)) {
      seen.add(f);
      extra.push(l);
    }
  }
  return [shell, ...extra];
}

/**
 * PowerShell reads curly quotes as quotes, an en dash, em dash or horizontal
 * bar as a parameter's dash and any Unicode space as a space, so `git`
 * followed by `push` in curly quotes is `git push` there. The same text with
 * the ASCII characters, for a deny rule, an ask rule or a protected path to
 * meet. A POSIX shell keeps them as ordinary characters.
 */
function asciiLookalikes(command: string): string {
  return command
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/[\u2013-\u2015]/g, "-")
    .replace(
      /[\u00a0\u0085\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g,
      " ",
    );
}

/** Every string a deny or ask rule should be tried against, and whether the cap stopped the expansion. */
export function commandCandidateSet(
  command: string,
  shell?: ShellKind,
): CommandCandidateSet {
  const out = new Set<string>([command]);
  const cap: CandidateCap = { truncated: false };
  for (const g of grammarsToRead(command, shell)) {
    addCommand(command, 0, out, cap, g);
  }
  // PowerShell's own spelling of the same command, when it is not POSIX's
  const ascii = isPosixShell(shell) ? command : asciiLookalikes(command);
  if (ascii !== command) {
    for (const g of grammarsToRead(ascii, shell)) {
      addCommand(ascii, 0, out, cap, g);
    }
  }
  return { list: [...out], truncated: cap.truncated };
}

/** Every string a deny or ask rule should be tried against for a whole command. */
export function commandCandidates(
  command: string,
  shell?: ShellKind,
): string[] {
  return commandCandidateSet(command, shell).list;
}

/** The candidates for one part of a command. */
export function ruleCandidates(part: string, shell?: ShellKind): string[] {
  return commandCandidates(part, shell);
}
