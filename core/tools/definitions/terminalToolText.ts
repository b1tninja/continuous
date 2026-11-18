/**
 * The terminal tool's text, apart from its definition so the editor's
 * webview can put the session's shell sentence in (ENV13) without bundling
 * the gatherer. No node module is imported here.
 */
import { TERMINAL_ENV_NOTICE } from "../../util/terminalEnvironment";
import { BuiltInToolNames } from "../builtIn";

const RUN_COMMAND_NOTES = `The shell is not stateful and will not remember any previous commands.\
      When a command is run in the background, end it with stop_command, or suggest shell commands to stop it; NEVER suggest using Ctrl+C.\
      Output longer than about 30,000 characters is cut to its start and end; the full output is kept, and read_command_output reads more of it (the end, or the lines matching a pattern). A command that floods output or prints the same lines over and over is stopped. For a long log, filter it yourself (| tail -n 50, or | Select-Object -Last 50 on Windows).\
      When suggesting subsequent shell commands ALWAYS format them in shell command blocks.\
      Do NOT perform actions requiring special/admin privileges.\
      IMPORTANT: To edit files, use Edit/MultiEdit tools instead of bash commands (sed, awk, etc). A command that writes a file (redirection, Set-Content, node -e or python -c calling a write) counts as a file edit: use the edit tools for it, and if an edit was refused, the command is refused too.\
      ${TERMINAL_ENV_NOTICE}`;

/** The tool's description with a given shell sentence (empty: none). */
export function terminalToolDescription(shellSentence: string): string {
  return `Run a terminal command in the current directory.\n${RUN_COMMAND_NOTES}${shellSentence ? `      ${shellSentence}` : ""}`;
}

/** The text-tools prefix (models without native tools) with a given shell sentence. */
export function terminalToolSystemPrefix(shellSentence: string): string {
  return `To run a terminal command, use the ${BuiltInToolNames.RunTerminalCommand} tool
${RUN_COMMAND_NOTES}${shellSentence ? `      ${shellSentence}` : ""}
You can also optionally include the waitForCompletion argument set to false to run the command in the background.      
For example, to see the git log, you could respond with:`;
}

/**
 * The tools with the terminal tool's shell sentence replaced by the
 * session's. Other tools, and a list without the terminal tool, come back as
 * they are.
 */
export function withTerminalToolSentence<
  T extends {
    function: { name: string; description?: string };
    systemMessageDescription?: { prefix: string; exampleArgs?: unknown };
  },
>(tools: T[], shellSentence: string): T[] {
  return tools.map((tool) =>
    tool.function.name === BuiltInToolNames.RunTerminalCommand
      ? {
          ...tool,
          function: {
            ...tool.function,
            description: terminalToolDescription(shellSentence),
          },
          ...(tool.systemMessageDescription
            ? {
                systemMessageDescription: {
                  ...tool.systemMessageDescription,
                  prefix: terminalToolSystemPrefix(shellSentence),
                },
              }
            : {}),
        }
      : tool,
  );
}
