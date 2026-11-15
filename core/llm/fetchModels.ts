import type { RequestOptions } from "../index.js";
import { isNonPublicHostname } from "../util/networkAddress.js";
import { networkFetch, networkFetchWith } from "../util/networkFetch.js";

import { LLMClasses, llmFromProviderAndOptions } from "./llms/index.js";
import { listOpenAICompatibleModels } from "./localServers.js";
import {
  modelInfoFetchBlocked,
  pullOpenRouterCatalog,
} from "./modelCatalogStore.js";
import { catalogToFetchedModels } from "./openRouterCatalog.js";

export interface FetchedModel {
  name: string;
  modelId?: string;
  description?: string;
  icon?: string;
  /** The whole window, input plus output (Continue's `contextLength`). */
  contextLength?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  /** The model takes images, when the provider says so. */
  supportsImages?: boolean;
  /** Reasoning efforts the model takes (`reasoning_effort`), when the server says. */
  reasoningEfforts?: string[];
  /** The server software that listed it, when it says (Strata). */
  server?: string;
  /** ISO release date, when the provider reports one (used to rank by recency). */
  createdAt?: string;
  /** True when the provider reports the model as deprecated or retired. */
  deprecated?: boolean;
  /** ISO date the provider has scheduled the model's retirement for, when it says. */
  retiresAt?: string;
}

const OLLAMA_EXCLUDED_CAPABILITIES = ["vision", "audio", "embedding"];

const OLLAMA_ICON_MAP: Record<string, string> = {
  llama: "meta.png",
  codellama: "meta.png",
  "phind-codellama": "meta.png",
  deepseek: "deepseek.png",
  deepcoder: "deepseek.png",
  deepscaler: "deepseek.png",
  mistral: "mistral.png",
  mixtral: "mistral.png",
  codestral: "mistral.png",
  devstral: "mistral.png",
  magistral: "mistral.png",
  mathstral: "mistral.png",
  ministral: "mistral.png",
  gemma: "gemini.png",
  codegemma: "gemini.png",
  "gemini-": "gemini.png",
  qwen: "qwen.png",
  codeqwen: "qwen.png",
  qwq: "qwen.png",
  command: "cohere.png",
  aya: "cohere.png",
  granite: "ibm.png",
  nemotron: "nvidia.png",
  kimi: "moonshot.png",
  glm: "zai.svg",
  codegeex: "zai.svg",
  wizardcoder: "wizardlm.png",
  wizardlm: "wizardlm.png",
  "wizard-": "wizardlm.png",
  olmo: "allenai.png",
  tulu: "allenai.png",
  firefunction: "fireworks.png",
  "gpt-oss": "openai.png",
};

function getOllamaIcon(modelName: string): string {
  if (OLLAMA_ICON_MAP[modelName]) {
    return OLLAMA_ICON_MAP[modelName];
  }
  let bestMatch = "";
  for (const prefix of Object.keys(OLLAMA_ICON_MAP)) {
    if (modelName.startsWith(prefix) && prefix.length > bestMatch.length) {
      bestMatch = prefix;
    }
  }
  return bestMatch ? OLLAMA_ICON_MAP[bestMatch] : "ollama.png";
}

