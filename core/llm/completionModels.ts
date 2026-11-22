import { findLlmInfo } from "@continuedev/llm-info";

/**
 * True when the model catalogue recommends this model for autocomplete
 * (Codestral, Mercury Coder). The setup flow ticks the Autocomplete role
 * from it; a chat model is left unticked, since it completes slowly and badly.
 */
export function isRecommendedForAutocomplete(
  model: string,
  provider?: string,
): boolean {
  return !!findLlmInfo(model, provider)?.recommendedFor?.includes(
    "autocomplete",
  );
}
