import type { ShellKind } from "../../util/shell";
import { parseCommand } from "./command";
import { grammarsToRead } from "./candidates";
import {
  classifyEnvName,
  valueRunsCode,
  type EnvNameOptions,
} from "./envNames";
import { commandName, dequote, splitRawWords } from "./shellWords";
import { scanSubstitutions } from "./substitutions";

/**
 * The environment variables a command sets, read from the text as each shell
 * writes the assignment:
 *
 *   POSIX        `A=1 B=2 cmd`, `env -i A=1 cmd`, `sudo A=1 cmd`, `command A=1 cmd`,
 *                `export A=1`, `declare -x A=1`, `A+=x cmd`, `A= cmd`, and the same
 *                inside `$(...)`, backticks and `bash -c '...'`
 *   PowerShell   `$env:A = 'x'`, `${env:A} += 'x'`, `Set-Item env:A x`,
 *                `New-Item env:A`, `Remove-Item env:A`,
 *                `[Environment]::SetEnvironmentVariable('A', 'x')`
 *   cmd          `set A=x`, `set "A=x"`, `set /a A=1`, `setx A x`, `cmd /c "set A=x&&c"`
 *
 * The program after the assignments is not decided here: every rule reads it
 * from `commandCandidates`, which looks at every word, so `A=1 git reset
 * --hard` meets the git rules as `git reset --hard`. What this adds is the
 * question the rules cannot ask: does the variable change what that program
 * does (`envNames.ts`)?
 *
 * It over-matches on purpose, like the other scans: a hit only asks. A reason
 * names the variable and never its value.
 */
export interface EnvAssignment {
  name: string;
  /** The value as typed, quotes included. Only used to look for code; never shown. */
  value: string;
  how: "prefix" | "env" | "sudo" | "export" | "powershell" | "cmd";
}

const MAX_DEPTH = 4;
const ASSIGN_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(\+?)=([\s\S]*)$/;
const DECLARERS = new Set([
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
]);
const KEYWORDS = new Set([
  "!",
  "{",
  "(",
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
]);
/** Wrappers that take a command after flags, and the flags that take a value. */
const WRAPPERS: Record<string, Set<string>> = {
  command: new Set(),
  builtin: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  time: new Set(["-f", "-o"]),
  nice: new Set(["-n"]),
  setsid: new Set(),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  ionice: new Set(["-c", "-n", "-p"]),
};
const SUDO_VALUE_FLAGS = new Set([
  "-u",
  "-g",
  "-h",
  "-p",
  "-C",
  "-D",
  "-R",
  "-r",
  "-t",
  "-T",
  "-U",
]);
const ENV_VALUE_FLAGS = new Set(["-u", "-C", "--unset", "--chdir"]);
const REDIRECT = /^(?:\d*|&)(?:>>?|<<?<?)(?:&?[\d-]+|\S*)$/;
const REDIRECT_OPERATOR = /^(?:\d*|&)(?:>>?|<<?<?)$/;

type Sink = EnvAssignment[];

function pushAssignment(
  word: string,
  how: EnvAssignment["how"],
  out: Sink,
): boolean {
  const m = ASSIGN_WORD.exec(word);
  if (!m) return false;
  out.push({ name: m[1], value: m[3], how });
  return true;
}

/** The next index after a run of redirections, which may stand between assignments. */
function skipRedirect(words: string[], i: number): number {
  const w = words[i];
  if (w === undefined || !REDIRECT.test(w)) return i;
  return REDIRECT_OPERATOR.test(w) ? i + 2 : i + 1;
}

/** `env`: its flags, then assignments. Returns the index of the program, or -1 when `-S` was handled. */
function readEnv(
  words: string[],
  from: number,
  out: Sink,
  depth: number,
  shell?: ShellKind,
): number {
  let i = from;
  for (; i < words.length; i++) {
    const w = dequote(words[i]);
    if (w === "--") {
      i++;
      break;
    }
    if (
      w === "-S" ||
      w === "--split-string" ||
      w.startsWith("--split-string=") ||
      /^-S./.test(w)
    ) {
      const text =
        w === "-S" || w === "--split-string"
          ? dequote(words[i + 1] ?? "")
          : w.startsWith("--split-string=")
            ? w.slice(15)
            : w.slice(2);
      scanText(text, out, depth + 1, shell);
      return words.length;
    }
    if (ENV_VALUE_FLAGS.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) continue;
    break;
  }
  while (i < words.length && pushAssignment(words[i], "env", out)) i++;
  return i;
}

