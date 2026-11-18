import { CompletionOptions } from "../../index.js";
import { DEFAULT_REASONING_TOKENS } from "../constants.js";

export type AnthropicEffort = "low" | "medium" | "high";

/**
 * `"summarized"` returns a readable summary of the reasoning; `"omitted"`
 * returns thinking blocks whose text is empty. Thinking is billed the same
 * either way: `display` controls visibility only.
 */
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicThinkingParams {
  thinking?:
    | { type: "enabled"; budget_tokens: number }
    | { type: "adaptive"; display?: AnthropicThinkingDisplay };
  output_config?: { effort: AnthropicEffort };
}

// Models that reject `thinking.type: "enabled"` and instead require
// `thinking.type: "adaptive"` with `output_config.effort`.
const ADAPTIVE_THINKING_MODEL_PATTERN =
  /claude-(opus|sonnet|haiku|fable|mythos)-(4-[6-9]|[5-9])/;

export function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_MODEL_PATTERN.test(model);
}

// Claude 4.7 and later, Fable and Mythos: `thinking.display` defaults to
// "omitted", so thinking blocks stream with empty text unless the request asks
// for "summarized". Opus 4.6 and Sonnet 4.6 default to "summarized".
const OMITTED_DISPLAY_MODEL_PATTERN =
  /claude-(?:(?:opus|sonnet|haiku)-(?:4-[7-9]|[5-9])|fable|mythos)/;

export function thinkingDisplayDefaultsToOmitted(model: string): boolean {
  return OMITTED_DISPLAY_MODEL_PATTERN.test(model);
}

// Models that run adaptive thinking when the request has no `thinking` field
// (Opus 5 and later, Sonnet 5 and later, Haiku 5.5, Fable, Mythos). With
// reasoning off they still think, and on Opus 5.5 and Fable the notes between
// tool calls come back as thinking blocks too.
const THINKS_BY_DEFAULT_MODEL_PATTERN =
  /claude-(?:(?:opus|sonnet|haiku)-[5-9]|fable|mythos)/;

export function thinksByDefault(model: string): boolean {
  return THINKS_BY_DEFAULT_MODEL_PATTERN.test(model);
}

// Inverse of the GUI mapping in gui/src/util/modeModels.ts
// (low: 1024, medium: 4096, high: 16384).
export function budgetTokensToEffort(budgetTokens: number): AnthropicEffort {
  if (budgetTokens <= 1024) {
    return "low";
  }
  if (budgetTokens <= 4096) {
    return "medium";
  }
  return "high";
}

/**
 * The `thinking` request field. Where the model hides its thinking by default
 * (`thinkingDisplayDefaultsToOmitted`) the request asks for `display:
 * "summarized"`, so the chat can show the reasoning as it streams; without it
 * the blocks arrive empty and the chat shows nothing until the answer. A model
 * that thinks whether or not it is asked (`thinksByDefault`) gets the same
 * field with reasoning off, and no effort, so its thinking is shown too:
 * omitting the field and sending `{ type: "adaptive" }` run the same thinking.
 */
export function getAnthropicThinkingParams(
  options: CompletionOptions,
): AnthropicThinkingParams {
  const summarize = thinkingDisplayDefaultsToOmitted(options.model);

  if (!options.reasoning) {
    return summarize && thinksByDefault(options.model)
      ? { thinking: { type: "adaptive", display: "summarized" } }
      : {};
  }

  const budgetTokens =
    options.reasoningBudgetTokens ?? DEFAULT_REASONING_TOKENS;

  if (supportsAdaptiveThinking(options.model)) {
    return {
      thinking: summarize
        ? { type: "adaptive", display: "summarized" }
        : { type: "adaptive" },
      output_config: { effort: budgetTokensToEffort(budgetTokens) },
    };
  }

  return {
    thinking: { type: "enabled", budget_tokens: budgetTokens },
  };
}
