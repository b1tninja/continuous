/**
 * Text written for another shell than the one that will read it: bash on
 * Windows PowerShell, PowerShell in bash, either in cmd. Each finding names a
 * rule, the span of the command it is about, what is wrong and what to write
 * instead (plans/research/env-windows-shells-and-wsl.md, sections 3 and 6,
 * where every rule below was measured).
 *
 * Pure and not wired: nothing calls it from a tool path yet. Whether a finding
 * stops a command before it runs or is added to a result after it ran is the
 * owner's decision (EV26, EV28). It never changes the command: a suggestion
 * is text for the model to send back, not a rewrite.
 *
 * It reads the text with the target shell's quoting rules, so `&&` inside a
 * string, a here-string, a comment or the quoted script of `bash -c '...'` is
 * not a finding, and `&&` is not one at all under PowerShell 7 or bash.
 */

export type HintFamily = "powershell" | "posix" | "cmd";

/** Which PowerShell: 5.1 rejects `&&`, `||` and a trailing `&`; 7 accepts them. */
export type PowerShellVersion = "5.1" | "7" | "unknown";

export interface HintTarget {
  family: HintFamily;
  /** PowerShell only; "unknown" turns 5.1-only errors into warnings. Default "5.1". */
  version?: PowerShellVersion;
  /**
   * Whether Unix tools (grep, sed, head) are known to be on PATH, from a
   * session probe. Undefined when not probed.
   */
  unixTools?: boolean;
}

export type HintSeverity = "error" | "warn";

export interface ShellHint {
  /** Stable id, so a test, a setting or an audit record can name it. */
  rule: string;
  /** error: the shell will reject it or it certainly does the wrong thing. warn: likely. */
  severity: HintSeverity;
  /** Offsets into the command, end exclusive. */
  start: number;
  end: number;
  /** What is wrong, one sentence. */
  message: string;
  /** What to write instead. */
  suggestion: string;
}

const PLACEHOLDER = "x";

interface Masked {
  /** Strings, comments, here-strings and escaped characters replaced, offsets kept. */
  all: string;
  /** Only single-quoted text, here-strings and comments replaced: double-quoted text stays. */
  literal: string;
  /** Spans of double-quoted strings, delimiters included. */
  doubles: [number, number][];
  /** Double-quoted strings that never end. */
  unterminated: [number, number][];
  /** Heredoc operators seen (POSIX reading only). */
  heredocs: [number, number][];
}

function blank(chars: string[], from: number, to: number): void {
  for (let i = from; i < to && i < chars.length; i++) {
    // Newlines inside a string do not end a statement
    chars[i] = PLACEHOLDER;
  }
}

interface ScanState {
  command: string;
  n: number;
  all: string[];
  literal: string[];
  doubles: [number, number][];
  unterminated: [number, number][];
  heredocs: [number, number][];
  pendingHeredoc?: string;
}

/** Text no shell reads as code: replaced in both masks. Returns where it ends. */
function literalSpan(s: ScanState, from: number, end: number): number {
  blank(s.all, from, end);
  blank(s.literal, from, end);
  return end;
}

/** A double-quoted string: its text is code-like (variables expand), so only `all` is masked. */
function doubleSpan(s: ScanState, from: number, close: number): number {
  if (close >= s.n) s.unterminated.push([from, s.n]);
  const end = Math.min(close + 1, s.n);
  s.doubles.push([from, end]);
  blank(s.all, from, end);
  return end;
}

function atTokenStart(command: string, i: number): boolean {
  return i === 0 || /[\s;|&(){}]/.test(command[i - 1]);
}

function lineEnd(command: string, from: number): number {
  const end = command.indexOf("\n", from);
  return end < 0 ? command.length : end;
}

