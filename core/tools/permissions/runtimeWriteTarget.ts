import * as fs from "node:fs";
import * as posix from "node:path/posix";
import type { ShellKind } from "../../util/shell";
import { parseCommand } from "./command";
import { effectsOfCommand } from "./commandSpecs";
import { canonicalCmdlet } from "./powershell";
import { resolveAlias } from "./powershellAliases";
import { policyFileHit } from "./selfProtect";
import { commandName, dequote, splitRawWords } from "./shellWords";
import { skipWrapperFlags } from "./wrapperWords";

/**
 * A terminal command whose write target is built when the command runs
 * (ROADMAP B31, security review S3-F6). The path guards (protected paths, the
 * locked policy files) read a path as it is written in the command. A target
 * with a run-time part cannot be read that way: `$d`, `$env:USERPROFILE`,
 * `` `pwd` ``, `*.yaml`, `?`, or a bare name after a `cd` into the home
 * folder. At IDGAF such a command asks instead of running.
 *
 * This is a text scan that only ever adds an ask. It finds a target by the
 * program's known effect (`commandSpecs.ts`: it writes or deletes), takes the
 * operands that can be paths, and looks for the characters the shell expands
 * when it runs. A program with no known effect, or a script that writes where
 * it likes, is not seen: the real fix is the sandbox that denies writes to the
 * policy folders (W8).
 */

