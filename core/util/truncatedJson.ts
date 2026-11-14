/**
 * True when `raw` stops part-way through a JSON value: inside a string or with
 * an object or array still open. That is what a tool call looks like when the
 * model hit its output limit while writing the arguments. Complete but
 * malformed JSON is not truncated, so the lenient parser can still repair it.
 */
export function isTruncatedJson(raw: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
    }
  }
  return inString || depth > 0;
}

/**
 * Stop reasons that mean the reply hit its output limit. Bedrock's
 * `max_tokens` and `model_context_window_exceeded`, OpenAI's `length`,
 * Anthropic's `max_tokens`.
 */
const LENGTH_STOP_REASONS = new Set([
  "max_tokens",
  "length",
  "model_context_window_exceeded",
]);

/**
 * Whether the reply stopped because it ran out of output: true or false when
 * the provider reported a stop reason, undefined when it reported none.
 */
export function stoppedForLength(
  stopReason: string | null | undefined,
): boolean | undefined {
  if (!stopReason) return undefined;
  return LENGTH_STOP_REASONS.has(stopReason.toLowerCase());
}

/**
 * What the model sees when its tool call's arguments arrived incomplete but
 * the reply did not hit the output limit (it stopped for a tool call or
 * ended normally). Sending smaller pieces would not help; sending the call
 * again does. Seen when argument fragments were attached to the wrong call.
 */
export function incompleteToolCallResult(toolName: string): string {
  return `Your ${toolName} call's arguments arrived incomplete, so it was not run and nothing was written. This was not the output limit: the reply ended normally. Send the same call again.`;
}

/** What the model sees when its tool call was cut off and not run. */
export function truncatedToolCallResult(
  toolName: string,
  maxTokens: number | undefined,
): string {
  const limit = maxTokens ? ` of ${maxTokens} tokens` : "";
  return `Your ${toolName} call was cut off at the output limit${limit}, so it was not run and nothing was written. ${toolName === "create_new_file" ? "Send it again in smaller pieces: create the file with its first part, then call create_new_file with append set to true for each further part." : "Send it again in smaller pieces, each in its own call."}`;
}