/** `sudo` and `doas`: its flags, then `NAME=value` assignments, which sudo passes on. */
function readSudo(words: string[], from: number, out: Sink): number {
  let i = from;
  for (; i < words.length; i++) {
    const w = dequote(words[i]);
    if (w === "--") {
      i++;
      break;
    }
    if (SUDO_VALUE_FLAGS.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) continue;
    break;
  }
  while (i < words.length && pushAssignment(words[i], "sudo", out)) i++;
  return i;
}

/** `command`, `exec`, `nohup`, `time`, `nice`, `timeout`: flags, then the command. */
function skipWrapper(words: string[], from: number, name: string): number {
  const withValue = WRAPPERS[name];
  let i = from;
  for (; i < words.length; i++) {
    const w = dequote(words[i]);
    if (withValue.has(w)) {
      i++;
      continue;
    }
    if (w.startsWith("-") && w.length > 1) continue;
    break;
  }
  // timeout takes a duration before the command
  if (name === "timeout" && /^\d/.test(dequote(words[i] ?? ""))) i++;
  return i;
}

/** The scripts a shell is handed with `-c`, `-Command` or `/c`. */
function nestedScript(
  name: string,
  tail: string[],
): { script: string; shell: ShellKind } | undefined {
  const arg = (i: number) => dequote(tail[i + 1] ?? "");
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(name)) {
    const k = tail.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(dequote(w)));
    const shell = name === "bash" || name === "zsh" ? name : "sh";
    return k >= 0 ? { script: arg(k), shell } : undefined;
  }
  if (name === "powershell" || name === "pwsh") {
    const k = tail.findIndex((w) => /^-(c|command)$/i.test(dequote(w)));
    return k >= 0
      ? {
          script: tail
            .slice(k + 1)
            .map(dequote)
            .join(" "),
          shell: "powershell",
        }
      : undefined;
  }
  if (name === "cmd") {
    const k = tail.findIndex((w) => /^\/[ck]$/i.test(dequote(w)));
    return k >= 0
      ? {
          script: tail
            .slice(k + 1)
            .map(dequote)
            .join(" "),
          shell: "cmd",
        }
      : undefined;
  }
  if (name === "eval")
    return { script: tail.map(dequote).join(" "), shell: "bash" };
  return undefined;
}

function dropIfs(out: Sink, from: number): void {
  for (let k = out.length - 1; k >= from; k--) {
    if (out[k].name === "IFS") out.splice(k, 1);
  }
}