/** One step of PowerShell's quoting: the index after a special span, or undefined. */
function stepPowerShell(s: ScanState, i: number): number | undefined {
  const { command, n } = s;
  const c = command[i];
  const next = command[i + 1];
  // Here-strings: @' or @" then a newline, closed by '@ or "@ at a line start
  if (
    c === "@" &&
    (next === "'" || next === '"') &&
    /^\r?\n/.test(command.slice(i + 2))
  ) {
    const close = command.indexOf(`\n${next}@`, i + 2);
    return literalSpan(s, i, close < 0 ? n : close + 3);
  }
  if (c === "<" && next === "#") {
    const close = command.indexOf("#>", i + 2);
    return literalSpan(s, i, close < 0 ? n : close + 2);
  }
  if (c === "#" && atTokenStart(command, i))
    return literalSpan(s, i, lineEnd(command, i));
  if (c === "`") {
    // The escape character; before a newline it continues the line
    blank(s.all, i, i + 2);
    return i + 2;
  }
  if (c === "'") {
    let j = i + 1;
    while (j < n && !(command[j] === "'" && command[j + 1] !== "'"))
      j += command[j] === "'" ? 2 : 1;
    return literalSpan(s, i, Math.min(j + 1, n));
  }
  if (c === '"') {
    let j = i + 1;
    while (j < n && !(command[j] === '"' && command[j + 1] !== '"'))
      j += command[j] === "`" || command[j] === '"' ? 2 : 1;
    return doubleSpan(s, i, j);
  }
  return undefined;
}

/** A heredoc's body, from the newline after its operator to the delimiter line. */
function heredocBody(s: ScanState, newline: number, delimiter: string): number {
  let start = newline + 1;
  while (start < s.n) {
    const end = lineEnd(s.command, start);
    if (
      s.command.slice(start, end).replace(/^\t+/, "").replace(/\r$/, "") ===
      delimiter
    ) {
      return literalSpan(s, newline + 1, end);
    }
    start = end + 1;
  }
  return literalSpan(s, newline + 1, s.n);
}

/** One step of POSIX quoting, heredocs and comments. */
function stepPosix(s: ScanState, i: number): number | undefined {
  const { command, n } = s;
  const c = command[i];
  if (c === "\n" && s.pendingHeredoc !== undefined) {
    const delimiter = s.pendingHeredoc;
    s.pendingHeredoc = undefined;
    return heredocBody(s, i, delimiter);
  }
  if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
    const m = /^<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|\?([A-Za-z_][\w.-]*))/.exec(
      command.slice(i),
    );
    if (m) {
      s.pendingHeredoc = m[1] ?? m[2] ?? m[3];
      s.heredocs.push([i, i + m[0].length]);
      blank(s.all, i + 2, i + m[0].length);
      return i + m[0].length;
    }
  }
  if (c === "#" && atTokenStart(command, i))
    return literalSpan(s, i, lineEnd(command, i));
  if (c === "\\") {
    blank(s.all, i, i + 2);
    return i + 2;
  }
  if (c === "'" || (c === "$" && command[i + 1] === "'")) {
    const ansi = c === "$";
    let j = i + (ansi ? 2 : 1);
    while (j < n && command[j] !== "'")
      j += ansi && command[j] === "\\" ? 2 : 1;
    return literalSpan(s, i, Math.min(j + 1, n));
  }
  if (c === '"') {
    let j = i + 1;
    while (j < n && command[j] !== '"') j += command[j] === "\\" ? 2 : 1;
    return doubleSpan(s, i, j);
  }
  return undefined;
}

/** cmd: double quotes only; ^ escapes the next character. */
function stepCmd(s: ScanState, i: number): number | undefined {
  const c = s.command[i];
  if (c === "^") {
    blank(s.all, i, i + 2);
    return i + 2;
  }
  if (c === '"') {
    const close = s.command.indexOf('"', i + 1);
    return doubleSpan(s, i, close < 0 ? s.n : close);
  }
  return undefined;
}

