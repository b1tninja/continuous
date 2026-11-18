import { ChatCompletionCreateParams } from "openai/resources/index";

import { OpenAIConfig } from "../types.js";
import { OpenAIApi } from "./OpenAI.js";
import { applyAnthropicCachingToOpenRouterBody } from "./OpenRouterCaching.js";
import { applyOpenAIBodyCacheTtl, cacheTtlInOpenAIBody } from "./cacheTtl.js";

export interface OpenRouterConfig extends OpenAIConfig {
  cachingStrategy?: import("./AnthropicCachingStrategies.js").CachingStrategyName;
}

// TODO: Extract detailed error info from OpenRouter's error.metadata.raw to surface better messages

export const OPENROUTER_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://github.com/b1tninja/continuous",
  "X-OpenRouter-Title": "Continuous",
  "X-OpenRouter-Categories": "ide-extension",
};

/**
 * The reasoning switch (reasoningSwitch.ts) as OpenRouter's `reasoning`
 * object, which takes the same effort names (`none` turns reasoning off;
 * models that must reason refuse it). OpenRouter documents no top-level
 * `reasoning_effort`, so the field is moved, not copied. A `reasoning` the
 * config already sets wins. Turning reasoning on costs reasoning tokens.
 */
export function openRouterReasoning<T extends ChatCompletionCreateParams>(
  body: T,
): T {
  const effort = body.reasoning_effort;
  if (effort === undefined || effort === null) return body;
  const { reasoning_effort: _moved, ...rest } = body;
  const existing = (body as { reasoning?: unknown }).reasoning;
  return {
    ...rest,
    reasoning: existing ?? { effort },
  } as unknown as T;
}

export class OpenRouterApi extends OpenAIApi {
  constructor(config: OpenRouterConfig) {
    super({
      ...config,
      apiBase: config.apiBase ?? "https://openrouter.ai/api/v1/",
      requestOptions: {
        ...config.requestOptions,
        headers: {
          ...OPENROUTER_HEADERS,
          ...config.requestOptions?.headers,
        },
      },
    });
  }

  private isAnthropicModel(model?: string): boolean {
    if (!model) {
      return false;
    }
    const modelLower = model.toLowerCase();
    return modelLower.includes("claude");
  }

  override modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    const modifiedBody = openRouterReasoning(super.modifyChatBody(body));

    if (!this.isAnthropicModel(modifiedBody.model)) {
      return modifiedBody;
    }

    // Core marks the body, with the lifetime it chose, before it gets here.
    // The strategy below marks the same places again with plain `ephemeral`,
    // which would turn a 1-hour request back into 5 minutes, so read the
    // lifetime first and put it back afterwards.
    const requestedTtl = cacheTtlInOpenAIBody(modifiedBody);

    applyAnthropicCachingToOpenRouterBody(
      modifiedBody as unknown as ChatCompletionCreateParams,
      (this.config as OpenRouterConfig).cachingStrategy ?? "systemAndTools",
    );

    applyOpenAIBodyCacheTtl(modifiedBody, requestedTtl);

    return modifiedBody;
  }
}

export default OpenRouterApi;
