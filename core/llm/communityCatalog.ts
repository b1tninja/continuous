/**
 * The community model catalogue (models.dev, `https://models.dev/api.json`):
 * how it is read, which of its providers stand for which Continuous provider,
 * and the trimmed shape kept on this computer. No I/O here, so the chat window
 * can import it; the cache file is read and written by
 * `communityCatalogStore.ts`, in core only.
 *
 * models.dev is maintained by pull requests from the community (MIT). It is
 * the last place a price is looked for: after a price the person entered, a
 * list the provider publishes and the curated tables
 * (plans/research/provider-model-metadata.md, owner decision 3). Every figure
 * priced from it is labelled "community" with the date of the copy, and a
 * dollar budget is never held on it unless `--budget-allow-unpriced` is given.
 *
 * Only prices are kept: provider id, model id and per-million-token rates.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const COMMUNITY_CATALOG_SCHEMA_VERSION = 1;
/**
 * The largest answer accepted from the network. The whole catalogue was 6.1 MB
 * on 2026-11-13 (236 providers, 9,134 models); the limit leaves room to grow
 * without letting a broken or hostile answer fill memory.
 */
export const MAX_MODELS_DEV_RESPONSE_BYTES = 32 * 1024 * 1024;
/** The largest trimmed copy written to or read from disk. */
export const MAX_COMMUNITY_CATALOG_BYTES = 4 * 1024 * 1024;
/** No more entries than this are kept from one answer. */
const MAX_ENTRIES = 20_000;
/** A rate above this (USD per million tokens) is taken as a data error. */
const MAX_RATE_PER_M = 10_000;

/**
 * Continuous provider name (lower case) to the models.dev provider ids that
 * price the same service, tried in order. Only providers whose models.dev
 * entry is the provider's own first-party API are listed, and a model id must
 * match exactly: a gateway, a reseller or a deployment name (Azure) is not
 * mapped, because its price can differ from the list.
 */
export const MODELS_DEV_PROVIDERS: Readonly<Record<string, readonly string[]>> =
  {
    anthropic: ["anthropic"],
    openai: ["openai"],
    // models.dev keys Bedrock by the model or inference-profile id, with the
    // region prefix ("us.anthropic.claude-opus-4-7"), at that route's price
    bedrock: ["amazon-bedrock"],
    gemini: ["google"],
    vertexai: ["google-vertex", "google-vertex-anthropic"],
    openrouter: ["openrouter"],
    mistral: ["mistral"],
    deepseek: ["deepseek"],
    groq: ["groq"],
    xai: ["xai"],
    together: ["togetherai"],
    fireworks: ["fireworks-ai"],
    cerebras: ["cerebras"],
    deepinfra: ["deepinfra"],
    moonshot: ["moonshotai"],
    nebius: ["nebius"],
    sambanova: ["sambanova"],
    novita: ["novita-ai"],
    nvidia: ["nvidia"],
    scaleway: ["scaleway"],
    ovhcloud: ["ovhcloud"],
    cohere: ["cohere"],
    siliconflow: ["siliconflow"],
    venice: ["venice"],
    inception: ["inception"],
    minimax: ["minimax"],
    zai: ["zai"],
  };

/** USD per million tokens. */
export interface CommunityRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/** Rates for a whole request whose prompt is larger than `aboveTokens`. */
export interface CommunityTier extends CommunityRates {
  aboveTokens: number;
}

export interface CommunityPrice extends CommunityRates {
  /** models.dev provider id, such as `amazon-bedrock` */
  provider: string;
  /** models.dev model id, exactly as listed */
  id: string;
  /** Context-size tiers, smallest first */
  tiers?: CommunityTier[];
}

export interface CommunityCatalog {
  schemaVersion: number;
  /** The URL the catalogue came from. */
  source: string;
  /** ISO 8601 time the catalogue was downloaded. */
  fetchedAt: string;
  prices: CommunityPrice[];
}

function rate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_RATE_PER_M) return undefined;
  return value;
}

function ratesOf(cost: Record<string, unknown>): CommunityRates | undefined {
  const input = rate(cost.input);
  const output = rate(cost.output);
  if (input === undefined || output === undefined) return undefined;
  const out: CommunityRates = { input, output };
  const cacheRead = rate(cost.cache_read);
  const cacheWrite = rate(cost.cache_write);
  const reasoning = rate(cost.reasoning);
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  if (reasoning !== undefined) out.reasoning = reasoning;
  return out;
}

