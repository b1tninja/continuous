/** An entry trimmed from the live OpenRouter list (checked 2026-11-12). */
export const sonnetEntry = {
  id: "anthropic/claude-sonnet-4.5",
  name: "Anthropic: Claude Sonnet 4.5",
  context_length: 1000000,
  top_provider: { max_completion_tokens: 64000 },
  supported_parameters: ["reasoning", "tools", "temperature"],
  pricing: {
    prompt: "0.000003",
    completion: "0.000015",
    web_search: "0.01",
    input_cache_read: "0.0000003",
    input_cache_write: "0.00000375",
    input_cache_write_1h: "0.000006",
    overrides: [
      {
        min_prompt_tokens: 200000,
        prompt: "0.000006",
        completion: "0.0000225",
        input_cache_read: "0.0000006",
        input_cache_write: "0.0000075",
        input_cache_write_1h: "0.000012",
      },
    ],
  },
};