async function fetchOllamaModels(
  requestOptions?: RequestOptions,
): Promise<FetchedModel[]> {
  try {
    const response = await networkFetch(
      "https://ollama.com/library",
      undefined,
      requestOptions,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch Ollama library: ${response.status}`);
    }

    const html = await response.text();
    const models: FetchedModel[] = [];
    const items = html.split("x-test-model class=");
    const seen = new Set<string>();

    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      const nameMatch = item.match(/href="\/library\/([^"]+)"/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      if (seen.has(name)) continue;

      const capabilities: string[] = [];
      const capRegex = /x-test-capability[^>]*>([^<]+)</g;
      let capMatch;
      while ((capMatch = capRegex.exec(item)) !== null) {
        capabilities.push(capMatch[1].trim().toLowerCase());
      }
      if (
        capabilities.some((cap) => OLLAMA_EXCLUDED_CAPABILITIES.includes(cap))
      ) {
        continue;
      }

      const sizes: string[] = [];
      const sizeRegex = /x-test-size[^>]*>([^<]+)</g;
      let sizeMatch;
      while ((sizeMatch = sizeRegex.exec(item)) !== null) {
        sizes.push(sizeMatch[1].trim());
      }

      const descMatch = item.match(/<p class="max-w-lg[^"]*">([^<]+)</);
      const sizeLabel = sizes.length > 0 ? ` (${sizes.join(", ")})` : "";
      const description = descMatch
        ? descMatch[1].trim()
        : `Ollama model: ${name}${sizeLabel}`;

      seen.add(name);
      models.push({
        name,
        description,
        icon: getOllamaIcon(name),
        supportsTools: capabilities.includes("tools"),
      });
    }

    return models;
  } catch (error) {
    console.error("Error fetching Ollama library models:", error);
    return [];
  }
}

/**
 * The public OpenRouter list. Downloading it also keeps the dated copy
 * (`model-catalog/openrouter.json`), so prices are there for later without a
 * second request.
 */
async function fetchOpenRouterModels(
  requestOptions?: RequestOptions,
): Promise<FetchedModel[]> {
  const blocked = modelInfoFetchBlocked();
  if (blocked) throw new Error(blocked);
  try {
    return catalogToFetchedModels(await pullOpenRouterCatalog(requestOptions));
  } catch (error) {
    console.error("Error fetching OpenRouter models:", error);
    return [];
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Pages of 100 models read at most: a bound on a misbehaving gateway. */
const ANTHROPIC_MAX_PAGES = 10;

async function fetchAnthropicModels(
  apiKey?: string,
  apiBase?: string,
  requestOptions?: RequestOptions,
): Promise<FetchedModel[]> {
  const root = withTrailingSlash(apiBase || "https://api.anthropic.com/v1/");
  const rows: any[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page++) {
    const url = new URL("models", root);
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);
    const response = await networkFetch(
      url,
      {
        headers: {
          "x-api-key": apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
      },
      requestOptions,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch Anthropic models: ${response.status}`);
    }
    const data = await response.json();
    rows.push(...(data.data ?? []));
    // `has_more` and `last_id` are the documented cursor: `last_id` is the
    // `after_id` of the next page.
    const next: unknown = data.last_id;
    if (!data.has_more || typeof next !== "string" || next === afterId) break;
    afterId = next;
  }
  return rows.map(anthropicModelToFetched);
}

/**
 * One entry of Anthropic's `GET /v1/models` (platform.claude.com/docs/en/api/models/list):
 * `max_input_tokens` and `max_tokens` for the window, `capabilities.image_input`
 * for images, and `lifecycle` / `retires_at` for retirement. Each is used
 * only when the answer carries it, so an older API version or a gateway that
 * strips fields leaves the bundled defaults in place. Effort levels are not
 * turned into `reasoningEfforts`: those become OpenAI-style
 * `reasoning_effort` variants, which the Messages API does not take.
 */
export function anthropicModelToFetched(m: any): FetchedModel {
  const imageInput = m.capabilities?.image_input?.supported;
  const retiresAt =
    typeof m.retires_at === "string" && !Number.isNaN(Date.parse(m.retires_at))
      ? m.retires_at
      : undefined;
  return {
    name: m.display_name ?? m.id,
    modelId: m.id,
    icon: "anthropic.png",
    contextLength: windowFromInputAndOutput(
      m.max_input_tokens ?? undefined,
      m.max_tokens ?? undefined,
    ),
    maxTokens: m.max_tokens ?? undefined,
    supportsTools: true,
    ...(typeof imageInput === "boolean" ? { supportsImages: imageInput } : {}),
    createdAt: m.created_at ?? undefined,
    // `lifecycle` is only returned by newer API versions; leave unset otherwise.
    deprecated:
      typeof m.lifecycle === "string" ? m.lifecycle !== "active" : undefined,
    ...(retiresAt ? { retiresAt } : {}),
  };
}