/** A word the shell changes when the command runs: a variable, a glob, a backtick, `%VAR%`, a `(expression)`. */
const RUNTIME_PART = /[$`*?]|^['"]?\(|%[A-Za-z_][^%\s]*%/;

/** A directory named from the home folder. */
const HOME_RELATIVE =
  /^['"]?(?:~(?:[\\/]|$)|\$\{?(?:home|env:(?:userprofile|home|homepath|homedrive))\b|%(?:userprofile|homepath|home)%)/i;

/** A path that does not depend on the current directory. */
const ABSOLUTE = /^['"]?(?:[\\/]|~|[A-Za-z]:)/;

/** A redirect to somewhere that is not a file. */
const NOT_A_FILE = /^(?:&\d|\$null|nul|\/dev\/(?:null|stdout|stderr))$/i;

const WRAPPERS = new Set([
  "sudo",
  "env",
  "nohup",
  "time",
  "command",
  "builtin",
  "nice",
  "timeout",
  "exec",
]);

const CHANGES_DIRECTORY = new Set([
  "set-location",
  "push-location",
  "cd",
  "chdir",
  "pushd",
]);

/** PowerShell parameters that take a path, by the shortest prefix PowerShell accepts for each. */
const PATH_PARAMETERS: readonly [string, number][] = [
  ["path", 2],
  ["literalpath", 2],
  ["filepath", 2],
  ["destination", 2],
  ["pspath", 2],
  ["name", 2],
  ["newname", 3],
];

/** PowerShell parameters whose next word is a value that is not a path. */
const VALUE_PARAMETERS: readonly [string, number][] = [
  ["value", 2],
  ["inputobject", 2],
  ["encoding", 2],
  ["filter", 2],
  ["include", 2],
  ["exclude", 2],
  ["itemtype", 2],
  ["stream", 2],
  ["delimiter", 2],
  ["width", 2],
];

/** How many positional operands of a cmdlet are paths; the rest are values. */
const POSITIONAL_PATHS: Record<string, number> = {
  "remove-item": Infinity,
  "copy-item": 2,
  "move-item": 2,
  "rename-item": 2,
};

function matchesParameter(
  word: string,
  list: readonly [string, number][],
): boolean {
  const name = word.replace(/^-/, "").replace(/:.*$/s, "").toLowerCase();
  return list.some(
    ([full, min]) => name.length >= min && full.startsWith(name),
  );
}

/** The parts of one command part: assignments, wrappers and the call operator skipped. */
function programWords(part: string): string[] {
  const words = splitRawWords(part);
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return [];
    const isCall = (w === "&" || w === ".") && words.length > i + 1;
    if (isCall || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(commandName(dequote(w)))) {
      // `env -u A B=1 x`, `timeout 5 x`, `nice -n 5 x`
      i = skipWrapperFlags(words, i + 1, commandName(dequote(w)));
    } else return words.slice(i);
  }
}

/** The operands of a PowerShell cmdlet that are paths. */
function cmdletTargets(cmdlet: string, args: string[]): string[] {
  const out: string[] = [];
  let positional = 0;
  const limit = POSITIONAL_PATHS[cmdlet] ?? 1;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (/^-[A-Za-z]/.test(w)) {
      const attached = w.indexOf(":") > 0 ? w.slice(w.indexOf(":") + 1) : "";
      const isPath = matchesParameter(w, PATH_PARAMETERS);
      if (isPath && attached) out.push(attached);
      else if (isPath && args[i + 1] !== undefined) out.push(args[++i]);
      else if (!attached && matchesParameter(w, VALUE_PARAMETERS)) i++;
    } else if (positional++ < limit) {
      out.push(w);
    }
  }
  return out;
}

/** The operands of a POSIX or cmd program that can be paths: every word that is not an option. */
function programTargets(args: string[]): string[] {
  return args.flatMap((w) => {
    if (/^(?:of|if)=/.test(w)) return w.startsWith("of=") ? [w.slice(3)] : [];
    return w.startsWith("-") ? [] : [w];
  });
}

/** Redirect targets in a part: `> f`, `>>f`, `2> f`, `&> f`, `*> f`. */
function redirectTargets(part: string): string[] {
  const words = splitRawWords(part);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(?:\d|&|\*)?>>?(.*)$/.exec(words[i]);
    if (!m || /^(?:\d|&|\*)?>\(/.test(words[i])) continue;
    const target = m[1] || words[i + 1];
    if (target && !NOT_A_FILE.test(target)) out.push(target);
  }
  return out;
}

/** The write targets of one part of a command, as typed. */
function targetsOf(part: string, shell: ShellKind | undefined): string[] {
  const targets = redirectTargets(part);
  const words = programWords(part);
  if (words.length === 0) return targets;
  const name = commandName(dequote(words[0]));
  const cmdlet = canonicalCmdlet(name);
  const effects = effectsOfCommand(name);
  if (!effects.has("write") && !effects.has("delete")) return targets;
  const args = words.slice(1).filter((w) => !/^\d*>/.test(w));
  const posix = shell === "bash" || shell === "zsh" || shell === "sh";
  const isCmdlet = !posix && cmdlet?.includes("-");
  return [
    ...targets,
    ...(isCmdlet && cmdlet
      ? cmdletTargets(cmdlet, args)
      : programTargets(args)),
  ];
}

/** Does this part move to a folder named from the home folder? */
function entersHome(part: string): boolean {
  const words = programWords(part);
  if (words.length < 2) return false;
  const name = commandName(dequote(words[0]));
  const cmdlet = resolveAlias(name) ?? name;
  if (!CHANGES_DIRECTORY.has(cmdlet)) return false;
  const target = words.slice(1).find((w) => !/^-/.test(w));
  return target !== undefined && HOME_RELATIVE.test(target);
}

function short(word: string): string {
  return word.length > 60 ? `${word.slice(0, 57)}...` : word;
}

/** A variable the command sets once, to a literal, before the part that uses it. */
type Known = Map<string, string>;

/** `$name = <right-hand side>`, the whole statement. */
const ASSIGN_PS = /^\$([A-Za-z_]\w*)\s*=\s*(.+)$/s;
const LITERAL_POSIX =
  /^([A-Za-z_]\w*)=('[^']*'|"[^"$`]*"|[^\s"'$`*?;&|<>()]+)$/;

