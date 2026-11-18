import type { ChatCompletionCreateParams } from "openai/resources/index";

import type { CompletionOptions } from "../index.js";

import { DEFAULT_REASONING_TOKENS } from "./constants.js";
import { budgetTokensToEffort } from "./llms/anthropicThinking.js";

export type ReasoningEffortSwitch = "none" | "low" | "medium" | "high";

/**
 * The reasoning toggle and budget as the switch the OpenAI adapters read,
 * `reasoning_effort` on the chat body (packages/openai-adapters/src/apis/
 * reasoningSwitch.ts): unset when the request says nothing about reasoning,
 * `none` when it is off, else the effort for the budget (low up to 1024
 * tokens, medium up to 4096, high above; the GUI's default 2048 is medium).
 */
export function reasoningEffortFromOptions(
  options: Pick<CompletionOptions, "reasoning" | "reasoningBudgetTokens">,
): ReasoningEffortSwitch | undefined {
  if (options.reasoning === undefined) return undefined;
  if (!options.reasoning) return "none";
  return budgetTokensToEffort(
    options.reasoningBudgetTokens ?? DEFAULT_REASONING_TOKENS,
  );
}

/**
 * The body with the switch on it, for the providers whose adapter turns it
 * into the provider's own field. A `reasoning_effort` already on the body (a
 * config's extra body field) wins. `onlyOn` leaves an "off" out, for a
 * provider where off can be refused: Edit and Apply ask for reasoning off on
 * every model, and a model that must reason would refuse the request.
 */
export function withReasoningEffort<T extends ChatCompletionCreateParams>(
  body: T,
  options: Pick<CompletionOptions, "reasoning" | "reasoningBudgetTokens">,
  onlyOn = false,
): T {
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    return body;
  }
  const effort = reasoningEffortFromOptions(options);
  if (!effort || (onlyOn && effort === "none")) return body;
  return { ...body, reasoning_effort: effort };
}
