import type { ChatMessage } from "../index.js";

/**
 * The user message that carries a conversation summary (C104). It is the
 * first message after the system message, never part of it, so the system
 * message is the same bytes before and after a compaction and a provider's
 * cached head (tools and system prompt) survives it.
 *
 * Plain TypeScript with no node imports: the GUI and core share it.
 */
export const SUMMARY_MESSAGE_PREFIX = "Previous conversation summary:\n\n";

/** The text of the summary message. */
export function summaryMessageText(summary: string): string {
  return `${SUMMARY_MESSAGE_PREFIX}${summary}`;
}

/**
 * The user message that carries a compaction summary (C104): a user message
 * whose text starts with `SUMMARY_MESSAGE_PREFIX`. The prune keeps it with
 * the head (countTokens.ts), and the pre-warm pins Strata's checkpoint right
 * after it (llm/localPrewarm.ts), so both use this one test.
 */
export function isSummaryMessage(message: ChatMessage | undefined): boolean {
  if (message?.role !== "user") return false;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : content.find((part) => part.type === "text")?.text;
  return !!text?.startsWith(SUMMARY_MESSAGE_PREFIX);
}