/** Constructs that change a variable behind the scanner's back. */
const HIDDEN_ASSIGNMENT =
  /\b(?:set-variable|new-variable|clear-variable|remove-variable|sv|nv|clv|rv|read-host)\b|(?:^|[;&|\n({]\s*)(?:read|mapfile|readarray)\s|printf\s+-v|\[ref\]|-(?:out|error|warning|information|pipeline)?variable\b|\s-(?:ov|ev|wv|iv|pv)\b/i;

/** The key a variable is kept under: PowerShell and cmd ignore case, the others do not. */
function keyOf(name: string, shell?: ShellKind): string {
  return shell === "powershell" || shell === "cmd" ? name.toLowerCase() : name;
}

/** Is `name` written exactly once in the command: assigned, incremented, a loop variable or a parameter? */
function setOnce(command: string, name: string): boolean {
  const writes = [
    `\\$\\{?${name}\\}?\\s*(?:[-+*/%.]|\\+\\+|--)?=(?!=)`,
    `\\$\\{?${name}\\}?\\s*(?:\\+\\+|--)`,
    `\\(\\s*\\$${name}\\s+in\\b`,
    `\\bfor\\s+${name}\\b`,
    `param\\s*\\([^)]*\\$${name}\\b`,
    `(?<![\\w$])${name}=(?!=)`,
  ];
  return (command.match(new RegExp(writes.join("|"), "gi")) ?? []).length === 1;
}

/** The literal this part assigns, when it is the only write of that variable. */
function literalAssignment(
  part: string,
  command: string,
  known: Known,
  shell?: ShellKind,
  cwd?: string,
): [string, string] | undefined {
  const posix = shell === "bash" || shell === "zsh" || shell === "sh";
  const ps = posix ? undefined : ASSIGN_PS.exec(part);
  const m = ps ?? LITERAL_POSIX.exec(part);
  if (!m || HIDDEN_ASSIGNMENT.test(command) || !setOnce(command, m[1])) {
    return undefined;
  }
  const value = ps ? valueOf(m[2].trim(), known, shell, cwd) : dequote(m[2]);
  return value === undefined ? undefined : [keyOf(m[1], shell), value];
}

/**
 * The text a PowerShell right-hand side is worth when every piece of it is
 * known: a quoted string, a double-quoted string holding only known
 * variables, `$PWD`, `$env:TEMP`, or `Join-Path` of such pieces. Anything else
 * (a command, a subexpression, a variable that is not known) is undefined,
 * and the variable stays unresolved.
 */
function valueOf(
  rhs: string,
  known: Known,
  shell?: ShellKind,
  cwd?: string,
): string | undefined {
  const text = rhs.replace(/^\((.*)\)$/s, "$1").trim();
  const join = /^join-path\s+(.*)$/is.exec(text);
  const words = join
    ? splitRawWords(join[1]).filter((w) => !/^-(?:path|childpath)$/i.test(w))
    : [text];
  if (words.length === 0 || (join && words.length > 3)) return undefined;
  // a bare word on its own is a command, not a string
  if (!join && !/^["'$]/.test(text)) return undefined;
  const parts: string[] = [];
  for (const word of words) {
    const value = pieceOf(word, known, shell, cwd);
    if (value === undefined) return undefined;
    parts.push(value);
  }
  return parts.join(join ? "/" : "");
}

function pieceOf(
  word: string,
  known: Known,
  shell?: ShellKind,
  cwd?: string,
): string | undefined {
  if (/^'[^']*'$/.test(word)) return word.slice(1, -1);
  const body = /^"([^"`]*)"$/.exec(word)?.[1] ?? word;
  const text = substitute(body, known, shell, cwd);
  // a bare word may not be a variable, a switch or an expression
  const bare = body === word;
  if (RUNTIME_PART.test(text) || /[\s;|&<>(){}]/.test(text)) return undefined;
  return bare && /^-/.test(text) ? undefined : text;
}

/** The word with the variables that are known replaced by their values. */
function substitute(
  word: string,
  known: Known,
  shell?: ShellKind,
  cwd?: string,
): string {
  const powershell = shell === "powershell";
  return word.replace(
    /\$env:(temp|tmp)\b|\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/gi,
    (whole, env?: string, braced?: string, plain?: string) => {
      if (env !== undefined)
        return known.get(`env:${env.toLowerCase()}`) ?? whole;
      const name = keyOf(braced ?? plain ?? "", shell);
      if (name === "pwd" && powershell && cwd !== undefined) return cwd;
      return known.get(name) ?? whole;
    },
  );
}

/** A path with forward slashes, `..` folded away, no trailing slash, lower case. */
function norm(path: string): string {
  return posix
    .normalize(path.replace(/\\/g, "/"))
    .replace(/\/+$/, "")
    .toLowerCase();
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The user's temp folder, when it is certain: on Windows `%LOCALAPPDATA%\Temp`,
 * and `$env:TEMP` or `$env:TMP` is that very folder. Each variable that is
 * proven is entered in `known`, so `$env:TEMP` reads as its value; the rest stay
 * unresolved and ask. Elsewhere, or with anything unset or different, nothing
 * is proven.
 */
function provenTemp(
  known: Known,
  env: Record<string, string | undefined>,
  platform: string,
): string | undefined {
  const local = env.LOCALAPPDATA;
  if (platform !== "win32" || !local) return undefined;
  const root = norm(`${local}/Temp`);
  let proven = false;
  for (const name of ["TEMP", "TMP"]) {
    const value = env[name];
    if (value && norm(value) === root) {
      known.set(`env:${name.toLowerCase()}`, value);
      proven = true;
    }
  }
  return proven ? `${local}/Temp` : undefined;
}

/**
 * Does a path under `root` leave it through a link or a junction? The deepest
 * part that exists is looked at: a link there, or a real location outside the
 * root, escapes. Anything that cannot be read is taken to escape.
 */
function escapesThroughLink(path: string, root: string): boolean {
  try {
    let probe = path.replace(/\\/g, "/");
    let entry: fs.Stats | undefined;
    while (!entry) {
      try {
        entry = fs.lstatSync(probe);
      } catch {
        const up = posix.dirname(probe);
        if (up === probe) return true;
        probe = up;
      }
    }
    if (entry.isSymbolicLink()) return true;
    return !within(
      norm(fs.realpathSync.native(probe)),
      norm(fs.realpathSync.native(root)),
    );
  } catch {
    return true;
  }
}

/** Is a path that was worked out inside the workspace, with no `..` leaving it? */
function insideWorkspace(path: string, cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  const root = norm(cwd);
  const full = /^(?:[A-Za-z]:)?\//.test(path.replace(/\\/g, "/"))
    ? norm(path)
    : norm(`${root}/${path}`);
  return full === root || full.startsWith(`${root}/`);
}

/** Does a path, spelled out, name a file the product loads as config, code, rules or hooks? */
function namesPolicyFile(
  path: string,
  shell: ShellKind | undefined,
  cwd: string | undefined,
): boolean {
  const hit = policyFileHit({
    toolName: "run_terminal_command",
    parsedArgs: { command: `Remove-Item ${JSON.stringify(path)}` },
    cwd,
    shell,
  });
  return hit !== undefined;
}

/**
 * What stops the command's write target being read from its text, or
 * undefined when every target it can see is written out. A variable the
 * command sets once to something it can work out (a literal, `$PWD`,
 * `$env:TEMP`, `Join-Path` of such pieces) counts as written out when the
 * result lies inside the workspace and is not a locked policy file; a result
 * anywhere else, and anything it cannot work out, asks. A reason names the
 * word, for the ask.
 */
export function runtimeWriteTarget(
  command: string,
  shell?: ShellKind,
  cwd?: string,
  where: {
    env?: Record<string, string | undefined>;
    platform?: string;
  } = {},
): string | undefined {
  let homeCd = false;
  const known: Known = new Map();
  const tempRoot =
    shell === "powershell" || shell === undefined
      ? provenTemp(
          known,
          where.env ?? process.env,
          where.platform ?? process.platform,
        )
      : undefined;
  // script blocks and loop bodies hold statements of their own
  const statements = parseCommand(command).parts.flatMap((part) =>
    part
      .split(/[{}]/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
  for (const part of statements) {
    const assigned = literalAssignment(part, command, known, shell, cwd);
    if (assigned) known.set(assigned[0], assigned[1]);
    for (const typed of targetsOf(part, shell)) {
      const target = substitute(typed, known, shell, cwd);
      if (RUNTIME_PART.test(target)) {
        return `a write to ${short(typed)}, a path built when the command runs`;
      }
      if (homeCd && !ABSOLUTE.test(target)) {
        return `a write to ${short(typed)} after a cd into the home folder`;
      }
      if (target === typed) continue;
      const path = target.replace(/^(['"])(.*)\1$/s, "$2");
      const inTemp =
        tempRoot !== undefined &&
        within(norm(path), norm(tempRoot)) &&
        !escapesThroughLink(path, tempRoot);
      if (!inTemp && !insideWorkspace(path, cwd)) {
        return `a write to ${short(typed)}, which is outside the workspace and the temp folder once its variable is read`;
      }
      if (namesPolicyFile(path, shell, cwd)) {
        return `a write to ${short(typed)}, which is a policy file once its variable is read`;
      }
    }
    if (entersHome(part)) homeCd = true;
  }
  return undefined;
}
