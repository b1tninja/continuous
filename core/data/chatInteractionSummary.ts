import { createHash } from "node:crypto";

/**
 * What the local `chatInteraction` dev data keeps of a request by default
 * (ROADMAP STOR4): sizes, token counts and a hash, not the text. Every prompt
 * holds the conversation up to that point, so storing each in full grew the
 * file with the square of a session's length. The full text is kept only in
 * the opt-in debug prompt log (`debugPromptLog.ts`).
 *
 * The hash is SHA-256 of the prompt as sent, so two records of the same
 * request can be matched, and a prompt kept elsewhere can be checked against
 * the record. It does not let anyone read the prompt back.
 */
export interface ChatInteractionTextSummary {
  promptBytes?: number;
  completionBytes?: number;
  promptSha256?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The record without `prompt` and `completion`, with their sizes and the
 * prompt's hash in their place. Token counts, when the caller has them, are
 * left as they are. A record without text is returned unchanged.
 */
export function summarizeChatInteraction<T extends Record<string, unknown>>(
  data: T,
): Omit<T, "prompt" | "completion"> & ChatInteractionTextSummary {
  const { prompt, completion, ...rest } = data;
  if (typeof prompt !== "string" && typeof completion !== "string") {
    return data;
  }
  const summary: ChatInteractionTextSummary = {};
  if (typeof prompt === "string") {
    summary.promptBytes = Buffer.byteLength(prompt, "utf8");
    summary.promptSha256 = sha256(prompt);
  }
  if (typeof completion === "string") {
    summary.completionBytes = Buffer.byteLength(completion, "utf8");
  }
  return { ...rest, ...summary } as Omit<T, "prompt" | "completion"> &
    ChatInteractionTextSummary;
}
