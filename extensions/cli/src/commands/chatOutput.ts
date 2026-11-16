// Output helpers for headless mode, kept apart so chat.ts stays under the
// 500-line limit.

/**
 * Processes and validates JSON output for headless mode
 * @param response - The raw response from the LLM
 * @returns Valid JSON string
 */
export function processJsonOutput(response: string): string {
  const trimmedResponse = response.trim();

  try {
    // Try to parse the response as JSON to validate it
    JSON.parse(trimmedResponse);
    // If it parses successfully, return as-is
    return trimmedResponse;
  } catch {
    // If it's not valid JSON, wrap it in a JSON object
    return JSON.stringify({
      response: trimmedResponse,
      status: "success",
      note: "Response was not valid JSON, so it was wrapped in a JSON object",
    });
  }
}

/**
 * Strips <think></think> tags and excess whitespace from response
 * @param response - The raw response from the LLM
 * @returns Cleaned response
 */
export function stripThinkTags(response: string): string {
  // Remove <think></think> tags and their content
  let cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "");

  // Remove excess whitespace: multiple consecutive newlines become single newlines
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, "\n\n");

  // Trim leading and trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * The answer as headless mode prints it: think tags stripped with --silent,
 * and wrapped as JSON with --format json
 */
export function formatHeadlessAnswer(
  response: string,
  silent?: boolean,
  format?: string,
): string {
  const processed = silent ? stripThinkTags(response) : response;
  return format === "json" ? processJsonOutput(processed) : processed;
}
