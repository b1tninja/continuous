import { AssistantUnrolled, ModelConfig } from "@continuedev/config-yaml";
import {
  BaseLlmApi,
  bedrockCachePointFields,
  constructLlmApi,
  formatFieldFallback,
  LLMConfig,
  onFieldFallback,
} from "@continuedev/openai-adapters";

import { AuthConfig } from "./auth/workos.js";
import { logger } from "./util/logger.js";

/**
 * The caching settings for a Bedrock model. The CLI only runs agent loops, so
 * the chat window's default for Agent mode applies: when the model config says
 * nothing about caching, a model that takes cache points caches. A week of
 * real agent traffic read 12 to 28 times per token written, and Auto came
 * within 0.7 points of the best lifetime for each conversation
 * (plans/cache-real-world-data.md), so a Claude model gets Auto. A Nova model
 * that the AWS table lists (`bedrockCachePointFields`) caches too, with no
 * lifetime: Nova takes only the 5-minute default, its cache reads cost a
 * quarter of its input price and its writes are not charged. Anything the
 * config says wins, including `promptCaching: false`. Other models are left
 * alone: they reject a cache point.
 */
export function bedrockCachingSettings(model: ModelConfig): {
  promptCaching?: boolean;
  cacheBehavior?: ModelConfig["cacheBehavior"];
} {
  const promptCaching = model.defaultCompletionOptions?.promptCaching;
  const behavior = model.cacheBehavior;
  const silent =
    promptCaching === undefined &&
    behavior?.cacheConversation === undefined &&
    behavior?.cacheSystemMessage === undefined;
  if (silent && /claude/i.test(model.model)) {
    return {
      promptCaching: true,
      cacheBehavior: { ...behavior, ttl: behavior?.ttl ?? "auto" },
    };
  }
  if (silent && bedrockCachePointFields(model.model)) {
    return { promptCaching: true, cacheBehavior: behavior };
  }
  return { promptCaching, cacheBehavior: behavior };
}

/**
 * The lifetime for an Anthropic model: what the config names, else Auto when
 * the config says nothing about caching (the same default as the Bedrock
 * path). The adapter already caches unless its `cachingStrategy` is `none`.
 */
export function anthropicTtl(
  model: ModelConfig,
): "auto" | "5m" | "1h" | undefined {
  if (model.cacheBehavior?.ttl) return model.cacheBehavior.ttl;
  const silent =
    model.defaultCompletionOptions?.promptCaching === undefined &&
    model.cacheBehavior?.cacheConversation === undefined &&
    model.cacheBehavior?.cacheSystemMessage === undefined;
  return silent ? "auto" : undefined;
}

/**
 * The model config a subagent's requests are built from: its cache lifetime is
 * `cacheBehavior.subagentTtl` (C85), 5 minutes unless that says otherwise,
 * because a run's requests come seconds apart. "inherit" keeps the model's own
 * `cacheBehavior.ttl` (or the CLI's Auto default). Only the lifetime changes:
 * whether the model caches at all is decided as for any other request, and
 * CONTINUOUS_FORCE_CACHE_5M=1 still wins in the adapters.
 */
export function subagentCacheModel(model: ModelConfig): ModelConfig {
  const policy = model.cacheBehavior?.subagentTtl ?? "5m";
  if (policy === "inherit") return model;
  return { ...model, cacheBehavior: { ...model.cacheBehavior, ttl: policy } };
}

/**
 * Once per process: when an adapter drops a request field a model refused
 * (the request-field policy, plans/ROADMAP.md C58), say so once, with the
 * config line that makes the choice permanent. The exit summary lists them
 * again.
 */
let fieldFallbacksWatched = false;
function watchFieldFallbacks(): void {
  if (fieldFallbacksWatched) return;
  fieldFallbacksWatched = true;
  onFieldFallback((fallback) => logger.warn(formatFieldFallback(fallback)));
}

/**
 * Creates an LLM API instance from a ModelConfig and auth configuration
 */
export function createLlmApi(
  model: ModelConfig,
  _authConfig: AuthConfig,
): BaseLlmApi | null {
  watchFieldFallbacks();
  const config: LLMConfig = {
    provider: model.provider as any,
    model: model.model,
    apiKey: model.apiKey,
    apiBase: model.apiBase,
    requestOptions: model.requestOptions,
    env: model.env,
    omitSampling: model.defaultCompletionOptions?.omitSampling,
    // Prompt caching settings. The Bedrock adapter reads `promptCaching` and
    // `cacheBehavior`; see `bedrockCachingSettings` for what it gets when the
    // model config says nothing. The Anthropic adapter has its own
    // `cachingStrategy` (caching is on unless that is `none`) and reads only the
    // lifetime, so that is all it is given.
    ...(model.provider === "bedrock"
      ? bedrockCachingSettings(model)
      : model.provider === "anthropic" && anthropicTtl(model)
        ? { cacheBehavior: { ttl: anthropicTtl(model) } }
        : {}),
  };

  return constructLlmApi(config) ?? null;
}

export function getLlmApi(
  assistant: AssistantUnrolled,
  authConfig: AuthConfig,
): [BaseLlmApi, ModelConfig] {
  if (!assistant.models || assistant.models.length === 0) {
    throw new Error("No models found in the configured assistant");
  }

  const model = assistant.models?.find(
    (model) =>
      model?.roles?.includes("chat") || (model && model.roles === undefined),
  );

  if (!model) {
    throw new Error(
      "No models with the chat role found in the configured assistant",
    );
  }

  const llmApi = createLlmApi(model, authConfig);

  if (!llmApi) {
    throw new Error(
      "Failed to initialize LLM. Please check your configuration.",
    );
  }

  return [llmApi, model];
}