/** Reads the command with the target's quoting rules. */
function mask(command: string, family: HintFamily): Masked {
  const s: ScanState = {
    command,
    n: command.length,
    all: command.split(""),
    literal: command.split(""),
    doubles: [],
    unterminated: [],
    heredocs: [],
  };
  const step =
    family === "powershell"
      ? stepPowerShell
      : family === "posix"
        ? stepPosix
        : stepCmd;
  let i = 0;
  while (i < s.n) i = step(s, i) ?? i + 1;
  return {
    all: s.all.join(""),
    literal: s.literal.join(""),
    doubles: s.doubles,
    unterminated: s.unterminated,
    heredocs: s.heredocs,
  };
}

interface Statement {
  start: number;
  end: number;
  /** The words, as written, with their offsets; redirection targets left out. */
  words: { text: string; start: number; end: number }[];
}

/** Simple commands: the text between separators, read on the masked text. */
function statements(
  command: string,
  masked: string,
  family: HintFamily,
): Statement[] {
  const separators =
    family === "cmd" ? /&&|\|\||[&|\n()]/g : /&&|\|\||\$\(|[;\n|&(){}]/g;
  const out: Statement[] = [];
  let from = 0;
  const push = (end: number) => {
    const words: Statement["words"] = [];
    const wordRe = /\S+/g;
    const segment = masked.slice(from, end);
    let m: RegExpExecArray | null;
    let skipNext = false;
    while ((m = wordRe.exec(segment))) {
      const start = from + m.index;
      const text = command.slice(start, start + m[0].length);
      const bare = m[0];
      if (skipNext) {
        skipNext = false;
        continue;
      }
      // A redirection and its target are not words of the command
      if (/^(\d|\*)?>>?(&\d)?$|^&>$|^<$/.test(bare)) {
        skipNext = true;
        continue;
      }
      if (/^(\d|\*)?>>?\S|^&>\S/.test(bare)) continue;
      words.push({ text, start, end: start + m[0].length });
    }
    if (words.length) out.push({ start: from, end, words });
  };
  let m: RegExpExecArray | null;
  separators.lastIndex = 0;
  while ((m = separators.exec(masked))) {
    // `2>&1` and `&>` are redirections, not separators
    if (
      m[0] === "&" &&
      (masked[m.index - 1] === ">" || masked[m.index + 1] === ">")
    )
      continue;
    push(m.index);
    from = m.index + m[0].length;
  }
  push(masked.length);
  return out;
}

/**
 * Programs whose arguments are another shell's text or another machine's
 * command: their arguments are not read with PowerShell's rules. Once the
 * shell context classifier lands (#756), its `inner` text replaces this list.
 */
const LAUNCHERS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "fish",
  "wsl",
  "cmd",
  "ssh",
  "docker",
  "podman",
  "kubectl",
  "pwsh",
  "powershell",
]);

