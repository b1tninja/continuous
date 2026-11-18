import {
  evaluateTerminalCommandSecurity,
  ToolPolicy,
} from "@continuedev/terminal-security";
import os from "os";
import { Tool } from "../..";
import { resolveShell } from "../../util/shell";
import { TERMINAL_ENV_NOTICE } from "../../util/terminalEnvironment";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

/**
 * The host's shell, as the executor starts it (resolveShell), so the sentence
 * and the program that runs the command cannot disagree: they did on macOS
 * with no `$SHELL`, where this said /bin/zsh and the command ran in /bin/bash.
 * A WSL or container preference is left out on purpose: the text stays what it
 * was for them.
 */
export function getPreferredShell(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): string {
  return resolveShell({
    platform: opts.platform ?? os.platform(),
    env: opts.env ?? process.env,
    terminalShell: "default",
  }).executable;
}

/**
 * The sentence naming the shell. On Windows the editor starts Windows
 * PowerShell 5.1 (resolveShell), which rejects `&&` and `||` as syntax errors;
 * the CLI's terminal tool says so for the same reason (its describeShell).
 * Other platforms are unchanged.
 */
export function platformInfo(
  platform: NodeJS.Platform = os.platform(),
  arch: string = os.arch(),
): string {
  const shell = getPreferredShell({ platform });
  if (platform === "win32") {
    return `Runs in Windows PowerShell 5.1 (${shell}, ${arch}): chain commands with ; or a newline, not && or ||, and use PowerShell cmdlets and syntax.`;
  }
  return `Choose terminal commands and scripts optimized for ${platform} and ${arch} and shell ${shell}.`;
}

const PLATFORM_INFO = platformInfo();

/** How long output is handled (plans/research/runaway-command-output.md). */
const OUTPUT_NOTE = `Output longer than about 30,000 characters is cut to its start and end; the full output is kept, and read_command_output reads more of it (the end, or the lines matching a pattern). A command that floods output or prints the same lines over and over is stopped. For a long log, filter it yourself (${os.platform() === "win32" ? "| Select-Object -Last 50" : "| tail -n 50"}).`;

const RUN_COMMAND_NOTES = `The shell is not stateful and will not remember any previous commands.\
      When a command is run in the background, end it with stop_command, or suggest shell commands to stop it; NEVER suggest using Ctrl+C.\
      ${OUTPUT_NOTE}\
      When suggesting subsequent shell commands ALWAYS format them in shell command blocks.\
      Do NOT perform actions requiring special/admin privileges.\
      IMPORTANT: To edit files, use Edit/MultiEdit tools instead of bash commands (sed, awk, etc). A command that writes a file (redirection, Set-Content, node -e or python -c calling a write) counts as a file edit: use the edit tools for it, and if an edit was refused, the command is refused too.\
      ${TERMINAL_ENV_NOTICE}      ${PLATFORM_INFO}`;

export const runTerminalCommandTool: Tool = {
  type: "function",
  displayTitle: "Run Terminal Command",
  wouldLikeTo: "run the following terminal command:",
  isCurrently: "running the following terminal command:",
  hasAlready: "ran the following terminal command:",
  readonly: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.RunTerminalCommand,
    description: `Run a terminal command in the current directory.\n${RUN_COMMAND_NOTES}`,
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: {
          type: "string",
          description:
            "The command to run. This will be passed directly into the IDE shell.",
        },
        waitForCompletion: {
          type: "boolean",
          description:
            "Whether to wait for the command to complete before returning. Default is true. Set to false to run the command in the background. Set to true to run the command in the foreground and wait to collect the output.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithPermission",
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    return evaluateTerminalCommandSecurity(
      basePolicy,
      parsedArgs.command as string,
    );
  },
  systemMessageDescription: {
    prefix: `To run a terminal command, use the ${BuiltInToolNames.RunTerminalCommand} tool
${RUN_COMMAND_NOTES}
You can also optionally include the waitForCompletion argument set to false to run the command in the background.      
For example, to see the git log, you could respond with:`,
    exampleArgs: [["command", "git log"]],
  },
};