async function fetchGeminiModels(
  apiKey?: string,
  apiBase?: string,
  requestOptions?: RequestOptions,
): Promise<FetchedModel[]> {
  const base = withTrailingSlash(
    apiBase || "https://generativelanguage.googleapis.com/v1beta/",
  );
  const url = new URL("models", base);
  url.searchParams.set("key", apiKey ?? "");
  const response = await networkFetch(url, undefined, requestOptions);
  if (!response.ok) {
    throw new Error(`Failed to fetch Gemini models: ${response.status}`);
  }
  const data = await response.json();
  return (data.models ?? [])
    .filter((m: any) => {
      const id: string = m.name?.replace("models/", "") ?? "";
      const methods: string[] = m.supportedGenerationMethods ?? [];
      return (
        !id.startsWith("gemini-2.0") &&
        !id.startsWith("gemma-") && // Gemma models are supported through Ollama, not the Gemini API
        !id.startsWith("nano-banana") &&
        !id.startsWith("lyria") &&
        methods.includes("generateContent") &&
        !methods.includes("embedContent") &&
        !methods.includes("predict") &&
        !methods.includes("predictLongRunning") &&
        !methods.includes("bidiGenerateContent") &&
        !id.includes("tts") &&
        !id.includes("image") &&
        !id.includes("robotics") &&
        !id.includes("computer-use")
      );
    })
    .map((m: any) => ({
      name: m.displayName ?? m.name?.replace("models/", ""),
      modelId: m.name?.replace("models/", ""),
      icon: "gemini.png",
      contextLength: windowFromInputAndOutput(
        m.inputTokenLimit,
        m.outputTokenLimit,
      ),
      maxTokens: m.outputTokenLimit,
      supportsTools: true,
    }));
}

async function fetchProviderModelsViaListModels(
  provider: string,
  apiKey?: string,
  apiBase?: string,
): Promise<FetchedModel[]> {
  try {
    const cls = LLMClasses.find((llm) => llm.providerName === provider);
    const defaultApiBase = cls?.defaultOptions?.apiBase;

    const llm = llmFromProviderAndOptions(provider, {
      apiKey,
      apiBase: apiBase || defaultApiBase,
      model: "",
    });
    const modelIds = await llm.listModels();
    return modelIds.map((id) => ({ name: id }));
  } catch (error: any) {
    throw new Error(
      `Failed to fetch models for ${provider}: ${error?.message ?? error}`,
    );
  }
}

/**
 * Continue's contextLength is the whole window: the prompt is pruned to
 * contextLength - maxTokens. Providers that report an input limit and an
 * output limit separately need the two added, or the input budget comes out
 * as input - output (negative for Claude models whose output limit exceeds
 * the reported input limit).
 */
export function windowFromInputAndOutput(
  input: number | undefined,
  output: number | undefined,
): number | undefined {
  if (!input) return undefined;
  return input + (output ?? 0);
}

/**
 * OpenAI-compatible servers whose `/models` list is read directly, so the
 * context window each one reports comes along with the ids.
 */
const OPENAI_COMPATIBLE_LIST_PROVIDERS = new Set(["lmstudio", "vllm"]);

function compatibleModelsBase(
  provider: string,
  apiBase?: string,
): string | undefined {
  if (provider === "openai") {
    // OpenAI itself reports no context windows; any other server may.
    if (!apiBase) return undefined;
    try {
      return new URL(apiBase).hostname === "api.openai.com"
        ? undefined
        : apiBase;
    } catch {
      return undefined; // not a URL: the generic path reports the error
    }
  }
  if (!OPENAI_COMPATIBLE_LIST_PROVIDERS.has(provider)) return undefined;
  const cls = LLMClasses.find((llm) => llm.providerName === provider);
  return apiBase || cls?.defaultOptions?.apiBase;
}

export async function fetchModels(
  provider: string,
  apiKey?: string,
  apiBase?: string,
  /** The user's top-level `requestOptions`: proxy, CA, system store, verifySsl. */
  requestOptions?: RequestOptions,
): Promise<FetchedModel[]> {
  const compatibleBase = compatibleModelsBase(provider, apiBase);
  if (compatibleBase) {
    try {
      // A server on this machine or the local network is reached directly, as
      // before: a corporate proxy cannot see it.
      let local = true;
      try {
        local = isNonPublicHostname(new URL(compatibleBase).hostname);
      } catch {
        // not a URL: the request reports it
      }
      return await listOpenAICompatibleModels(
        compatibleBase,
        apiKey,
        local ? undefined : networkFetchWith(requestOptions),
      );
    } catch (error: any) {
      throw new Error(
        `Failed to fetch models for ${provider}: ${error?.message ?? error}`,
      );
    }
  }
  switch (provider) {
    case "ollama":
      return fetchOllamaModels(requestOptions);
    case "openrouter":
      return fetchOpenRouterModels(requestOptions);
    case "anthropic":
      return fetchAnthropicModels(apiKey, apiBase, requestOptions);
    case "gemini":
      return fetchGeminiModels(apiKey, apiBase, requestOptions);
    default:
      return fetchProviderModelsViaListModels(provider, apiKey, apiBase);
  }
}
