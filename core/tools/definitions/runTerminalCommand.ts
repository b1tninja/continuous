import {
  evaluateTerminalCommandSecurity,
  ToolPolicy,
} from "@continuedev/terminal-security";
import os from "os";

import { Tool } from "../..";
import { renderEnvironment } from "../../util/environmentPrompt";
import { baseSnapshot } from "../../util/environmentSnapshot";
import { resolveShell } from "../../util/shell";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";
import {
  terminalToolDescription,
  terminalToolSystemPrefix,
  withTerminalToolSentence,
} from "./terminalToolText";

/**
 * The shell sentence of the core process's own machine, for a request built
 * before the editor's session has its snapshot. A session's request replaces
 * it with the session's `toolSentence` (`withTerminalToolSentence`), the
 * renderer's text that the CLI's Bash tool uses too. It names no folder.
 */
function processShellSentence(): string {
  try {
    return renderEnvironment(baseSnapshot(), {
      surface: "ide-agent",
      detail: "standard",
    }).toolSentence;
  } catch {
    return "";
  }
}

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

const PROCESS_SENTENCE = processShellSentence();

export { withTerminalToolSentence };

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
    description: terminalToolDescription(PROCESS_SENTENCE),
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
    prefix: terminalToolSystemPrefix(PROCESS_SENTENCE),
    exampleArgs: [["command", "git log"]],
  },
};