function programName(word: string): string {
  return word
    .replace(/^["']|["']$/g, "")
    .split(/[\\/]/)
    .pop()!
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/** The PowerShell for the Unix tools a model reaches for. */
const UNIX_TOOLS: Record<string, string> = {
  grep: "Select-String -Pattern <text> [-Path <file>]",
  sed: "(Get-Content <file>) -replace '<from>','<to>', or the edit tool",
  awk: "ForEach-Object with -split",
  head: "Select-Object -First <n>",
  tail: "Select-Object -Last <n> (Get-Content -Tail <n> for a file)",
  which: "Get-Command <name>",
  touch: "New-Item -ItemType File <path>",
  wc: "Measure-Object -Line",
  printf: "Write-Output (or the -f format operator)",
  uname: "$PSVersionTable or [Environment]::OSVersion",
  xargs: "ForEach-Object",
  cut: "ForEach-Object with -split",
  tr: "the -replace operator",
};

/** Aliases that exist in PowerShell but reject the Unix flags models give them. */
const ALIAS_FLAGS: { name: RegExp; flags: RegExp; instead: string }[] = [
  // `ls -la`, `-al`, `-lah`, `-1`: short Unix flags, not `-Name` or `-Force`
  {
    name: /^ls$/,
    flags: /^-(?=[a-z1]{1,4}$)[a-z1]*[al1][a-z1]*$/,
    instead: "Get-ChildItem -Force (add -Recurse for -R)",
  },
  {
    name: /^rm$/,
    flags: /^-[rfRv]{1,3}$/,
    instead: "Remove-Item -Recurse -Force <path>",
  },
  { name: /^ps$/, flags: /^(aux|-ef|-e|-A)$/, instead: "Get-Process" },
  {
    name: /^kill$/,
    flags: /^-(\d+|[A-Z]{3,})$/,
    instead: "Stop-Process -Id <pid> -Force",
  },
];

/** PowerShell's automatic and preference variables: `$HOME` is fine, `$PATH` is not. */
const PS_AUTOMATIC = new Set([
  "home",
  "pwd",
  "pid",
  "host",
  "null",
  "true",
  "false",
  "error",
  "args",
  "input",
  "matches",
  "lastexitcode",
  "profile",
  "pshome",
  "shellid",
  "psversiontable",
  "_",
  "psitem",
  "psscriptroot",
  "pscommandpath",
  "myinvocation",
  "ofs",
  "stacktrace",
  "this",
  "executioncontext",
  "nestedpromptlevel",
  "sender",
  "event",
  "eventargs",
  "eventsubscriber",
  "iswindows",
  "islinux",
  "ismacos",
  "iscoreclr",
  "psculture",
  "psuiculture",
  "psedition",
  "consolefilename",
  "foreach",
  "switch",
  "pscmdlet",
  "psboundparameters",
  "psdebugcontext",
  "psdefaultparametervalues",
  "outputencoding",
  "maximumhistorycount",
  "psnativecommandargumentpassing",
  "psstyle",
  "pssessionconfigurationname",
  "pssessionapplicationname",
  "pssessionoption",
  "psemailserver",
  "lastexitcode",
  "enabledexperimentalfeatures",
  "psgettext",
]);

const VERSION_SEVERITY = (version: PowerShellVersion): HintSeverity =>
  version === "5.1" ? "error" : "warn";

/** `a && b` as Windows PowerShell 5.1 writes it, when the line is that simple. */
function chainSuggestion(command: string, masked: string, at: number): string {
  const generic = "a; if ($?) { b } (and a; if (-not $?) { b } for ||)";
  const lineStart = masked.lastIndexOf("\n", at) + 1;
  let lineEnd = masked.indexOf("\n", at);
  if (lineEnd < 0) lineEnd = masked.length;
  const line = masked.slice(lineStart, lineEnd);
  if (/[;{}()|]/.test(line.replace(/&&|\|\|/g, "  "))) return generic;
  const ops = line.match(/&&|\|\|/g) ?? [];
  const parts: string[] = [];
  let from = 0;
  const re = /&&|\|\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    parts.push(command.slice(lineStart + from, lineStart + m.index).trim());
    from = m.index + m[0].length;
  }
  parts.push(command.slice(lineStart + from, lineEnd).trim());
  if (parts.some((p) => !p)) return generic;
  if (ops.every((o) => o === "&&")) {
    let text = parts[parts.length - 1];
    for (let k = parts.length - 2; k >= 0; k--)
      text = `${parts[k]}; if ($?) { ${text} }`;
    return text;
  }
  if (ops.length === 1) return `${parts[0]}; if (-not $?) { ${parts[1]} }`;
  return generic;
}

type Add = (
  rule: string,
  severity: HintSeverity,
  start: number,
  end: number,
  message: string,
  suggestion: string,
) => void;

interface PsContext {
  command: string;
  m: Masked;
  version: PowerShellVersion;
  target: HintTarget;
  add: Add;
}

/** `&&`, `||` and a trailing `&`: Windows PowerShell 5.1 only. */
function psOperators({ command, m, version, add }: PsContext): void {
  if (version === "7") return;
  let op: RegExpExecArray | null;
  const chain = /&&|\|\|/g;
  while ((op = chain.exec(m.all))) {
    add(
      "ps.chain-operator",
      VERSION_SEVERITY(version),
      op.index,
      op.index + 2,
      `${op[0]} is not a statement separator in Windows PowerShell 5.1: the whole command fails to parse and nothing runs.`,
      chainSuggestion(command, m.all, op.index),
    );
  }
  const amp = /&(?![&>])/g;
  while ((op = amp.exec(m.all))) {
    const before = m.all.slice(0, op.index);
    const after = m.all.slice(op.index + 1);
    // `2>&1`, the second `&` of `&&`, and `& "x.exe"` (the call operator)
    if (/[>&]$/.test(before) || /(^|[;\n|{(])\s*$/.test(before)) continue;
    if (!/^[ \t]*(\r?\n|;|$)/.test(after)) continue;
    add(
      "ps.background-amp",
      VERSION_SEVERITY(version),
      op.index,
      op.index + 1,
      "A trailing & is not allowed in Windows PowerShell 5.1.",
      "Run it in the foreground, or Start-Job { <command> } / Start-Process for a background process.",
    );
  }
}

/** Syntax that is bash's in any PowerShell: heredocs, /dev/null, backticks, line continuation. */
function psSyntax({ command, m, add }: PsContext): void {
  const heredoc = /<<(?!<)/.exec(m.all);
  if (heredoc) {
    add(
      "ps.heredoc",
      "error",
      heredoc.index,
      heredoc.index + 2,
      "A heredoc (<<EOF) is bash; PowerShell has no such operator and rejects the command.",
      "Write the file with the edit tool, or use a here-string: @' on its own line, the text, then '@ at the start of a line.",
    );
  }
  let r: RegExpExecArray | null;
  const devNull = /(\d|&)?>>?\s*\/dev\/null/g;
  while ((r = devNull.exec(m.all))) {
    const stream = r[0][0];
    add(
      "ps.dev-null",
      "error",
      r.index,
      r.index + r[0].length,
      "/dev/null is not a path on Windows: PowerShell tries to write D:\\dev\\null and reports an error.",
      stream === "2"
        ? "2>$null"
        : stream === "&"
          ? "*>$null"
          : "> $null (or | Out-Null)",
    );
  }
  for (const [start, end] of m.unterminated) {
    if (!command.slice(start, end).includes("`")) continue;
    add(
      "ps.backtick-substitution",
      "error",
      start,
      end,
      "Backticks are PowerShell's escape character, not command substitution: here one escapes the closing quote and the string never ends.",
      "Use $(command) for command substitution.",
    );
  }
  const continuation = /\\[ \t]*\r?\n/g;
  while ((r = continuation.exec(m.all))) {
    add(
      "ps.backslash-continuation",
      "error",
      r.index,
      r.index + 1,
      "A backslash does not continue a line in PowerShell: the next line runs as its own command.",
      "Put it on one line, or end the line with a backtick (`), a pipe or an operator.",
    );
  }
}

/** Variables and subexpressions, read in double-quoted text too. */
function psVariables({ m, target, add }: PsContext): void {
  let r: RegExpExecArray | null;
  const subst = /\$\(\s*([A-Za-z][\w.-]*)/g;
  while ((r = subst.exec(m.literal))) {
    const name = r[1].toLowerCase();
    if (!UNIX_TOOLS[name] || target.unixTools === true) continue;
    add(
      "ps.unix-substitution",
      "warn",
      r.index,
      r.index + r[0].length,
      `$(...) is a PowerShell subexpression, but ${name} is a Unix tool that may not exist here.`,
      `$(${UNIX_TOOLS[name]})`,
    );
  }
  const assigned = new Set<string>();
  for (const a of m.all.matchAll(/\$([A-Za-z_]\w*)\s*=(?!=)/g)) {
    assigned.add(a[1].toLowerCase());
  }
  const variable = /\$([A-Za-z_][A-Za-z0-9_]*)(?![:\w(])/g;
  while ((r = variable.exec(m.literal))) {
    const name = r[1];
    const lower = name.toLowerCase();
    // Environment variables are written in capitals; PowerShell's own are excused
    if (name !== name.toUpperCase() || name.length < 2) continue;
    if (
      PS_AUTOMATIC.has(lower) ||
      lower.endsWith("preference") ||
      assigned.has(lower)
    )
      continue;
    add(
      "ps.bare-variable",
      "warn",
      r.index,
      r.index + r[0].length,
      `In PowerShell $${name} is an unset PowerShell variable, not the environment variable, so it expands to nothing without an error.`,
      `$env:${name}`,
    );
  }
}

type Word = Statement["words"][number];

interface StatementCase {
  first: Word;
  rest: Word[];
  /** The first word, lower case, as written. */
  bare: string;
  /** From the end of the first word to the end of the statement, as written. */
  tail: string;
  end: number;
  /** The call operator `&` comes before the first word. */
  called: boolean;
}

type Hit = [string, HintSeverity, number, number, string, string];
type StatementRule = (s: StatementCase, ctx: PsContext) => Hit | undefined;

const unquote = (text: string) => text.replace(/^["']|["']$/g, "");

/** What a statement's first word says about the shell it was written for. First match wins. */
const STATEMENT_RULES: StatementRule[] = [
  ({ first, rest, bare }) => {
    if (bare !== "export" || !rest[0] || !/^[A-Za-z_]\w*=/.test(rest[0].text))
      return undefined;
    const [k, ...v] = rest[0].text.split("=");
    return [
      "ps.export",
      "error",
      first.start,
      rest[0].end,
      "export NAME=value is bash: in PowerShell export is not a command, the variable is not set, and the line still exits 0.",
      `$env:${k} = '${unquote(v.join("="))}'`,
    ];
  },
  ({ first, rest, tail }) => {
    const prefix = /^([A-Za-z_]\w*)=(\S*)$/.exec(first.text);
    if (!prefix || !rest.length) return undefined;
    return [
      "ps.env-prefix",
      "error",
      first.start,
      first.end,
      `NAME=value before a command is bash; PowerShell reads ${first.text} as the name of a command.`,
      `$env:${prefix[1]} = '${unquote(prefix[2])}'; ${tail.trim()}`,
    ];
  },
  ({ first, rest, end }) => {
    if (first.text !== "[" && first.text !== "[[") return undefined;
    if (!rest.some((w) => /^-[a-z]$/.test(w.text))) return undefined;
    return [
      "ps.test-bracket",
      "error",
      first.start,
      end,
      "[ -d path ] is bash's test; in PowerShell [ starts a type name and the command does not parse.",
      "if (Test-Path <path>) { ... } (Test-Path -PathType Leaf for -f, Container for -d)",
    ];
  },
  ({ first, rest, tail, called }) => {
    if (called || !rest.length || !/^["']/.test(first.text)) return undefined;
    if (!/\.(exe|cmd|bat|com)["']?$/i.test(first.text)) return undefined;
    return [
      "ps.quoted-exe",
      "error",
      first.start,
      first.end,
      "A quoted program path at the start of a statement is a string to PowerShell, so the arguments after it are a parse error.",
      `& ${first.text} ${tail.trim()}`,
    ];
  },
  ({ first, rest, bare }) => {
    if (bare !== "set" || !rest[0] || !/^[-+][euxo]+$/.test(rest[0].text))
      return undefined;
    return [
      "ps.set-option",
      "warn",
      first.start,
      rest[0].end,
      `set ${rest[0].text} is bash; in PowerShell set is Set-Variable, which reports an error and the command goes on.`,
      "$ErrorActionPreference = 'Stop' to stop on cmdlet errors; check $LASTEXITCODE after native programs.",
    ];
  },
  ({ first, bare }) =>
    bare === "source"
      ? [
          "ps.source",
          "warn",
          first.start,
          first.end,
          "source is bash; PowerShell dot-sources a script with . .\\script.ps1.",
          ". <path>.ps1 (a Python venv: .venv\\Scripts\\Activate.ps1)",
        ]
      : undefined,
  ({ first, bare, tail }) =>
    bare === "where"
      ? [
          "ps.where-alias",
          "warn",
          first.start,
          first.end,
          "where is Where-Object in PowerShell: it prints nothing and exits 0.",
          `where.exe${tail}`,
        ]
      : undefined,
  ({ first, bare, tail }, { version }) =>
    (bare === "curl" || bare === "wget") && version !== "7"
      ? [
          "ps.curl-alias",
          "warn",
          first.start,
          first.end,
          `${bare} is Invoke-WebRequest in Windows PowerShell 5.1: curl's flags are rejected, and without -Uri it waits for input.`,
          `curl.exe${tail}`,
        ]
      : undefined,
  ({ first, rest, bare, end }) => {
    const alias = ALIAS_FLAGS.find((a) => a.name.test(bare));
    const flag = alias && rest.find((w) => alias.flags.test(w.text));
    if (!alias || !flag) return undefined;
    return [
      "ps.alias-flags",
      "error",
      first.start,
      end,
      `${bare} is a PowerShell alias here and rejects ${flag.text} ("A parameter cannot be found").`,
      alias.instead,
    ];
  },
  ({ first, bare }, { target }) =>
    UNIX_TOOLS[bare] && target.unixTools !== true
      ? [
          "ps.unix-tool",
          target.unixTools === false ? "error" : "warn",
          first.start,
          first.end,
          `${bare} is a Unix tool; it exists in Windows PowerShell only when Git for Windows' usr\\bin is on PATH.`,
          UNIX_TOOLS[bare],
        ]
      : undefined,
];

/** Arguments a model writes for bash: JSON in single quotes, `/c/` and `/mnt/c/` paths. */
function psArguments(rest: Word[], { version, add }: PsContext): void {
  for (const w of rest) {
    if (/^'\{.*".*\}'$/.test(w.text) && version !== "7") {
      add(
        "ps.json-argument",
        "warn",
        w.start,
        w.end,
        "Windows PowerShell 5.1 drops the double quotes inside an argument to a native program: '{\"a\":1}' arrives as {a:1}.",
        `${w.text.replace(/"/g, '\\"')} (or --% before the arguments)`,
      );
    }
    if (/^\/(mnt\/)?[a-z]\/[^/]/i.test(w.text)) {
      add(
        "ps.posix-path",
        "warn",
        w.start,
        w.end,
        `${w.text} is a Git Bash or WSL path; PowerShell reads / as the root of the current drive.`,
        w.text
          .replace(
            /^\/(?:mnt\/)?([a-z])\//i,
            (_, d: string) => `${d.toUpperCase()}:\\`,
          )
          .replace(/\//g, "\\"),
      );
    }
  }
}

function powershellHints(
  command: string,
  target: HintTarget,
  hints: ShellHint[],
): void {
  const ctx: PsContext = {
    command,
    m: mask(command, "powershell"),
    version: target.version ?? "5.1",
    target,
    add: (rule, severity, start, end, message, suggestion) =>
      hints.push({ rule, severity, start, end, message, suggestion }),
  };
  psOperators(ctx);
  psSyntax(ctx);
  psVariables(ctx);
  for (const s of statements(command, ctx.m.all, "powershell")) {
    const [first, ...rest] = s.words;
    const end = s.words[s.words.length - 1].end;
    const statement: StatementCase = {
      first,
      rest,
      bare: first.text.toLowerCase(),
      tail: command.slice(first.end, end),
      end,
      called: /(^|[^&])&\s*$/.test(ctx.m.all.slice(0, first.start)),
    };
    for (const rule of STATEMENT_RULES) {
      const hit = rule(statement, ctx);
      if (hit) {
        ctx.add(...hit);
        break;
      }
    }
    if (!LAUNCHERS.has(programName(first.text))) psArguments(rest, ctx);
  }
}

function posixHints(command: string, hints: ShellHint[]): void {
  const m = mask(command, "posix");
  let r: RegExpExecArray | null;
  const env = /\$env:([A-Za-z_]\w*)/g;
  while ((r = env.exec(m.literal))) {
    hints.push({
      rule: "sh.ps-env",
      severity: "warn",
      start: r.index,
      end: r.index + r[0].length,
      message: `$env:${r[1]} is PowerShell; bash reads it as $env followed by :${r[1]}.`,
      suggestion: `$${r[1]}`,
    });
  }
  const here = /(^|[\s|=(])@['"]\r?\n/g;
  while ((r = here.exec(command))) {
    hints.push({
      rule: "sh.here-string",
      severity: "error",
      start: r.index + r[1].length,
      end: r.index + r[0].length,
      message:
        "@' ... '@ is a PowerShell here-string; bash runs it as a command name.",
      suggestion: "cat <<'EOF' > <file> ... EOF, or the edit tool",
    });
  }
  for (const s of statements(command, m.all, "posix")) {
    const first = s.words[0];
    if (/^[A-Z][a-z]+-[A-Z][A-Za-z]+$/.test(first.text)) {
      hints.push({
        rule: "sh.cmdlet",
        severity: "warn",
        start: first.start,
        end: first.end,
        message: `${first.text} is a PowerShell cmdlet; bash has no such command.`,
        suggestion:
          "The Unix tool (Get-ChildItem is ls, Get-Content is cat, Select-String is grep), or powershell.exe -Command '...'",
      });
    }
    for (const w of s.words) {
      if (/^[A-Za-z]:\\/.test(w.text)) {
        hints.push({
          rule: "sh.backslash-path",
          severity: "warn",
          start: w.start,
          end: w.end,
          message: `In bash the backslashes in ${w.text} are escapes and disappear.`,
          suggestion: `'${w.text}' quoted, or ${w.text.replace(/^([A-Za-z]):\\/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/")} in WSL`,
        });
      }
    }
  }
}

function cmdHints(command: string, hints: ShellHint[]): void {
  const m = mask(command, "cmd");
  let r: RegExpExecArray | null;
  const semi = /;/g;
  while ((r = semi.exec(m.all))) {
    hints.push({
      rule: "cmd.semicolon",
      severity: "warn",
      start: r.index,
      end: r.index + 1,
      message: "; does not separate commands in cmd: it is passed on as text.",
      suggestion: "& (always) or && (when the first succeeded)",
    });
  }
  const single = /(^|\s)'[^']*\s[^']*'/g;
  while ((r = single.exec(m.all))) {
    hints.push({
      rule: "cmd.single-quote",
      severity: "warn",
      start: r.index + r[1].length,
      end: r.index + r[0].length,
      message:
        "Single quotes do not quote in cmd: the words and any & inside are read as they are.",
      suggestion: "Double quotes",
    });
  }
  const dollar = /\$(?:env:)?([A-Za-z_]\w*)/g;
  while ((r = dollar.exec(m.all))) {
    hints.push({
      rule: "cmd.dollar-var",
      severity: "warn",
      start: r.index,
      end: r.index + r[0].length,
      message: `${r[0]} is not a variable in cmd; it is printed as written.`,
      suggestion: `%${r[1]}%`,
    });
  }
}

/**
 * Everything in `command` that reads as written for another shell than
 * `target`, in the order it appears. Never throws; an empty list means
 * nothing was found, not that the command is right.
 */
export function detectShellHints(
  command: string,
  target: HintTarget,
): ShellHint[] {
  const hints: ShellHint[] = [];
  try {
    if (target.family === "powershell") powershellHints(command, target, hints);
    else if (target.family === "posix") posixHints(command, hints);
    else cmdHints(command, hints);
  } catch (e) {
    console.debug("Shell hints failed", e);
  }
  return hints.sort(
    (a, b) => a.start - b.start || a.rule.localeCompare(b.rule),
  );
}
