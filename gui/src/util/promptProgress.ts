import type { ChatMessage, PromptProgress } from "core";

// The line itself is shared with the CLI's spinner row
export { formatPromptProgress } from "core/llm/promptProgressText";

/**
 * Splits a streamed batch into the signals that are not part of the reply and
 * the reply itself: the server's prompt-reading updates (`promptProgress`)
 * and the notice that the reply is held while recovery looks for a tool call
 * written as text (`recoveryHold`, "start" or "end"). Both are empty assistant
 * messages that only carry that field; they are not part of the conversation.
 */
export function splitPromptProgress(messages: ChatMessage[]): {
  progress: PromptProgress | undefined;
  hold: "start" | "end" | undefined;
  reply: ChatMessage[];
} {
  let progress: PromptProgress | undefined;
  let hold: "start" | "end" | undefined;
  const reply: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.promptProgress) {
      progress = message.promptProgress;
    } else if (message.role === "assistant" && message.recoveryHold) {
      hold = message.recoveryHold;
    } else {
      reply.push(message);
    }
  }
  return { progress, hold, reply };
}

/** The line shown while a reply is held for tool call recovery. */
export const RECOVERY_HOLD_TEXT = "Checking the reply for a tool request";
