/**
 * A model's context window and default output cap, from (first that has it):
 * the person's config, the provider's own models API (cached by
 * core/llm/providerModelInfoStore.ts), and the bundled llm-info. A provider
 * value is used only when the provider sent that field.
 *
 * The output cap keeps today's rule (llm-info's cap, but at most a quarter of
 * the window, so one reply cannot take the whole context). A provider
 * class's own default (Anthropic's 8192) stays a default: the provider's cap
 * can only lower it, never raise it, so a refresh never makes replies longer
 * than they were.
 */

export interface LimitInputs {
  /** `contextLength` from the person's config. */
  userContextLength?: number;
  /** `completionOptions.maxTokens` from the person's config. */
  userMaxTokens?: number;
  /** The provider class's default `maxTokens`, when the config has no completionOptions. */
  classMaxTokens?: number;
  llmInfo?: { contextLength?: number; maxCompletionTokens?: number };
  provider?: { contextLength?: number; maxOutputTokens?: number };
  defaultContextLength: number;
  defaultMaxTokens: number;
}

/**
 * Where the window came from. `unknown` means nothing was set and nothing
 * is published: the LLM then uses `defaultContextLength` (32,768) and the
 * UI says so.
 */
export type ContextLengthSource =
  "config" | "provider" | "published" | "unknown";

export interface ResolvedLimits {
  /** Undefined when nobody knows; the LLM's getter then uses the default. */
  contextLength: number | undefined;
  contextLengthSource: ContextLengthSource;
  maxTokens: number;
}

function contextOf(i: LimitInputs): {
  contextLength: number | undefined;
  contextLengthSource: ContextLengthSource;
} {
  if (i.userContextLength !== undefined) {
    return {
      contextLength: i.userContextLength,
      contextLengthSource: "config",
    };
  }
  if (i.provider?.contextLength !== undefined) {
    return {
      contextLength: i.provider.contextLength,
      contextLengthSource: "provider",
    };
  }
  if (i.llmInfo?.contextLength !== undefined) {
    return {
      contextLength: i.llmInfo.contextLength,
      contextLengthSource: "published",
    };
  }
  return { contextLength: undefined, contextLengthSource: "unknown" };
}

export function resolveModelLimits(i: LimitInputs): ResolvedLimits {
  const resolved = contextOf(i);
  if (i.userMaxTokens !== undefined) {
    return { ...resolved, maxTokens: i.userMaxTokens };
  }
  const providerMax = i.provider?.maxOutputTokens;
  if (i.classMaxTokens !== undefined) {
    return {
      ...resolved,
      maxTokens: providerMax
        ? Math.min(i.classMaxTokens, providerMax)
        : i.classMaxTokens,
    };
  }
  const cap = providerMax ?? i.llmInfo?.maxCompletionTokens;
  return {
    ...resolved,
    maxTokens: cap
      ? Math.min(cap, (resolved.contextLength ?? i.defaultContextLength) / 4)
      : i.defaultMaxTokens,
  };
}
