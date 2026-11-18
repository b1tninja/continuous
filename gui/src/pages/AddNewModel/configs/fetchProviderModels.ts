import { ModelProviderTags } from "../../../components/modelSelection/utils";
import { IIdeMessenger } from "../../../context/IdeMessenger";
import { isLikelyChatModelId } from "../../../forms/modelListUtils";
import { ModelPackage } from "./models";
import { models } from "./models";
import { ollamaStaticModels, providers } from "./providers";
import type { CatalogModel } from "core/llm/openRouterCatalog";
import { setOpenRouterCatalog } from "core/llm/utils/catalogPricing";

interface FetchedModel {
  name: string;
  modelId?: string;
  description?: string;
  icon?: string;
  contextLength?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  reasoningEfforts?: string[];
  server?: string;
  createdAt?: string;
  deprecated?: boolean;
}

function modelParams(model: FetchedModel): Record<string, any> {
  const params: Record<string, any> = {};
  if (model.contextLength) params.contextLength = model.contextLength;
  if (model.maxTokens) {
    params.completionOptions = { maxTokens: model.maxTokens };
  }
  // Saved as catalog variants, one per effort (see catalogEntryFor)
  if (model.reasoningEfforts && model.reasoningEfforts.length > 0) {
    params.reasoningEfforts = model.reasoningEfforts;
  }
  if (model.supportsTools || model.supportsImages) {
    params.capabilities = {
      ...(model.supportsTools ? { tools: true } : {}),
      ...(model.supportsImages ? { uploadImage: true } : {}),
    };
  }
  return params;
}

function toOllamaPackage(model: FetchedModel): ModelPackage {
  return {
    title: model.name,
    description: model.description || model.name,
    refUrl: `https://ollama.com/library/${model.name}`,
    params: {
      title: model.name,
      model: model.name,
      ...(model.supportsTools ? { capabilities: { tools: true } } : {}),
    },
    isOpenSource: true,
    tags: [ModelProviderTags.Local, ModelProviderTags.OpenSource],
    providerOptions: ["ollama"],
    icon: model.icon ?? "ollama.png",
  };
}

function toOpenRouterPackage(model: FetchedModel): ModelPackage {
  const id = model.modelId ?? model.name;
  return {
    title: model.name,
    description: model.name,
    refUrl: `https://openrouter.ai/models/${id}`,
    params: {
      title: model.name,
      model: id,
      ...modelParams(model),
    },
    isOpenSource: false,
    tags: [ModelProviderTags.RequiresApiKey],
    providerOptions: ["openrouter"],
    icon: model.icon ?? "openrouter.png",
  };
}

function toGenericPackage(model: FetchedModel, provider: string): ModelPackage {
  const id = model.modelId ?? model.name;
  return {
    title: model.name,
    description: model.description || id,
    params: {
      title: model.name,
      model: id,
      ...modelParams(model),
    },
    isOpenSource: false,
    providerOptions: [provider],
    ...(model.icon ? { icon: model.icon } : {}),
    ...(model.createdAt ? { createdAt: model.createdAt } : {}),
    ...(model.deprecated ? { deprecated: true } : {}),
    ...(model.server ? { server: model.server } : {}),
  };
}

async function fetchModels(
  ideMessenger: IIdeMessenger,
  provider: string,
  apiKey?: string,
  apiBase?: string,
): Promise<FetchedModel[]> {
  const response = await ideMessenger.request("models/fetch", {
    provider,
    apiKey,
    apiBase,
  });
  if (response.status === "error" || !response.content) {
    return [];
  }
  return response.content.sort((a, b) => a.name.localeCompare(b.name));
}

/** Checklist entries for the chat models in a fetched list. */
export function fetchedToPackages(
  models: FetchedModel[],
  provider: string,
): ModelPackage[] {
  return models
    .filter((m) => isLikelyChatModelId(m.modelId ?? m.name))
    .map((m) => toGenericPackage(m, provider));
}

export async function fetchProviderModels(
  ideMessenger: IIdeMessenger,
  provider: string,
  apiKey: string,
  apiBase?: string,
): Promise<ModelPackage[]> {
  const models = await fetchModels(ideMessenger, provider, apiKey, apiBase);
  return fetchedToPackages(models, provider);
}

/** Providers whose model catalogue is a public page on a third-party host. */
export const CATALOGUE_HOSTS: Record<string, string> = {
  ollama: "ollama.com",
  openrouter: "openrouter.ai",
};

/**
 * Providers whose catalogue prompt was answered (Download or Not now) in this
 * app session. Held in memory only; nothing is persisted.
 */
