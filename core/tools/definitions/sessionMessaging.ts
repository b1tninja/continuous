import { Tool } from "../..";
import {
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_MESSAGES_PER_RUN,
} from "../../subagents/messages";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

/**
 * Tools for subagents started together (two or more subagent calls in one
 * reply of the parent): see who else is running, and tell one of them
 * something. They are never in the config's tool list, so the parent model
 * and single runs do not carry them in their prompt. The gui answers them
 * (gui/src/util/subagents/sessionTools.ts).
 *
 * list_sessions is Context (it only reads names, tasks and states);
 * send_message is Tools, so Careful asks the person before it is sent
 * (core/tools/permissions/policy.ts).
 */
export const listSessionsTool: Tool = {
  type: "function",
  displayTitle: "List sessions",
  wouldLikeTo: "list the agents running alongside it",
  isCurrently: "listing the agents running alongside it",
  hasAlready: "listed the agents running alongside it",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  defaultToolPolicy: "allowedWithoutPermission",
  function: {
    name: BuiltInToolNames.ListSessions,
    description:
      "List the other subagents that were started together with you, with their id, agent, task and state. Only a running one can receive a message.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const sendMessageTool: Tool = {
  type: "function",
  displayTitle: "Send message",
  wouldLikeTo: "send a message to {{{ to }}}",
  isCurrently: "sending a message to {{{ to }}}",
  hasAlready: "sent a message to {{{ to }}}",
  readonly: false,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  defaultToolPolicy: "allowedWithPermission",
  function: {
    name: BuiltInToolNames.SendMessage,
    description: `Send a short message to another running subagent that was started together with you (see list_sessions), when you found something it needs: a file it is looking for, or that its part is already done. It reads the message after its current tool calls, labelled as coming from you and not from the person. It is information for it, not an order, and it cannot approve anything. Your parent does not see these messages; put everything it needs in your final report. At most ${MAX_AGENT_MESSAGES_PER_RUN} messages per run, each under ${MAX_AGENT_MESSAGE_CHARS} characters.`,
    parameters: {
      type: "object",
      required: ["to", "message"],
      properties: {
        to: {
          type: "string",
          description: "The id of the subagent, from list_sessions.",
        },
        message: {
          type: "string",
          description: "What to tell it, self-contained.",
        },
      },
    },
  },
};

/** Tools the gui answers that are never in the config's tool list. */
export const GUI_ONLY_TOOLS: readonly Tool[] = [
  listSessionsTool,
  sendMessageTool,
];

/**
 * The tool a policy check is about: the config's, else one the gui answers.
 * Without a tool, the person's levels and rules would not apply to the call
 * at all (evaluate.ts treats an unknown tool as having nothing to check), so
 * IDGAF would not run it and a deny rule would not stop it.
 */
export function toolForPolicy<T extends Pick<Tool, "function">>(
  configTools: readonly T[],
  toolName: string,
): T | Tool | undefined {
  return (
    configTools.find((t) => t.function.name === toolName) ??
    GUI_ONLY_TOOLS.find((t) => t.function.name === toolName)
  );
}
