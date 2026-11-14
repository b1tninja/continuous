// The arms of the env-shell-tasks experiment: what the model is told about
// its host, and what the harness does after a failing or foreign command.
//
//   A0  nothing about the environment
//   A1  what the CLI says today (copied, see below)
//   A1i what the IDE tool says today (before #765)
//   A2  one line: OS and shell
//   A3  the guidance text per shell ("Environment block v2")
//   A4  A3 plus a corrective hint appended to the result of a failed command
//   A5  A3 plus a pre-flight reject: a command the shell's parser cannot read
//       is not run, and the reject text is the result
//   A6  A3 with the host forced to bash in WSL
//   A7  control: the A3 text for the WRONG shell (tests that the model reads
//       the block at all, and what a stale block costs)
//
// The A3 text below is a PLACEHOLDER written for this harness. It is not the
// product text: the Environment block v2 is drafted in plans/research on the
// branches research-env-state-peers and research-env-windows-wsl. When that
// text lands, replace GUIDANCE and keep the arm ids, so old results stay
// comparable by the `guidanceSha` each record carries.
import { createHash } from "node:crypto";
import { dialectSignals } from "./classify.mjs";

export const BASE_SYSTEM =
  "You are a coding agent. You have one tool, run_command, which runs a command in the current directory and returns its exit code and output. Complete the task, then reply with one short sentence. Do not ask questions.";

export const TOOL = (description) => ({
  type: "function",
  function: {
    name: "run_command",
    description,
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", description: "The command to run." },
      },
    },
  },
});

export const BASE_TOOL_DESCRIPTION = "Run a command in the current directory.";

// What the product says today, in the two surfaces. Sources (origin/main, read
// 2026-11-12):
//   CLI  extensions/cli/src/systemMessage.ts (the <env> block) and
//        extensions/cli/src/tools/runTerminalCommand.ts (describeShell, in the
//        tool description: it already says Windows PowerShell 5.1 and "not &&")
//   IDE  core/tools/definitions/runTerminalCommand.ts (PLATFORM_INFO: only
//        "optimized for win32 and x64 and shell powershell.exe"; #765 changes it)
// Copied, not imported, so the lab keeps no product dependency; a drift test
// is a ROADMAP row (EV85), not part of this change.
function cliText(host, cwd) {
  const wsl = host.shell === "wsl";
  const shellSentence =
    host.shell === "powershell"
      ? "Runs in Windows PowerShell 5.1 (powershell.exe) on Windows: chain commands with ; or a newline, not &&, and use PowerShell cmdlets and syntax."
      : wsl
        ? "Runs in bash as a login shell inside WSL, started from the workspace folder (a Windows drive appears as /mnt/c): use bash syntax and Linux paths."
        : "Runs in bash as a login shell on linux.";
  const platform = host.shell === "powershell" ? "win32" : "linux";
  return {
    system: `Here is useful information about the environment you are running in:
<env>
Working directory: ${cwd}
Is directory a git repo: ${host.git ?? false}
Platform: ${platform}
</env>`,
    tool: `Executes a terminal command and returns the output. ${shellSentence}
Secrets in the host environment are not passed to commands; the person can allow a name in terminal.passEnv.

Commands are automatically executed from the current working directory (${cwd}), so there's no need to change directories with 'cd' commands.`,
  };
}

function ideText(host) {
  const win = host.shell === "powershell";
  return {
    system: "",
    tool: `Run a terminal command in the current directory.
The shell is not stateful and will not remember any previous commands. Choose terminal commands and scripts optimized for ${win ? "win32" : "linux"} and x64 and shell ${win ? "powershell.exe" : "/bin/bash"}.`,
  };
}

const MINIMAL = {
  powershell:
    "Host: Windows 11, shell: Windows PowerShell 5.1 (powershell.exe -Command).",
  pwsh: "Host: Windows 11, shell: PowerShell 7 (pwsh -Command).",
  cmd: "Host: Windows 11, shell: cmd.exe (cmd /c).",
  bash: "Host: a POSIX system, shell: bash (bash -c).",
  wsl: "Host: Linux (WSL 2 on Windows), shell: bash (bash -lc).",
};

