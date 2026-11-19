import { findLlmInfo } from "@continuedev/llm-info";
import type { ChatMessage, Tool } from "../index.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import { estimatePromptTokens } from "./countTokens.js";
import { correctedContextLength } from "./contextOverflow.js";
import { fitRequestMaxTokens, type RequestBudget } from "./requestFit.js";

export { fitRequestMaxTokens, type RequestBudget } from "./requestFit.js";

/**
 * The cap `streamChat` will send for this compiled prompt. `maxTokens` is
 * what goes on the request. `asked` is the configured cap before that fit.
 *
 * Callers in the webview must not use this. It tokenizes, and that module
 * does not load in the webview. Pass a prompt size to `fitRequestMaxTokens`.
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
