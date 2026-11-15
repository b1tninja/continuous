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
