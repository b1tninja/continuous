import type { ChatHistoryItem } from "core/index.js";
import { renderChatMessage } from "core/util/messageContent.js";

/*
 * Stop keeps the partial reply (as the IDE does): the last assistant message
 * stays in the conversation, marked stopped, and is saved with the session.
 * Resume (Enter on the empty prompt) then asks the model to go on from it.
 */

/** What the model is asked when Resume continues a partial reply (the IDE's words). */
export const RESUME_PROMPT =
  "Continue your response exactly where you left off:";

function isPartialReply(item: ChatHistoryItem | undefined): boolean {
  return item?.message.role === "assistant" && !item.toolCallStates?.length;
}

/**
 * After Stop: the partial reply at the end is marked `stopped`; one with no
 * text yet is dropped, as there is nothing to keep.
 */
export function markPartialReplyStopped(
  history: ChatHistoryItem[],
): ChatHistoryItem[] {
  const last = history[history.length - 1];
  if (!isPartialReply(last)) return history;
  if (!renderChatMessage(last.message).trim()) return history.slice(0, -1);
  return [...history.slice(0, -1), { ...last, interrupted: "stopped" }];
}

/**
 * After Stop, with `partial` the text the stopped request had streamed (it is
 * not in the history yet: a reply is written there when its request ends).
 * The reply is added marked `stopped`; with no text, the history is left as
 * markPartialReplyStopped leaves it.
 */
export function keepStoppedReply(
  history: ChatHistoryItem[],
  partial: string,
): ChatHistoryItem[] {
  if (!partial.trim()) return markPartialReplyStopped(history);
  return [
    ...history,
    {
      message: { role: "assistant", content: partial },
      contextItems: [],
      interrupted: "stopped",
    },
  ];
}

/**
 * Resume after a stopped partial reply: the conversation with a short user
 * message asking the model to go on, or undefined when the last item is not
 * a stopped reply (Resume then sends the last message again).
 */
export function continueStoppedReply(
  history: ChatHistoryItem[],
): ChatHistoryItem[] | undefined {
  const last = history[history.length - 1];
  if (!isPartialReply(last) || last.interrupted !== "stopped") return undefined;
  return [
    ...history.slice(0, -1),
    { ...last, interrupted: undefined },
    {
      message: { role: "user", content: RESUME_PROMPT },
      contextItems: [],
    },
  ];
}