/**
 * The tiers of a `cost`, or `null` when it has a tier this code does not
 * understand (anything but a context-size tier): such a model is left
 * unpriced rather than priced at rates that may not apply.
 */
function tiersOf(cost: Record<string, unknown>): CommunityTier[] | null {
  const raw = cost.tiers;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const tiers: CommunityTier[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const tier = (t as Record<string, unknown>).tier as
      Record<string, unknown> | undefined;
    const size = tier?.size;
    if (
      tier?.type !== "context" ||
      typeof size !== "number" ||
      !Number.isFinite(size) ||
      size <= 0
    ) {
      return null;
    }
    const rates = ratesOf(t as Record<string, unknown>);
    if (!rates) return null;
    tiers.push({ ...rates, aboveTokens: size });
  }
  return tiers.sort((a, b) => a.aboveTokens - b.aboveTokens);
}

/**
 * The priced models of a models.dev answer, for the providers in
 * `MODELS_DEV_PROVIDERS` only. A model without both an input and an output
 * rate, with a rate that is not a number in range, or with a pricing tier
 * other than a context size is left out.
 */
export function parseModelsDev(body: unknown): CommunityPrice[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const wanted = new Set(Object.values(MODELS_DEV_PROVIDERS).flat());
  const prices: CommunityPrice[] = [];
  for (const [providerId, provider] of Object.entries(
    body as Record<string, unknown>,
  )) {
    if (!wanted.has(providerId)) continue;
    const models = (provider as { models?: unknown } | null)?.models;
    if (!models || typeof models !== "object") continue;
    for (const [key, model] of Object.entries(
      models as Record<string, unknown>,
    )) {
      if (prices.length >= MAX_ENTRIES) return prices;
      if (!model || typeof model !== "object") continue;
      const m = model as Record<string, unknown>;
      const id = typeof m.id === "string" && m.id ? m.id : key;
      if (id.length > 300) continue;
      const cost = m.cost;
      if (!cost || typeof cost !== "object") continue;
      const rates = ratesOf(cost as Record<string, unknown>);
      if (!rates) continue;
      const tiers = tiersOf(cost as Record<string, unknown>);
      if (tiers === null) continue;
      prices.push({
        provider: providerId,
        id,
        ...rates,
        ...(tiers.length > 0 ? { tiers } : {}),
      });
    }
  }
  return prices;
}

function validRates(r: unknown): r is CommunityRates {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  const opt = (v: unknown) => v === undefined || rate(v) !== undefined;
  return (
    rate(x.input) !== undefined &&
    rate(x.output) !== undefined &&
    opt(x.cacheRead) &&
    opt(x.cacheWrite) &&
    opt(x.reasoning)
  );
}

/** A copy read from disk, or undefined when it is not one this build wrote. */
export function validateCommunityCatalog(
  value: unknown,
): CommunityCatalog | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  if (c.schemaVersion !== COMMUNITY_CATALOG_SCHEMA_VERSION) return undefined;
  if (typeof c.source !== "string" || typeof c.fetchedAt !== "string") {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(c.fetchedAt))) return undefined;
  if (!Array.isArray(c.prices) || c.prices.length > MAX_ENTRIES) {
    return undefined;
  }
  for (const p of c.prices) {
    if (
      !validRates(p) ||
      typeof (p as CommunityPrice).provider !== "string" ||
      typeof (p as CommunityPrice).id !== "string"
    ) {
      return undefined;
    }
    const tiers = (p as CommunityPrice).tiers;
    if (
      tiers !== undefined &&
      (!Array.isArray(tiers) ||
        !tiers.every(
          (t) =>
            validRates(t) &&
            typeof t.aboveTokens === "number" &&
            t.aboveTokens > 0,
        ))
    ) {
      return undefined;
    }
  }
  return value as CommunityCatalog;
}

/** The models.dev provider ids for a Continuous provider; empty when unmapped. */
export function modelsDevProvidersFor(provider: string): readonly string[] {
  return MODELS_DEV_PROVIDERS[provider.toLowerCase()] ?? [];
}

/** The rates for a request whose whole prompt is `promptTokens`. */
export function communityRatesFor(
  price: CommunityPrice,
  promptTokens: number,
): CommunityRates {
  let rates: CommunityRates = price;
  for (const tier of price.tiers ?? []) {
    if (promptTokens > tier.aboveTokens) rates = tier;
  }
  return rates;
}