/** One POSIX command part: everything it assigns, and the scripts it hands to a shell. */
function posixPart(
  part: string,
  out: Sink,
  depth: number,
  shell?: ShellKind,
): void {
  const words = splitRawWords(part)
    .map((w) => w.replace(/^(?:\$\(|[({])+/, ""))
    .filter(Boolean);
  const start = out.length;
  let i = 0;
  while (i < words.length) {
    const skipped = skipRedirect(words, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (pushAssignment(words[i], "prefix", out)) {
      i++;
      continue;
    }
    const name = commandName(dequote(words[i]));
    if (KEYWORDS.has(name)) {
      i++;
    } else if (DECLARERS.has(name)) {
      for (const w of words.slice(i + 1)) pushAssignment(w, "export", out);
      return;
    } else if (name === "env") {
      i = readEnv(words, i + 1, out, depth, shell);
    } else if (name === "sudo" || name === "doas") {
      i = readSudo(words, i + 1, out);
    } else if (Object.hasOwn(WRAPPERS, name)) {
      i = skipWrapper(words, i + 1, name);
    } else {
      // `IFS= read -r line` sets it for the builtin that reads, not for a program
      if (name === "read") dropIfs(out, start);
      const nested = nestedScript(name, words.slice(i + 1));
      if (nested && depth < MAX_DEPTH) {
        scanText(nested.script, out, depth + 1, nested.shell);
      }
      return;
    }
  }
}

const PS_ASSIGN =
  /\$(?:env:([A-Za-z_]\w*)|\{env:([^}]+)\})\s*(\+?)=(?![=~])\s*([^;\n]*)/gi;
const PS_DRIVE_WRITE =
  /^\s*(?:set-item|si|new-item|ni|set-content|sc|add-content|ac|clear-item|cli|rename-item|rni|remove-item|ri|rm|del|erase|set-itemproperty|sp)\b/i;
const PS_ENV_PATH = /(?:^|[\s:'"(])env:([A-Za-z_][\w()]*)?([$(])?/gi;
const PS_SET_ENV =
  /\[(?:System\.)?Environment\]::SetEnvironmentVariable\(\s*(?:(['"])([^'"]+)\1|([^,)]*))\s*,?\s*([^)]*)/gi;

function powershellPart(part: string, out: Sink): void {
  for (const m of part.matchAll(PS_ASSIGN)) {
    out.push({ name: m[1] ?? m[2], value: m[4], how: "powershell" });
  }
  for (const m of part.matchAll(PS_SET_ENV)) {
    // a name that is not a literal cannot be read: it is treated as unknown to the list
    out.push({ name: m[2] ?? "?", value: m[4] ?? "", how: "powershell" });
  }
  if (PS_DRIVE_WRITE.test(part)) {
    for (const m of part.matchAll(PS_ENV_PATH)) {
      out.push({
        name: m[1] && !m[2] ? m[1] : "?",
        value: part,
        how: "powershell",
      });
    }
  }
}

const CMD_SET = /^\s*set\s+(?:\/[ap]\s+)?"?([^=\s"]+)=([\s\S]*)$/i;

function cmdPart(part: string, out: Sink, depth: number): void {
  const m = CMD_SET.exec(part);
  if (m) out.push({ name: m[1], value: m[2], how: "cmd" });
  const words = splitRawWords(part).map(dequote);
  if (/^setx$/i.test(words[0] ?? "")) {
    const rest = words.slice(1).filter((w) => !w.startsWith("/"));
    if (rest[0]) out.push({ name: rest[0], value: rest[1] ?? "", how: "cmd" });
  }
  const nested = nestedScript(commandName(words[0] ?? ""), words.slice(1));
  if (nested && depth < MAX_DEPTH)
    scanText(nested.script, out, depth + 1, nested.shell);
}

function scanText(
  command: string,
  out: Sink,
  depth: number,
  shell?: ShellKind,
): void {
  const grammars = depth === 0 ? grammarsToRead(command, shell) : [shell];
  for (const g of grammars) {
    const parts = parseCommand(command).parts;
    for (const part of parts) {
      if (g !== "powershell" && g !== "cmd") posixPart(part, out, depth, g);
      if (g === "powershell" || g === undefined) powershellPart(part, out);
      if (g === "cmd" || g === undefined) cmdPart(part, out, depth);
      if (g === "powershell") {
        const [first, ...rest] = splitRawWords(part);
        const nested = nestedScript(commandName(dequote(first ?? "")), rest);
        if (nested && depth < MAX_DEPTH)
          scanText(nested.script, out, depth + 1, nested.shell);
      }
    }
    if (depth < MAX_DEPTH && g !== "cmd" && g !== "powershell") {
      for (const sub of scanSubstitutions(command, g).subs)
        scanText(sub, out, depth + 1, g);
    }
  }
}

/** Every assignment the command makes, as typed. */
export function envAssignments(
  command: string,
  shell?: ShellKind,
): EnvAssignment[] {
  const out: Sink = [];
  scanText(command, out, 0, shell);
  const seen = new Set<string>();
  return out.filter((a) => {
    const key = `${a.name}=${a.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface EnvHit {
  /** `dangerous` asks at every level; `sensitive` asks below IDGAF */
  severity: "dangerous" | "sensitive";
  name: string;
  /** For the prompt: the name and what it does. Never the value. */
  reason: string;
}

/**
 * The first assignment that changes what a program does, or undefined.
 * `harmless` and `unknown` names pass: the name list is what decides, so an
 * unknown `FOO=bar npm test` does not ask. A value that runs code asks for
 * any name, because the code runs whatever the variable is called.
 */
export function envAssignmentHit(
  command: string,
  shell?: ShellKind,
  options: EnvNameOptions = {},
): EnvHit | undefined {
  let sensitive: EnvHit | undefined;
  for (const a of envAssignments(command, shell)) {
    if (a.name === "?") {
      return {
        severity: "dangerous",
        name: a.name,
        reason: "an environment variable whose name cannot be read",
      };
    }
    const cls = classifyEnvName(a.name, options);
    if (cls.risk === "harmless" && !valueRunsCode(a.value)) continue;
    if (valueRunsCode(a.value)) {
      return {
        severity: "dangerous",
        name: a.name,
        reason: `the value of ${a.name} runs a command`,
      };
    }
    if (cls.risk === "dangerous") {
      return {
        severity: "dangerous",
        name: a.name,
        reason: `${a.name} (${cls.why})`,
      };
    }
    if (cls.risk === "sensitive" && !sensitive) {
      sensitive = {
        severity: "sensitive",
        name: a.name,
        reason: `${a.name} (${cls.why})`,
      };
    }
  }
  return sensitive;
}
