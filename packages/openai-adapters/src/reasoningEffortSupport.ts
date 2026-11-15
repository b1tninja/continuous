/**
 * Which providers' adapters apply a `reasoning_effort` set in the config's
 * `requestOptions.extraBodyProperties`, which is where the CLI puts a
 * `modeModels` entry's `reasoningEffort` (ModelService `withReasoningEffort`)
 * and where a catalog variant puts its own.
 *
 * Applying means the request carries the effort in a field the provider's
 * API reads: Anthropic and Bedrock turn it into a thinking budget or the
 * family's reasoning switch, Gemini and Vertex into a thinking config,
 * OpenRouter into its `reasoning` field, and the OpenAI-compatible adapters
 * send it as `reasoning_effort` on a Chat Completions request (the server
 * decides what it does with it).
 *
 * The providers below do not. The transport still adds the field to their
 * JSON body (packages/fetch merges `extraBodyProperties` into every request),
 * but none of these APIs reads `reasoning_effort`, and Jina and the mock
 * send no chat request at all. `reasoningEffortSupport.vitest.ts` sends a
 * request through every provider `constructLlmApi` knows and fails when this
 * set and the code disagree.
 */
export const REASONING_EFFORT_NOT_APPLIED: ReadonlySet<string> = new Set([
  // AskSage's /query body has no reasoning field
  "askSage",
  // Cohere's v1 /chat body; its reasoning setting is not sent
  "cohere",
  // Embeddings and rerank only: no chat request
  "jina",
  // Test provider: answers without a request
  "mock",
  // The apply endpoint (/code/apply), not a chat model
  "relace",
  // watsonx.ai /text/chat_stream body has no reasoning field
  "watsonx",
]);

/**
 * True when the adapter for `provider` carries a configured
 * `reasoning_effort` into its request in a field the provider reads. False
 * for the providers listed above. A provider `constructLlmApi` does not know
 * also returns true: there is no adapter whose code could be checked, so no
 * warning should claim it ignores the effort.
 */
export function appliesReasoningEffort(provider: string): boolean {
  return !REASONING_EFFORT_NOT_APPLIED.has(provider);
}
