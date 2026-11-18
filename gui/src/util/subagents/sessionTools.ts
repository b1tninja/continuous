import type { ContextItem, Tool, ToolCallState } from "core";
import type { SubagentDefinition } from "core/subagents/definitions";
import { toolMatchesEntry } from "core/subagents/tools";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  listSessionsTool,
  sendMessageTool,
} from "core/tools/definitions/sessionMessaging";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import type { RootState } from "../../redux/store";
import {
  agentMessagesLeft,
  isSubagentRunLive,
  sendAgentMessage,
} from "./registry";

/**
 * Messaging between subagents started together: two or more subagent calls
 * in one reply of the parent run side by side, and each may list the others
 * and send one of them a message. The parent is waiting on all of them, so
 * it is not a receiver; a single run has nobody to talk to and does not get
 * the tools, so its prompt does not change. Design:
 * plans/research/session-messaging-and-management.md (phase S1).
 */

/** The subagent calls of the parent's reply that holds this call, in order. */
export function subagentBatchOf(
  history: RootState["session"]["history"],
  toolCallId: string,
): ToolCallState[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const calls = history[i].toolCallStates ?? [];
    if (calls.some((c) => c.toolCallId === toolCallId)) {
      return calls.filter(
        (c) => c.toolCall.function.name === BuiltInToolNames.Subagent,
      );
    }
  }
  return [];
}

/**
 * The messaging tools a run gets: both when it was started with another
 * subagent, none for a single run. An agent file can leave them out with
 * `disallowedTools`. Every run of a batch gets the same list, so siblings
 * keep one cached prefix.
 */
export function sessionToolsFor(
  definition: Pick<SubagentDefinition, "disallowedTools">,
  batchSize: number,
): Tool[] {
  if (batchSize < 2) return [];
  const deny = definition.disallowedTools ?? [];
  return [listSessionsTool, sendMessageTool].filter(
    (tool) => !deny.some((entry) => toolMatchesEntry(tool, entry)),
  );
}

interface Peer {
  id: string;
  agent: string;
  task: string;
  state: string;
  live: boolean;
}

function peersOf(getState: () => RootState, runId: string): Peer[] {
  const batch = subagentBatchOf(getState().session.history, runId);
  const peers = batch
    .filter((c) => c.toolCallId !== runId)
    .map((c) => {
      const args = c.parsedArgs ?? {};
      const live = isSubagentRunLive(c.toolCallId);
      const status = c.subagent?.status;
      return {
        id: c.toolCallId,
        agent: typeof args.agent === "string" ? args.agent : "subagent",
        task: typeof args.description === "string" ? args.description : "",
        live,
        state: live
          ? status === "queued"
            ? "waiting for a slot (messages wait for it)"
            : "running"
          : status && status !== "queued" && status !== "running"
            ? `ended (${status})`
            : "not started",
      };
    });
  return peers;
}

function textItem(name: string, content: string): ContextItem[] {
  return [{ name, description: name, content }];
}

function refuse(message: string): never {
  throw new ContinueError(ContinueErrorReason.Unspecified, message);
}

/**
 * Answers list_sessions and send_message for one run. Undefined for every
 * other tool, which goes to core. A refusal throws, so the run sees an
 * error result with the reason.
 */
export function answerSessionTool(
  call: ToolCallState,
  self: { runId: string; name: string },
  getState: () => RootState,
): ContextItem[] | undefined {
  const name = call.toolCall.function.name;
  if (
    name !== BuiltInToolNames.ListSessions &&
    name !== BuiltInToolNames.SendMessage
  ) {
    return undefined;
  }
  const peers = peersOf(getState, self.runId);

  if (name === BuiltInToolNames.ListSessions) {
    const lines = [
      `You are ${self.name} (id ${self.runId}). You may send ${agentMessagesLeft(self.runId)} more message(s).`,
      peers.length
        ? "Started together with you:"
        : "No other subagent was started with you.",
      ...peers.map(
        (p) =>
          `- id ${p.id}: ${p.agent}${p.task ? `, "${p.task}"` : ""}, ${p.state}`,
      ),
    ];
    return textItem("Sessions", lines.join("\n"));
  }

  const args = call.parsedArgs ?? {};
  const to = typeof args.to === "string" ? args.to.trim() : "";
  const text = typeof args.message === "string" ? args.message : "";
  const peer = peers.find((p) => p.id === to);
  if (!peer) {
    refuse(
      to === self.runId
        ? "That is your own id. Send to another subagent from list_sessions."
        : `No subagent with id "${to}" was started with you. Call list_sessions for the ids.`,
    );
  }
  const outcome = sendAgentMessage(self, peer.id, text);
  switch (outcome) {
    case "queued":
      return textItem(
        "Message sent",
        `Queued for ${peer.agent} (id ${peer.id}). It reads it after its current tool calls. It will not reply to you; carry on with your own task.`,
      );
    case "not-live":
      return refuse(
        `${peer.agent} (id ${peer.id}) is ${peer.state} and takes no messages. Put what it would have needed in your own report.`,
      );
    case "empty":
      return refuse("The message is empty.");
    case "too-long":
      return refuse("The message is too long. Send a shorter one.");
    case "limit":
      return refuse(
        "You have sent as many messages as one run may. Put the rest in your final report.",
      );
    case "duplicate":
      return refuse("You already sent that message to this subagent.");
    case "self":
      return refuse(
        "That is your own id. Send to another subagent from list_sessions.",
      );
  }
}
