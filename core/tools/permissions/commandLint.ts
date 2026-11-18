import type { ShellKind } from "../../util/shell";
import { isPosixShell } from "../../util/shell";
import { detectCommandShell, familyOf, mismatchedShell } from "./detectShell";
import { detectShellHints, shellHintTarget } from "./shellHints";
import { bashSyntaxProblem } from "./treeSitterBash";

/**
 * A lint for a terminal command, read before it runs (plans/command-lint.md).
 * It is not a policy decision: it finds mistakes in how the command is
 * written, the ones the shell only reports after the call has run, or never
 * reports because the command still succeeds with the wrong text. The
 * recurring one is a file written through a heredoc, where quotes, `$` and
 * backslashes arrive changed.
 *
 * `error` findings are certain: the command cannot do what it says (a syntax
 * error, a heredoc that never ends, bash syntax in PowerShell). `warn`
 * findings are likely mistakes that a person may still mean.
 */
export type LintSeverity = "error" | "warn";

export interface LintFinding {
  /** Stable code, so a test or a setting can name it. */
  code: string;
  severity: LintSeverity;
  /** What is wrong, in one sentence. */
  message: string;
  /** What to do instead. */
  advice: string;
  /** 1-based line of the command the finding is about, when known. */
  line?: number;
}

interface Heredoc {
  /** Line (0-based) holding the `<<`. */
  line: number;
  delimiter: string;
  /** A quoted delimiter (`'EOF'`, `"EOF"`, `\EOF`) makes the body literal. */
  quoted: boolean;
  /** `<<-` strips leading tabs from the body and the end line. */
  stripTabs: boolean;
  body: string[];
  /** The line (0-based) that ends it, or undefined when none does. */
  endLine: number | undefined;
  /** The text of the line that holds the `<<`. */
  header: string;
}

const HEREDOC_START =
  /<<(-?)\s*(\\?)(?:'([^'\n]+)'|"([^"\n]+)"|([A-Za-z_][\w.-]*))/g;

/** Finds the heredocs of a POSIX command, line by line. */
export function findHeredocs(command: string): Heredoc[] {
  const lines = command.split(/\r?\n/);
  const found: Heredoc[] = [];
  let skipUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i <= skipUntil) continue;
    const text = lines[i];
    // `<<<` is a here-string, not a heredoc
    const withoutHereStrings = text.replace(/<<</g, "   ");
    HEREDOC_START.lastIndex = 0;
    const m = HEREDOC_START.exec(withoutHereStrings);
    if (!m || insideQuotes(text, m.index)) continue;
    const delimiter = m[3] ?? m[4] ?? m[5];
    const stripTabs = m[1] === "-";
    let endLine: number | undefined;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = stripTabs ? lines[j].replace(/^\t+/, "") : lines[j];
      if (candidate === delimiter) {
        endLine = j;
        break;
      }
      body.push(lines[j]);
    }
    found.push({
      line: i,
      delimiter,
      quoted: m[2] === "\\" || m[3] !== undefined || m[4] !== undefined,
      stripTabs,
      body,
      endLine,
      header: text,
    });
    skipUntil = endLine ?? lines.length;
  }
  return found;
}

/** Whether `index` of `text` is inside a single or double quoted string. */
function insideQuotes(text: string, index: number): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (c === "\\" && !single) {
      i++;
    } else if (c === "'" && !double) {
      single = !single;
    } else if (c === '"' && !single) {
      double = !double;
    }
  }
  return single || double;
}

