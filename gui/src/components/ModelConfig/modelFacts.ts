import type { ModelDescription } from "core";
import type {
  ModelFacts,
  NotSetContext,
} from "core/config/modelEdit/modelEditFields";
import {
  autodetectTemplateType,
  modelSupportsImages,
  modelSupportsReasoning,
} from "core/llm/autodetect";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { costOf } from "core/util/costOf";
import { isLocalModel } from "../../redux/thunks/prepareCompaction";
import {
  effectiveCacheSetting,
  modelHasFixedCacheLifetime,
  modelSupportsPromptCacheControl,
} from "../../util/promptCache";

/**
 * What the loaded model does for the keys nobody wrote, asked of the same
 * functions the requests use. `written` is the model as the saved layers
 * build it: a limit one of them wrote is not a fact about "not set", so it
 * is left out and the sentence falls back to the rule in words.
 */
export function modelFacts(
  loaded: ModelDescription | undefined,
  written: Record<string, unknown> | undefined,
): { local?: boolean; facts: ModelFacts } {
  if (!loaded) return { facts: {} };
  const options = written?.defaultCompletionOptions as
    Record<string, unknown> | undefined;
  const wroteWindow =
    written?.contextLength !== undefined ||
    options?.contextLength !== undefined;
  const wroteMaxTokens = options?.maxTokens !== undefined;

  // The model as it would be with nothing about these written
  const bare: ModelDescription = {
    ...loaded,
    completionOptions: {
      ...loaded.completionOptions,
      reasoning: undefined,
      promptCaching: undefined,
    },
    cacheBehavior: undefined,
    capabilities: { ...loaded.capabilities, tools: undefined },
  };

  const price = (input: number, output: number) =>
    costOf(
      { input, output, cacheRead: 0, cacheWrite: 0 },
      { provider: loaded.provider, model: loaded.model },
    );
  const inPrice = price(1_000_000, 0);
  const outPrice = price(0, 1_000_000);

  const control = modelSupportsPromptCacheControl(bare);
  return {
    local: isLocalModel(loaded),
    facts: {
      apiBase: loaded.apiBase,
      ...(wroteWindow
        ? {}
        : {
            contextLength: loaded.contextLength,
            contextLengthSource: loaded.contextLengthSource,
          }),
      ...(wroteMaxTokens
        ? {}
        : {
            maxTokens: loaded.completionOptions?.maxTokens,
            maxTokensSource: loaded.maxTokensSource,
          }),
      reasoningDetected: modelSupportsReasoning(bare),
      chatTemplate: autodetectTemplateType(loaded.model) ?? undefined,
      cache: {
        control,
        defaultsOn:
          effectiveCacheSetting(bare, undefined, "agent") !== undefined,
        fixedLifetime: modelHasFixedCacheLifetime(bare),
      },
      tablePrice:
        typeof inPrice.amount === "number" &&
        typeof outPrice.amount === "number"
          ? { input: inPrice.amount, output: outPrice.amount }
          : "unknown",
      nativeTools: modelSupportsNativeTools(bare),
      images: modelSupportsImages(
        loaded.provider,
        loaded.model,
        loaded.title,
        undefined,
      ),
    },
  };
}

/** The context a field's "Not set" sentence is written for. */
export function notSetContext(
  provider: string,
  model: string,
  loaded: ModelDescription | undefined,
  written: Record<string, unknown> | undefined,
): NotSetContext {
  return { provider, model, ...modelFacts(loaded, written) };
}