// PLACEHOLDER guidance, one block per shell. Short, factual, imperative, and
// checked against Windows PowerShell 5.1 and Git for Windows bash on the
// review machine where marked (see the report, section 4).
export const GUIDANCE = {
  powershell: [
    "<environment>",
    "OS: Windows 11. Shell: Windows PowerShell 5.1, started fresh for every command (no state carries over; working directory resets).",
    "- Chain with `;`. `&&` and `||` are a parse error in 5.1. To run B only after A succeeds: `A; if ($?) { B }`.",
    "- Environment variables: `$env:NAME` (read) and `$env:NAME = 'x'` (set for this command). `$NAME`, `%NAME%` and `NAME=x cmd` do not work.",
    "- `ls`, `cat`, `rm`, `cp`, `curl` are PowerShell aliases with PowerShell parameters: `ls -la`, `rm -rf` and `curl -s` fail. Use Get-ChildItem, Remove-Item -Recurse -Force, `curl.exe`, or node and git, which behave the same everywhere.",
    "- grep, sed, awk, head, tail, wc and touch exist only if Git for Windows or similar put them on PATH: check with Get-Command before relying on them, or use Select-String, Select-Object -First, Measure-Object and New-Item.",
    "- `>` and `Out-File` write UTF-16 in 5.1, and Set-Content -Encoding UTF8 adds a byte order mark. To write a file as plain UTF-8 text use [System.IO.File]::WriteAllText(path, text) (no BOM), or node.",
    "- Quote a path with spaces. `/dev/null` is `$null`. A bash heredoc is a here-string: @'...'@ on its own lines.",
    "- A command that waits for input or never exits will time out: pass non-interactive flags, and start servers with Start-Process.",
    "</environment>",
  ].join("\n"),
  pwsh: [
    "<environment>",
    "OS: Windows 11. Shell: PowerShell 7 (pwsh), started fresh for every command.",
    "- `&&` and `||` work. Environment variables are `$env:NAME`; `$NAME` and `%NAME%` do not read them.",
    "- `ls`, `cat`, `rm`, `cp` are PowerShell aliases with PowerShell parameters; `curl` is the real curl only if curl.exe is called by name.",
    "- Files are written as UTF-8 without a byte order mark by default.",
    "</environment>",
  ].join("\n"),
  cmd: [
    "<environment>",
    "OS: Windows 11. Shell: cmd.exe, started fresh for every command.",
    "- Chain with `&&` and `||`; `&` runs the next command regardless.",
    "- Environment variables: `%NAME%`. `$NAME` and `export` do not work. Use double quotes only; single quotes are literal.",
    "- Built-ins are dir, type, copy, del, mkdir, findstr. There is no ls, cat, grep, sed, head.",
    "</environment>",
  ].join("\n"),
  bash: [
    "<environment>",
    "OS: Linux or macOS-like. Shell: bash, started fresh for every command (no state carries over).",
    "- Chain with `&&`; environment variables are `$NAME`; heredocs are fine.",
    "- Use forward slashes. Do not run commands that wait for input.",
    "</environment>",
  ].join("\n"),
  wsl: [
    "<environment>",
    "OS: Linux (WSL 2 on Windows 11). Shell: bash -lc, started fresh for every command.",
    "- Chain with `&&`; environment variables are `$NAME`.",
    "- Windows drives are under /mnt/c, /mnt/d. Work in the current directory with relative paths; when you must write an absolute path, write the Linux form.",
    "- Do not call powershell.exe or cmd.exe for work that bash does.",
    "</environment>",
  ].join("\n"),
};

const ADVICE = {
  "parse-bashism": {
    powershell:
      "Windows PowerShell 5.1 does not read `&&`, `||`, `<<`, `export`, `VAR=x cmd` or `[[ ]]`. Chain with `;` (and `if ($?) { ... }` when the second step depends on the first), set variables with `$env:NAME = 'x'`, and use @'...'@ for a heredoc.",
    cmd: "cmd.exe does not read heredocs, `export` or `VAR=x cmd`. Use `set NAME=x && cmd`.",
  },
  "env-form": {
    powershell:
      "In PowerShell an environment variable is `$env:NAME`, not `$NAME` or `%NAME%`.",
    cmd: "In cmd an environment variable is `%NAME%`.",
    bash: "In bash an environment variable is `$NAME`, not `$env:NAME` or `%NAME%`.",
    wsl: "In bash an environment variable is `$NAME`, not `$env:NAME` or `%NAME%`.",
  },
  "path-form": {
    powershell:
      "This is Windows: use `C:\\dir\\file` or relative paths, not /c/..., /mnt/c/..., /tmp or /dev/null (`$null`).",
    cmd: "This is Windows: use `C:\\dir\\file` or relative paths, not /c/... or /dev/null (`nul`).",
    bash: "Use forward slashes in paths.",
    wsl: "This is WSL: Windows drives are /mnt/c and /mnt/d; use relative paths where you can.",
  },
  "alias-flags": {
    powershell:
      "In PowerShell `ls`, `rm`, `cp`, `cat`, `curl`, `sort`, `mkdir` are aliases of cmdlets and do not take Unix flags. Use Get-ChildItem, Remove-Item -Recurse -Force, Copy-Item -Recurse, `curl.exe`, or node and git.",
  },
  "tool-missing": {
    powershell:
      "That Unix tool is not installed here. PowerShell has Select-String (grep), Select-Object -First/-Last (head/tail), Measure-Object (wc), New-Item (touch), Get-Command (which); node and git work as usual.",
    cmd: "That Unix tool is not installed here. cmd has findstr (grep), type (cat), dir; node and git work as usual.",
  },
  "foreign-syntax": {
    bash: "This shell is bash, not PowerShell or cmd: use ls, cat, grep, `$NAME`, `&&`.",
    wsl: "This shell is bash in WSL, not PowerShell or cmd: use ls, cat, grep, `$NAME`, `&&`.",
  },
  quoting: {
    powershell:
      "Check the quotes: use single quotes for literal text, and double a single quote inside it ('it''s'). Inside double quotes escape with a backtick, not a backslash.",
    cmd: "Check the quotes: only double quotes quote in cmd.",
    bash: "Check the quotes: close every quote, and escape a single quote inside single quotes as '\\''.",
    wsl: "Check the quotes: close every quote, and escape a single quote inside single quotes as '\\''.",
  },
  hang: {
    powershell:
      "The command did not return and was stopped. Pass non-interactive flags (git commit -m, --yes), and start long-running programs with Start-Process.",
    cmd: "The command did not return and was stopped. Pass non-interactive flags, and start long-running programs with `start /b`.",
    bash: "The command did not return and was stopped. Pass non-interactive flags, and run long-running programs with `&` and redirected output.",
    wsl: "The command did not return and was stopped. Pass non-interactive flags, and run long-running programs with `&` and redirected output.",
  },
};

