/**
 * The public OpenRouter model list (`https://openrouter.ai/api/v1/models`):
 * how it is read, and the shape it is kept in on this computer. This file has
 * no I/O, so the chat window can import it; the cache file is read and written
 * by `modelCatalogStore.ts`, in core only.
 *
 * Only public catalogue data is kept: ids, names, sizes, tool support and
 * prices. Prices are USD per token (per request for `webSearch`), parsed from
 * the decimal strings the endpoint returns.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_SCHEMA_VERSION = 1;
/** The largest list that is accepted from the network or read from disk. */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 5000;

/** USD per token, except `webSearch` (USD per request). */
export interface CatalogRates {
  prompt?: number;
  completion?: number;
  inputCacheRead?: number;
  inputCacheWrite?: number;
  inputCacheWrite1h?: number;
  internalReasoning?: number;
  image?: number;
  audio?: number;
  webSearch?: number;
}

/** Rates that replace the base rates once a prompt reaches `minPromptTokens`. */
export interface CatalogTier extends CatalogRates {
  minPromptTokens: number;
}

export interface CatalogPricing extends CatalogRates {
  overrides?: CatalogTier[];
}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  supportsTools: boolean;
  /** Absent when the endpoint gave no usable prompt and completion price. */
  pricing?: CatalogPricing;
}

export interface ModelCatalog {
  schemaVersion: number;
  /** The URL the list came from. */
  source: string;
  /** ISO 8601 time the list was downloaded. */
  fetchedAt: string;
  models: CatalogModel[];
}

const RATE_FIELDS: Record<keyof CatalogRates, string> = {
  prompt: "prompt",
  completion: "completion",
  inputCacheRead: "input_cache_read",
  inputCacheWrite: "input_cache_write",
  inputCacheWrite1h: "input_cache_write_1h",
  internalReasoning: "internal_reasoning",
  image: "image",
  audio: "audio",
  webSearch: "web_search",
};

/**
 * A price from the endpoint: a decimal string (or number). "-1" means the
 * price depends on the route (openrouter/auto) and is not a price.
 */
function parsePrice(value: unknown): number | undefined {
  const n =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readRates(
  raw: Record<string, unknown>,
  keyOf: (field: keyof CatalogRates) => string,
): CatalogRates {
  const out: CatalogRates = {};
  for (const field of Object.keys(RATE_FIELDS) as (keyof CatalogRates)[]) {
    const price = parsePrice(raw[keyOf(field)]);
    if (price !== undefined) out[field] = price;
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.floor(v)
    : undefined;
}

/** Prices from an endpoint entry; undefined without a prompt and completion price. */
function parsePricing(raw: unknown): CatalogPricing | undefined {
  if (!isRecord(raw)) return undefined;
  const base = readRates(raw, (f) => RATE_FIELDS[f]);
  if (base.prompt === undefined || base.completion === undefined) {
    return undefined;
  }
  const pricing: CatalogPricing = { ...base };
  if (Array.isArray(raw.overrides)) {
    const tiers: CatalogTier[] = [];
    for (const t of raw.overrides) {
      if (!isRecord(t)) continue;
      const min = positiveInt(t.min_prompt_tokens);
      if (min === undefined) continue;
      tiers.push({
        minPromptTokens: min,
        ...readRates(t, (f) => RATE_FIELDS[f]),
      });
    }
    if (tiers.length) {
      pricing.overrides = tiers.sort(
        (a, b) => a.minPromptTokens - b.minPromptTokens,
      );
    }
  }
  return pricing;
}

/** The models in a response body of the OpenRouter list endpoint. */
export function parseOpenRouterModels(body: unknown): CatalogModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  const models: CatalogModel[] = [];
  for (const m of body.data.slice(0, MAX_MODELS)) {
    if (!isRecord(m) || typeof m.id !== "string" || !m.id) continue;
    if (typeof m.name !== "string" || !m.name) continue;
    const top = isRecord(m.top_provider) ? m.top_provider : {};
    const params = Array.isArray(m.supported_parameters)
      ? m.supported_parameters
      : [];
    const pricing = parsePricing(m.pricing);
    models.push({
      id: m.id,
      name: m.name,
      ...(positiveInt(m.context_length)
        ? { contextLength: positiveInt(m.context_length) }
        : {}),
      ...(positiveInt(top.max_completion_tokens)
        ? { maxCompletionTokens: positiveInt(top.max_completion_tokens) }
        : {}),
      supportsTools: params.includes("tools"),
      ...(pricing ? { pricing } : {}),
    });
  }
  return models;
}

function validRates(raw: unknown): CatalogRates | undefined {
  if (!isRecord(raw)) return undefined;
  const out: CatalogRates = {};
  for (const field of Object.keys(RATE_FIELDS) as (keyof CatalogRates)[]) {
    const v = raw[field];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
    out[field] = v;
  }
  return out;
}

function validModel(raw: unknown): CatalogModel | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  if (typeof raw.name !== "string") return undefined;
  const model: CatalogModel = {
    id: raw.id,
    name: raw.name,
    supportsTools: raw.supportsTools === true,
  };
  if (positiveInt(raw.contextLength)) {
    model.contextLength = positiveInt(raw.contextLength);
  }
  if (positiveInt(raw.maxCompletionTokens)) {
    model.maxCompletionTokens = positiveInt(raw.maxCompletionTokens);
  }
  if (raw.pricing !== undefined) {
    const rates = validRates(raw.pricing);
    if (
      !rates ||
      rates.prompt === undefined ||
      rates.completion === undefined
    ) {
      return undefined;
    }
    const pricing: CatalogPricing = rates;
    const tiers = (raw.pricing as Record<string, unknown>).overrides;
    if (tiers !== undefined) {
      if (!Array.isArray(tiers)) return undefined;
      pricing.overrides = [];
      for (const t of tiers) {
        const tierRates = validRates(t);
        const min = isRecord(t) ? positiveInt(t.minPromptTokens) : undefined;
        if (!tierRates || min === undefined) return undefined;
        pricing.overrides.push({ minPromptTokens: min, ...tierRates });
      }
    }
    model.pricing = pricing;
  }
  return model;
}

/**
 * A catalogue read from disk, or undefined when it is not one this version
 * understands: not JSON-shaped, another schema version, no usable date or no
 * usable model. Entries that fail validation are dropped, not repaired.
 */
export function validateCatalog(raw: unknown): ModelCatalog | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) return undefined;
  if (typeof raw.source !== "string" || typeof raw.fetchedAt !== "string") {
    return undefined;
  }
  const time = Date.parse(raw.fetchedAt);
  // A date more than a day ahead is a clock error or a hand edit
  if (!Number.isFinite(time) || time > Date.now() + 86_400_000) {
    return undefined;
  }
  if (!Array.isArray(raw.models)) return undefined;
  const models = raw.models
    .slice(0, MAX_MODELS)
    .map(validModel)
    .filter((m): m is CatalogModel => !!m);
  if (models.length === 0) return undefined;
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: raw.source,
    fetchedAt: new Date(time).toISOString(),
    models,
  };
}

/** Whole days between an ISO date and `now`, never negative. */
export function catalogAgeDays(fetchedAt: string, now = Date.now()): number {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** The shape the provider setup list uses (`models/fetch`). */
export function catalogToFetchedModels(catalog: ModelCatalog) {
  return catalog.models.map((m) => ({
    name: m.name,
    modelId: m.id,
    icon: "openrouter.png",
    contextLength: m.contextLength,
    maxTokens: m.maxCompletionTokens,
    supportsTools: m.supportsTools,
  }));
}
