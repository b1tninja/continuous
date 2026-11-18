import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME } from "../builtIn";

/**
 * Names of the tools that read and end the commands run_terminal_command
 * started. Not in BuiltInToolNames: the role table (roleTools.ts) leaves them
 * unclassified, so the agent and background roles get them and Plan mode,
 * which has no terminal, does not.
 */
export enum CommandOutputToolNames {
  ReadCommandOutput = "read_command_output",
  StopCommand = "stop_command",
}

const ID = {
  type: "string",
  description:
    "The command's id from its run_terminal_command result (cmd-3). Leave it out for the most recent command.",
};

export const readCommandOutputTool: Tool = {
  type: "function",
  displayTitle: "Read Command Output",
  wouldLikeTo: "read a command's output",
  isCurrently: "reading a command's output",
  hasAlready: "read a command's output",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: CommandOutputToolNames.ReadCommandOutput,
    description:
      "Read more of the output of a command started with run_terminal_command: the end of it, or the lines matching a pattern, with line numbers. Use it for a command running in the background, or when a result says its output was cut. Also says whether the command is still running.",
    parameters: {
      type: "object",
      properties: {
        id: ID,
        grep: {
          type: "string",
          description:
            "A regular expression (case-insensitive): return only matching lines, with their line numbers.",
        },
        lines: {
          type: "number",
          description:
            "How many lines: the last N without grep (default 100), or at most N matches with it (default 200). At most 1000.",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "CommandLineIcon",
};

export const stopCommandTool: Tool = {
  type: "function",
  displayTitle: "Stop Command",
  wouldLikeTo: "stop a command",
  isCurrently: "stopping a command",
  hasAlready: "stopped a command",
  readonly: false,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: CommandOutputToolNames.StopCommand,
    description:
      "End a command started with run_terminal_command that is still running (a server, a watch build, a command in the background), with everything it started. Returns its last lines.",
    parameters: {
      type: "object",
      properties: { id: ID },
    },
  },
  // Ends only a command the agent itself started
  defaultToolPolicy: "allowedWithoutPermission",
  toolCallIcon: "StopIcon",
};
