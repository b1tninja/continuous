import { ChatCompletionCreateParams } from "openai/resources/index";

/**
 * The reasoning switch the adapters share: `reasoning_effort` on the OpenAI
 * body. Unset leaves the provider's default; `none` turns reasoning off where
 * a provider takes an explicit off; any other value turns it on at that
 * level. The body wins; else the config's
 * `requestOptions.extraBodyProperties.reasoning_effort` (a catalog variant, or
 * a CLI use's `modeModels` effort) stands in, since the config has no
 * reasoning field of its own.
 *
 * Core sets the body field from the IDE's reasoning toggle and budget
 * (core/llm/reasoningEffort.ts), the CLI from the model's
 * `defaultCompletionOptions.reasoning` (extensions/cli/src/stream/requestBody.ts).
 */
export function requestedReasoningEffort(
  body: Pick<ChatCompletionCreateParams, "reasoning_effort">,
  extraBodyProperties?: Record<string, unknown>,
): string | undefined {
  const fromBody = body.reasoning_effort as string | null | undefined;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  const fromConfig = extraBodyProperties?.reasoning_effort;
  return typeof fromConfig === "string" && fromConfig ? fromConfig : undefined;
}

export type ReasoningLevel = "low" | "medium" | "high";

/** The budget tokens the GUI uses for a level (gui/src/util/modeModels.ts). */
export function levelToBudgetTokens(level: ReasoningLevel): number {
  return level === "low" ? 1024 : level === "medium" ? 4096 : 16384;
}

/**
 * The switch as on/off and a level: `minimal` counts as low, `xhigh` and
 * `max` as high (the most every provider here takes). An effort this does
 * not know turns reasoning on at its default level.
 */
export function reasoningSwitch(effort: string | undefined): {
  reasoning: boolean | undefined;
  level: ReasoningLevel;
  budgetTokens: number;
} {
  if (!effort) {
    return { reasoning: undefined, level: "medium", budgetTokens: 0 };
  }
  if (effort === "none") {
    return { reasoning: false, level: "low", budgetTokens: 0 };
  }
  const level: ReasoningLevel =
    effort === "minimal" || effort === "low"
      ? "low"
      : effort === "medium"
        ? "medium"
        : "high";
  return { reasoning: true, level, budgetTokens: levelToBudgetTokens(level) };
}

/**
 * The config's extra body fields without `reasoning_effort`, for an adapter
 * that turns the switch into its provider's own field and must not also send
 * the OpenAI one (`customFetch` merges the extra fields into the body).
 */
export function withoutReasoningEffort<
  T extends { extraBodyProperties?: Record<string, unknown> },
>(requestOptions: T | undefined): T | undefined {
  const extra = requestOptions?.extraBodyProperties;
  if (!requestOptions || !extra || !("reasoning_effort" in extra)) {
    return requestOptions;
  }
  const { reasoning_effort: _dropped, ...rest } = extra;
  return {
    ...requestOptions,
    extraBodyProperties: Object.keys(rest).length ? rest : undefined,
  };
}

/**
 * The body with the requested effort on it (`requestedReasoningEffort`), for
 * an adapter that hands the body to another adapter's converter, which does
 * not see this one's config.
 */
export function withRequestedReasoningEffort<
  T extends Pick<ChatCompletionCreateParams, "reasoning_effort">,
>(body: T, extraBodyProperties?: Record<string, unknown>): T {
  const effort = requestedReasoningEffort(body, extraBodyProperties);
  if (!effort || body.reasoning_effort === effort) return body;
  return {
    ...body,
    reasoning_effort: effort as ChatCompletionCreateParams["reasoning_effort"],
  };
}

/** OpenAI's reasoning models (o-series, GPT-5 and later). */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^o\d/.test(model) || /gpt-[5-9]/.test(model);
}

/**
 * The switch as `reasoning_effort` on OpenAI's own API. Only the reasoning
 * models take the field (others refuse it, so it is dropped). Off is `none`
 * on GPT-5.1 and later, `minimal` on GPT-5, and on the o-series, which cannot
 * turn reasoning off, nothing (their default). `xhigh` and `max` are sent as
 * `high`, the most every reasoning model takes.
 */
export function openaiReasoningEffort(
  model: string,
  effort: string | undefined,
): string | undefined {
  if (!effort || !isOpenAIReasoningModel(model)) return undefined;
  const takesNone = /gpt-(?:5\.[1-9]|[6-9])/.test(model);
  const isGpt5 = /gpt-5/.test(model) && !takesNone;
  switch (effort) {
    case "none":
      return takesNone ? "none" : isGpt5 ? "minimal" : undefined;
    case "minimal":
      return isGpt5 ? "minimal" : "low";
    case "low":
    case "medium":
    case "high":
      return effort;
    default:
      return "high";
  }
}
