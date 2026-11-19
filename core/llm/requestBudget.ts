import { findLlmInfo } from "@continuedev/llm-info";
import type { ChatMessage, Tool } from "../index.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import { estimatePromptTokens } from "./countTokens.js";
import { correctedContextLength } from "./contextOverflow.js";
import { countingSafetyBuffer } from "./contextThresholds.js";

/**
 * The output cap a request can actually send.
 *
 * A configured `maxTokens` is what the person asked for. Two limits still
 * bind, or the provider rejects the request and the turn stops:
 *
 * - the model's published output cap (Claude 4.5 is 64,000; asking for
 *   128,000 is a 400 before any text);
 * - the room left in the context window after the prompt. Pruning only
 *   reserves 10% of the window, so a prompt that has not yet been compacted
 *   can still be too big to sit beside the full reply cap.
 *
 * `maxTokens` is the configured cap lowered to that ceiling. `ceiling` is
 * what a thinking-budget raise may not pass: a small configured cap can still
 * be raised, up to the model and the room.
 */
export interface RequestBudget {
  maxTokens: number;
  ceiling: number;
}

export function fitRequestMaxTokens(input: {
  configured: number;
  /** The model's published output cap, when one is known. */
  modelMax?: number;
  /** The context window the request is compiled against. */
  window?: number;
  /** Tokens in the prompt that will be sent. */
  promptTokens?: number;
}): RequestBudget {
  let ceiling = Number.POSITIVE_INFINITY;
  if (input.modelMax !== undefined && input.modelMax > 0) {
    ceiling = Math.min(ceiling, input.modelMax);
  }
  if (
    input.window !== undefined &&
    input.window > 0 &&
    input.promptTokens !== undefined
  ) {
    const room =
      input.window - input.promptTokens - countingSafetyBuffer(input.window);
    ceiling = Math.min(ceiling, Math.max(0, room));
  }
  if (!Number.isFinite(ceiling)) {
    return { maxTokens: input.configured, ceiling: input.configured };
  }
  return {
    maxTokens: Math.max(0, Math.min(input.configured, ceiling)),
    ceiling,
  };
}

/**
 * The cap `streamChat` will send for this compiled prompt. `maxTokens` is
 * what goes on the request. `asked` is the configured cap before that fit.
 */
export function requestBudgetForModel(input: {
  model: string;
  provider?: string;
  configured?: number;
  contextLength?: number;
  messages: ChatMessage[];
  tools?: Tool[];
  /**
   * Tokens already counted for this prompt, for example the figure compile
   * just returned. When set, the message text is not tokenized again.
   */
  promptTokens?: number;
}): RequestBudget & { asked: number; promptTokens: number } {
  const asked = input.configured ?? DEFAULT_MAX_TOKENS;
  const info = findLlmInfo(input.model, input.provider);
  const promptTokens =
    input.promptTokens ??
    estimatePromptTokens(input.model, input.messages, input.tools);
  const budget = fitRequestMaxTokens({
    configured: asked,
    modelMax: info?.maxCompletionTokens,
    window: correctedContextLength(input.contextLength, input.model),
    promptTokens,
  });
  return { ...budget, asked, promptTokens };
}
