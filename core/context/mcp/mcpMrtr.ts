/**
 * Multi Round-Trip Requests (revision 2026-07-28): a result with
 * `resultType: "input_required"` carries `inputRequests` and/or `requestState`;
 * the client answers by sending the original request again, as a new request
 * with a new id, with `inputResponses` and the exact `requestState`.
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
 */

export const MAX_INPUT_ROUNDS = 8;

export type InputRequestHandler = (
  key: string,
  request: { method: string; params?: Record<string, unknown> },
) => Promise<Record<string, unknown>>;

/** Without a handler, an elicitation is declined: nothing is invented for the user. */
export const declineElicitation: InputRequestHandler = async (_key, req) => {
  if (req.method === "elicitation/create") return { action: "decline" };
  throw new Error(`Unsupported server request "${req.method}"`);
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function resolveInputRequired(
  send: (params: Record<string, unknown>) => Promise<Record<string, unknown>>,
  params: Record<string, unknown>,
  handler: InputRequestHandler = declineElicitation,
  maxRounds = MAX_INPUT_ROUNDS,
): Promise<Record<string, unknown>> {
  let current = params;
  for (let round = 0; ; round++) {
    const result = await send(current);
    // Results of earlier servers omit the field and are "complete".
    if (!isRecord(result) || result.resultType !== "input_required") {
      return result;
    }
    if (round >= maxRounds) {
      throw new Error(
        `The server asked for input more than ${maxRounds} times; giving up.`,
      );
    }
    const { inputRequests, requestState } = result;
    const hasRequests = isRecord(inputRequests);
    if (!hasRequests && typeof requestState !== "string") {
      throw new Error(
        "Malformed input_required result: neither inputRequests nor requestState",
      );
    }
    // Retry from the original params, never from the previous retry.
    const next: Record<string, unknown> = { ...params };
    if (hasRequests) {
      const responses: Record<string, unknown> = {};
      for (const [key, req] of Object.entries(inputRequests)) {
        if (!isRecord(req) || typeof req.method !== "string") {
          throw new Error(`Malformed input request "${key}"`);
        }
        responses[key] = await handler(key, req as any);
      }
      next.inputResponses = responses;
    }
    // Echo the exact value, and only when the server sent one.
    if (typeof requestState === "string") next.requestState = requestState;
    current = next;
  }
}