export const shellLabel = (s) =>
  ({
    powershell: "Windows PowerShell 5.1",
    pwsh: "PowerShell 7",
    cmd: "cmd.exe",
    bash: "bash",
    wsl: "bash in WSL",
  })[s] ?? s;

/** The corrective text for a classified failure on `shell`, or null. */
export function adviceFor(cls, shell) {
  return ADVICE[cls]?.[shell] ?? null;
}

/**
 * The hint appended to a failed command's result in arm A4. Only dialect
 * classes, hang and quoting get one: a program's own error is the model's to
 * read. One short paragraph, naming the shell, never repeated text.
 */
export function hintFor(outcome, shell) {
  if (!outcome.failed || outcome.cls === "other") return null;
  const advice = adviceFor(outcome.cls, shell);
  if (!advice) return null;
  return `Hint: this host's shell is ${shellLabel(shell)}. ${advice}`;
}

/**
 * The pre-flight reject for arm A5: a command with a CERTAIN signal (the
 * shell's own parser rejects it) is not run. Returns { reject, text } or null.
 */
export function preflight(command, shell) {
  const certain = dialectSignals(command, shell).find((s) => s.certain);
  if (!certain) return null;
  const advice = adviceFor(certain.cls, shell) ?? "";
  return {
    code: certain.code,
    text: `Not run: the text contains ${certain.says}, which ${shellLabel(shell)} cannot read. ${advice}`.trim(),
  };
}

export const WRONG_SHELL = {
  powershell: "bash",
  pwsh: "bash",
  cmd: "bash",
  bash: "powershell",
  wsl: "powershell",
};

/**
 * An arm's setup for one run: { system, toolDescription, preflight?, hint?,
 * shell (the host that runs the commands) }. `host.shell` is where commands
 * run; arm A6 replaces it with wsl.
 */
export function buildArm(armId, host, cwd) {
  const shell = armId === "A6" ? "wsl" : host.shell;
  let system = BASE_SYSTEM;
  let toolDescription = BASE_TOOL_DESCRIPTION;
  let guidanceKey = null;
  let preflightOn = false;
  let hintOn = false;
  switch (armId) {
    case "A0":
      break;
    case "A1": {
      const c = cliText(host, cwd);
      system += `\n${c.system}`;
      toolDescription = c.tool;
      break;
    }
    case "A1i":
      toolDescription = ideText(host).tool;
      break;
    case "A2":
      system += `\n${MINIMAL[shell]}`;
      break;
    case "A3":
    case "A4":
    case "A5":
    case "A6":
      guidanceKey = shell;
      system += `\n${GUIDANCE[shell]}`;
      hintOn = armId === "A4";
      preflightOn = armId === "A5";
      break;
    case "A7":
      guidanceKey = WRONG_SHELL[shell];
      system += `\n${GUIDANCE[guidanceKey]}`;
      break;
    default:
      throw new Error(`unknown arm ${armId}`);
  }
  const guidanceSha = guidanceKey
    ? createHash("sha256")
        .update(GUIDANCE[guidanceKey])
        .digest("hex")
        .slice(0, 12)
    : null;
  return {
    id: armId,
    shell,
    system,
    toolDescription,
    preflightOn,
    hintOn,
    guidanceSha,
  };
}

export const ARM_IDS = ["A0", "A1", "A1i", "A2", "A3", "A4", "A5", "A6", "A7"];