/** The date (ISO) of the OpenRouter list in use, when one is. */
let openRouterListDate: string | undefined;
export const openRouterListFetchedAt = () => openRouterListDate;
const answered = new Set<string>();
export const catalogueAnswered = (id: string) => answered.has(id);
export const markCatalogueAnswered = (id: string) => void answered.add(id);
const bundled = {
  ollama: providers.ollama?.packages,
  openrouter: providers.openrouter?.packages,
};
/** Forget the answers and the downloaded lists (the bundled lists return). */
export const resetCatalogueAnswers = () => {
  answered.clear();
  openRouterListDate = undefined;
  setOpenRouterCatalog(undefined);
  if (providers.ollama && bundled.ollama) {
    providers.ollama.packages = bundled.ollama;
  }
  if (providers.openrouter && bundled.openrouter) {
    providers.openrouter.packages = bundled.openrouter;
  }
};

function catalogToFetched(models: CatalogModel[]): FetchedModel[] {
  return models.map((m) => ({
    name: m.name,
    modelId: m.id,
    icon: "openrouter.png",
    contextLength: m.contextLength,
    maxTokens: m.maxCompletionTokens,
    supportsTools: m.supportsTools,
  }));
}

function applyOpenRouterList(models: CatalogModel[], fetchedAt: string) {
  // The same list prices the usage readouts in this window
  setOpenRouterCatalog({
    schemaVersion: 1,
    source: "https://openrouter.ai/api/v1/models",
    fetchedAt,
    models,
  });
  if (!providers.openrouter) return;
  providers.openrouter.packages =
    catalogToFetched(models).map(toOpenRouterPackage);
  openRouterListDate = fetchedAt;
}

/**
 * Use the dated copy of the OpenRouter list kept on this computer, if there is
 * one. A local read in core: nothing is requested from the network.
 */
export async function loadCachedOpenRouterList(
  ideMessenger: IIdeMessenger,
): Promise<string | undefined> {
  try {
    const res = await ideMessenger.request("modelCatalog/cached", undefined);
    if (res.status !== "success" || !res.content) return undefined;
    applyOpenRouterList(res.content.models, res.content.fetchedAt);
    return res.content.fetchedAt;
  } catch {
    return undefined;
  }
}

/**
 * "Model information updates" for OpenRouter: `automatic` (core refreshes
 * the list in the background, nothing is asked), `ask` (only when asked;
 * setup offers it), `never` (only when asked; setup stays quiet), `off`
 * (never contacts openrouter.ai).
 */
export type CatalogPolicy = "automatic" | "ask" | "never" | "off";

/** The user's setting. When core cannot say, setup asks, as before. */
export async function loadCatalogPolicy(
  ideMessenger: IIdeMessenger,
): Promise<CatalogPolicy> {
  try {
    const res = await ideMessenger.request("modelCatalog/status", undefined);
    return res.status === "success" ? res.content.policy : "ask";
  } catch {
    return "ask";
  }
}

export async function saveCatalogPolicy(
  ideMessenger: IIdeMessenger,
  policy: CatalogPolicy,
): Promise<void> {
  try {
    await ideMessenger.request("modelCatalog/setPolicy", { policy });
  } catch {
    // The choice then lasts for this session only.
  }
}

/**
 * Fetch one provider's catalogue (Ollama or OpenRouter) and fold it into the
 * provider's list. This contacts a third-party host, so it runs when the
 * user presses Pull now / Download / Refresh, or (OpenRouter only, with model
 * information updates `automatic`) when OpenRouter's setup opens and no list
 * has been downloaded yet. Ollama's list is never fetched without a press.
 * Until then the bundled (or last downloaded) list stays. Returns undefined
 * on success, else a short reason (and changes nothing), e.g. when offline.
 */
export async function refreshProviderCatalogue(
  ideMessenger: IIdeMessenger,
  providerId: string,
): Promise<{ ok: true } | { ok: false; error?: string }> {
  if (!CATALOGUE_HOSTS[providerId]) return { ok: false };
  if (providerId === "openrouter") {
    // Core keeps the dated copy (names, sizes, prices) as it downloads
    try {
      const res = await ideMessenger.request("modelCatalog/pull", undefined);
      if (res.status !== "success") return { ok: false };
      if (!res.content.ok) return { ok: false, error: res.content.error };
      applyOpenRouterList(res.content.models, res.content.fetchedAt);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : undefined };
    }
  }
  let fetched: FetchedModel[];
  try {
    fetched = await fetchModels(ideMessenger, providerId);
  } catch {
    return { ok: false };
  }
  if (fetched.length === 0) return { ok: false };
  if (providerId === "ollama" && providers.ollama) {
    const popular = [
      {
        ...models.AUTODETECT,
        params: { ...models.AUTODETECT.params, title: "Ollama" },
      },
      ...ollamaStaticModels,
    ];
    const popularTitles = new Set(popular.map((p) => p.title));
    const additional = fetched
      .map(toOllamaPackage)
      .filter((p) => !popularTitles.has(p.title));
    providers.ollama.packages = [...popular, ...additional];
  }
  return { ok: true };
}