/** `> file` or `>> file` on a line, and not a discard or a descriptor copy. */
function fileRedirectTarget(line: string): string | undefined {
  const re = /(?:^|[^<>&\d])(?:\d?>>?|&>>?)\s*(?!&)([^\s;|&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (insideQuotes(line, m.index + 1)) continue;
    const target = m[1];
    if (target !== "/dev/null" && target !== "&1" && target !== "&2") {
      return target;
    }
  }
  return undefined;
}

function teeTarget(line: string): string | undefined {
  const m = /\btee\s+(?:-[a-z]+\s+)*([^\s;|&<>-][^\s;|&<>]*)/.exec(line);
  return m?.[1];
}

const WRITE_ADVICE =
  "Write files with the edit or create-file tool: the content then arrives exactly as written. If this has to go through the shell, quote the delimiter (<<'EOF'), keep the body free of the delimiter line, and check the file afterwards.";

function lintHeredocs(command: string, findings: LintFinding[]): void {
  for (const h of findHeredocs(command)) {
    const line = h.line + 1;
    if (h.endLine === undefined) {
      findings.push({
        code: "CL020",
        severity: "error",
        line,
        message: `The heredoc started on line ${line} never ends: no line is exactly "${h.delimiter}".`,
        advice: `End it with a line that holds only ${h.delimiter} at the start (no indentation, no trailing text), or use <<-${h.delimiter} with tabs. A closing line with spaces before it, or the delimiter followed by more text, does not close it.`,
      });
      continue;
    }
    const target = fileRedirectTarget(h.header) ?? teeTarget(h.header);
    const closeLike = h.body.findIndex(
      (b) => b.trim() === h.delimiter && b !== h.delimiter,
    );
    if (closeLike >= 0) {
      findings.push({
        code: "CL021",
        severity: "error",
        line: h.line + 2 + closeLike,
        message: `Line ${h.line + 2 + closeLike} looks like the end of the heredoc but is indented or padded, so the shell reads it as content.`,
        advice: `Put ${h.delimiter} alone at the start of its line (SC1039).`,
      });
    }
    const hasExpansion = h.body.some((b) => /[$`\\]/.test(b));
    if (!h.quoted && hasExpansion) {
      findings.push({
        code: "CL022",
        severity: "warn",
        line,
        message:
          "The delimiter is unquoted, so the shell expands $, backticks and backslashes in the body before it is used.",
        advice: `Quote the delimiter (<<'${h.delimiter}') when the text is meant literally. Today a $VAR, $(cmd) or backslash sequence in it is replaced or removed.`,
      });
    }
    if (target) {
      findings.push({
        code: "CL010",
        severity: "warn",
        line,
        message: `A heredoc writes ${target}: file contents sent through the shell are where quotes, backslashes and $ get changed.`,
        advice: WRITE_ADVICE,
      });
    }
  }
}

/** echo or printf with a body that writes a file, and a body that spans lines. */
function lintInlineWrites(command: string, findings: LintFinding[]): void {
  const lines = command.split(/\r?\n/);
  const heredocLines = new Set(findHeredocs(command).map((h) => h.line));
  for (let i = 0; i < lines.length; i++) {
    if (heredocLines.has(i)) continue;
    const text = lines[i];
    const echoWrite =
      /^\s*(echo|printf)\b/.test(text) && fileRedirectTarget(text);
    if (echoWrite) {
      const body = text.slice(text.search(/\S/));
      if (/\\[nt"'\\]/.test(body) || /\\\$/.test(body)) {
        findings.push({
          code: "CL011",
          severity: "warn",
          line: i + 1,
          message: `${text.trim().split(/\s/)[0]} writes ${echoWrite} with backslash escapes in the text, which echo and printf each handle differently.`,
          advice: WRITE_ADVICE,
        });
      }
    }
    if (/^\s*echo\s+(?!-[a-zA-Z]*e)(["'])[^"']*\\n/.test(text)) {
      findings.push({
        code: "CL012",
        severity: "warn",
        line: i + 1,
        message:
          "echo without -e prints \\n as two characters in bash (it varies by shell), not a newline (SC2028).",
        advice:
          "Use printf '%s\\n' for lines, or write the file with the edit tool.",
      });
    }
  }
}

/** An inline script (-c, -e) whose quoting the shell reads first. */
function lintInlineScripts(command: string, findings: LintFinding[]): void {
  const re =
    /\b(python3?|node|perl|ruby|php|pwsh|powershell)(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*(-c|-e|-Command|-command)\s+"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    const body = m[3];
    if (/\\"|\$|`/.test(body) && body.length > 40) {
      findings.push({
        code: "CL030",
        severity: "warn",
        line: command.slice(0, m.index).split("\n").length,
        message: `A ${m[1]} script in double quotes: the shell expands $ and backticks in it and reads \\" itself before ${m[1]} sees the text.`,
        advice:
          "Put the script in a file with the create-file tool and run it, or use single quotes (no ' inside) or a quoted heredoc (python - <<'PY').",
      });
    }
  }
}

/** Bash syntax in PowerShell, and the other way round. */
function lintForeignSyntax(
  command: string,
  shell: ShellKind,
  findings: LintFinding[],
): void {
  if (shell === "powershell") {
    if (/<<-?\s*['"\\]?[A-Za-z_]/.test(command.replace(/<<</g, ""))) {
      findings.push({
        code: "CL001",
        severity: "error",
        message:
          "This is a bash heredoc (<<EOF) but the command runs in PowerShell, which has no heredoc operator.",
        advice:
          "Use the edit or create-file tool, or a PowerShell here-string: @' on its own line, the text, then '@ alone at the start of a line.",
      });
    }
    if (/^\s*export\s+\w+=/m.test(command)) {
      findings.push({
        code: "CL002",
        severity: "error",
        message:
          "export NAME=value is bash; PowerShell sets a variable with $env:NAME = 'value'.",
        advice: "Use $env:NAME = 'value' before the command, in the same call.",
      });
    }
    if (
      /^\s*[A-Za-z_]\w*=\S+\s+\S/m.test(command) &&
      !/\$/.test(command.split("=")[0])
    ) {
      findings.push({
        code: "CL003",
        severity: "error",
        message:
          "NAME=value command is bash; in PowerShell it is read as a command called NAME=value.",
        advice: "Set $env:NAME = 'value'; then run the command.",
      });
    }
  } else if (isPosixShell(shell)) {
    if (/\$env:\w+/.test(command) || /^\s*Get-[A-Z]\w+/m.test(command)) {
      findings.push({
        code: "CL004",
        severity: "warn",
        message:
          "This looks like PowerShell ($env:NAME or a Get- cmdlet) but the command runs in a POSIX shell.",
        advice:
          "Write it for the shell that runs it, or start powershell -Command explicitly.",
      });
    }
  }
}

/** The PowerShell for the Unix utilities a command most often reaches for. */
const POWERSHELL_FOR: [RegExp, string][] = [
  [/\bls\s+-[A-Za-z]+/, "Get-ChildItem -Force (-Name for names only)"],
  [/\brm\s+-[A-Za-z]*[rf]/, "Remove-Item -Recurse -Force <path>"],
  [/\bcat\s+\S/, "Get-Content <path>"],
  [/\bgrep\s/, "Select-String -Pattern <text> -Path <path>"],
  [/\bwhich\s/, "Get-Command <name>"],
  [/\btouch\s/, "New-Item -ItemType File <path>"],
  [/\bexport\s+\w+=/, "$env:NAME = 'value'"],
  [/\bmkdir\s+-p\b/, "New-Item -ItemType Directory -Force <path>"],
];

/** The cmd for each, written for PowerShell. */
const POWERSHELL_FOR_CMD: [RegExp, string][] = [
  [/%(\w+)%/, "$env:NAME instead of %NAME%"],
  [/\bdir\s+\/[bsa]/i, "Get-ChildItem -Name / -Recurse / -Force"],
  [/\bif\s+(?:not\s+)?exist\b/i, "if (Test-Path <path>) { ... }"],
  [/^\s*set\s+"?\w+=/im, "$env:NAME = 'value'"],
];

/**
 * Text written for another shell than the one that runs it: bash on a
 * PowerShell executor and the other way round, from what the text says about
 * itself (detectShell.ts). Skipped when a specific finding above says it.
 */
function lintDialect(
  command: string,
  shell: ShellKind,
  findings: LintFinding[],
): void {
  if (findings.some((f) => /^CL00[1-4]$/.test(f.code))) return;
  const family = familyOf(shell);
  if (!family) return;
  const detection = detectCommandShell(command);
  if (shell === "powershell") {
    // The shell-hint detector already names these, and a certain one is
    // refused before the approval card. Repeating them here would be a
    // second gate with a different sentence.
    const target = shellHintTarget(shell);
    const hinted = new Set(
      target ? detectShellHints(command, target).map((h) => h.rule) : [],
    );
    if (
      !hinted.has("ps.chain-operator") &&
      /&&|\|\|/.test(command) &&
      !/['"][^'"]*(?:&&|\|\|)[^'"]*['"]/.test(command)
    ) {
      findings.push({
        code: "CL040",
        severity: "warn",
        message:
          "&& and || chain commands in bash and PowerShell 7, but Windows PowerShell 5.1 reports a syntax error.",
        advice:
          "Run the steps with ; , or use `a; if ($?) { b }` when b depends on a succeeding.",
      });
    }
    if (!hinted.has("ps.dev-null") && /\d?>\s*\/dev\/null/.test(command)) {
      findings.push({
        code: "CL041",
        severity: "warn",
        message:
          "2>/dev/null is a bash redirect; on Windows PowerShell /dev/null is not a path.",
        advice: "Use 2>$null (or > $null).",
      });
    }
  }
  if (!mismatchedShell(detection, shell)) return;
  const wrote = detection.likely[0];
  const hint = detection.evidence.slice(0, 2).join(", ");
  if (shell === "powershell" && familyOf(wrote) === "posix") {
    const fix = POWERSHELL_FOR.filter(([re]) => re.test(command)).map(
      ([, to]) => to,
    );
    findings.push({
      code: "CL042",
      severity: "warn",
      message: `This reads as ${wrote} (${hint}) but the command runs in PowerShell.`,
      advice: fix.length
        ? `In PowerShell: ${fix.join("; ")}.`
        : "Write it in PowerShell, or run it with bash -c if bash is installed.",
    });
  } else if (shell === "powershell" && wrote === "cmd") {
    const fix = POWERSHELL_FOR_CMD.filter(([re]) => re.test(command)).map(
      ([, to]) => to,
    );
    findings.push({
      code: "CL043",
      severity: "warn",
      message: `This reads as cmd (${hint}) but the command runs in PowerShell.`,
      advice: fix.length
        ? `In PowerShell: ${fix.join("; ")}.`
        : "Write it in PowerShell, or start cmd /c explicitly.",
    });
  } else if (family === "posix" && familyOf(wrote) !== "posix") {
    findings.push({
      code: "CL044",
      severity: "warn",
      message: `This reads as ${wrote} (${hint}) but the command runs in ${shell}.`,
      advice:
        wrote === "powershell"
          ? "In bash: use $NAME or export NAME=value instead of $env:NAME, and the Unix tool for each cmdlet (Get-ChildItem is ls, Get-Content is cat, Select-String is grep)."
          : "Write it for bash, or start cmd /c explicitly.",
    });
  } else if (shell === "cmd") {
    findings.push({
      code: "CL045",
      severity: "warn",
      message: `This reads as ${wrote} (${hint}) but the command runs in cmd.`,
      advice: "Write it for cmd, or start powershell -Command explicitly.",
    });
  }
}

/**
 * Everything wrong with writing `command` for `shell`. Never throws; an
 * empty list means nothing was found, not that the command is right.
 */
export function lintCommand(command: string, shell: ShellKind): LintFinding[] {
  const findings: LintFinding[] = [];
  try {
    lintForeignSyntax(command, shell, findings);
    lintDialect(command, shell, findings);
    if (isPosixShell(shell)) {
      lintHeredocs(command, findings);
      lintInlineWrites(command, findings);
      lintInlineScripts(command, findings);
      // A heredoc already reported as unterminated is a syntax error too
      if (!findings.some((f) => f.code === "CL020")) {
        const problem = bashSyntaxProblem(command);
        if (problem) {
          findings.push({
            code: "CL000",
            severity: "error",
            line: problem.line,
            message: `The shell cannot parse this command: ${problem.what} at line ${problem.line}, column ${problem.column}.`,
            advice:
              "Check quotes, brackets and the end of any heredoc. A quote inside a quoted string needs the other kind of quote or an escape.",
          });
        }
      }
    }
  } catch (e) {
    console.debug("Command lint failed", e);
  }
  return findings.sort(
    (a, b) =>
      Number(b.severity === "error") - Number(a.severity === "error") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** The findings as the text the agent reads in place of a result. */
export function formatLint(findings: LintFinding[]): string {
  const hard = findings.some((f) => f.severity === "error");
  const lines = findings.map(
    (f) =>
      `- ${f.code}${f.line ? ` (line ${f.line})` : ""}: ${f.message} ${f.advice}`,
  );
  return [
    hard
      ? "The command was not run: it has a mistake the shell would only report after running."
      : "The command was not run yet: it has a pattern that often goes wrong.",
    ...lines,
    hard
      ? "Fix it and call again."
      : "Fix it, or call again with exactly the same command to run it as written.",
  ].join("\n");
}

/** Warned commands, by text: the same command sent again runs as written. */
const warned = new Set<string>();
const WARNED_LIMIT = 200;

/**
 * What stands between the agent and running `command`: undefined to run it,
 * or the message to return in place of a result. A mistake that is certain
 * always stops the call. A likely mistake stops it once; sending the exact
 * same command again is the confirmation. Off with CONTINUE_COMMAND_LINT=off.
 */
export function commandLintGate(
  command: string,
  shell: ShellKind,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.CONTINUE_COMMAND_LINT === "off") return undefined;
  const findings = lintCommand(command, shell);
  if (findings.length === 0) return undefined;
  if (!findings.some((f) => f.severity === "error")) {
    if (warned.has(command)) return undefined;
    if (warned.size >= WARNED_LIMIT) warned.clear();
    warned.add(command);
  }
  return formatLint(findings);
}

/** For tests: forget what was warned. */
export function resetCommandLintGate(): void {
  warned.clear();
}
