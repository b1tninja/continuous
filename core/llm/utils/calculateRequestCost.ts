import {
  normalizeClaudeModelId,
  normalizeNovaModelId,
} from "@continuedev/llm-info";
import { Usage } from "../..";
import { OPENROUTER_MODELS_URL } from "../openRouterCatalog";
import {
  getBedrockPriceList,
  priceListPricing,
  type PriceRowTier,
} from "./bedrockPriceListPricing";
import { priceFromCatalog } from "./catalogPricing";
import { priceFromCommunity } from "./communityPricing";
import {
  openAIWriteCost,
  openAIWriteRates,
  type OpenAIWriteRates,
} from "./openaiCacheWrite";

/**
 * Where a price came from, for the "price source and date" line next to a
 * cost (plans/research/provider-model-metadata.md). In order of precedence:
 * `user` (a price the person entered), `provider` (a list the provider
 * publishes and Continuous downloaded, such as OpenRouter's), `curated` (a
 * table in this code, checked by hand against the provider's pricing page on
 * `asOf`), `community` (the models.dev catalogue, the last resort; an
 * estimate, and never the basis of a dollar budget without
 * `--budget-allow-unpriced`).
 */
export interface PriceSource {
  kind: "user" | "provider" | "curated" | "community";
  /** Short name for the UI: "Anthropic list prices", "OpenRouter model list" */
  label: string;
  /** The page or file the prices were read from */
  url?: string;
  /** ISO date (or date-time) the prices were checked or downloaded */
  asOf?: string;
}

/** Anthropic's prices, as the ANTHROPIC_PRICING table carries them. */
export const ANTHROPIC_PRICE_SOURCE: PriceSource = {
  kind: "curated",
  label: "Anthropic list prices",
  url: "https://platform.claude.com/docs/en/about-claude/pricing",
  // The oldest check of a current row (the Claude 4.x rows); later rows were
  // checked on 2026-11-03, 2026-11-04 and 2026-11-10.
  asOf: "2026-11-02",
};

/** OpenAI's Standard-tier prices, as OPENAI_PRICES carries them. */
export const OPENAI_PRICE_SOURCE: PriceSource = {
  kind: "curated",
  label: "OpenAI pricing page (Standard tier)",
  url: "https://developers.openai.com/api/docs/pricing",
  asOf: "2026-11-05",
};

/** The Bedrock rows read from the AWS Price List (NOVA_PRICING, BEDROCK_PRICING). */
export const AWS_PRICE_LIST_SOURCE: PriceSource = {
  kind: "curated",
  label: "AWS Price List, us-east-1 on-demand",
  url: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json",
  asOf: "2026-11-08",
};

export interface CostBreakdown {
  cost: number;
  breakdown: string;
  /** Where the prices came from and as of when. Set on every priced result. */
  priceSource?: PriceSource;
  /**
   * The service tier the provider says served the request, when it is not
   * the standard one the prices are for (`flex`, `priority`, `batch`, ...).
   * The cost shown is then the standard-tier price, and the breakdown says
   * so.
   */
  servedTier?: string;
  /**
   * The tier the prices are for, when a downloaded list priced the served
   * tier itself (the AWS Price List's flex and priority rows). Absent means
   * the standard tier.
   */
  pricedTier?: string;
  /**
   * Set when the price came from a downloaded list rather than a table in the
   * code: where it came from and when it was downloaded. Show such a figure
   * as an estimate with that date.
   */
  estimate?: { source: string; fetchedAt: string };
}

/**
 * Anthropic list prices, USD per million tokens (MTok). The Claude 4.x rows
 * were checked against platform.claude.com/docs/en/build-with-claude/prompt-caching
 * on 2026-11-02. The Claude 3.x rows (retired models) are carried over from the
 * previous table and were not rechecked, except Haiku 3.5, which is on that
 * page. Prices change, so the figures shown in the UI are estimates.
 *
 * Cache multipliers on the base input price: 5-minute write 1.25x, 1-hour
 * write 2x, read 0.1x.
 */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number; // 5-minute write
  cacheWrite1h: number;
  cacheRead: number;
  /**
   * Prices for a request whose whole prompt (uncached input plus cache reads
   * and writes) is longer than `aboveTokens`. The higher prices apply to every
   * token of that request, not only the tokens above the limit.
   */
  longContext?: { aboveTokens: number; pricing: ModelPricing };
}

/** Cache reads cost 0.1x the input price, except on Opus 5.5 and Sonnet 5.5 (0.05x). */
function anthropicPricing(
  input: number,
  output: number,
  readMultiplier = 0.1,
): ModelPricing {
  return {
    input,
    output,
    cacheWrite: input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: input * CACHE_WRITE_1H_MULTIPLIER,
    cacheRead: input * readMultiplier,
  };
}

/**
 * Prices by model-family prefix of the normalized ID (see
 * `normalizeClaudeModelId`). The longest matching prefix wins. Entries are exact
 * versions rather than bare families (for example `claude-opus-4-1`, not
 * `claude-opus-4`) so a future version is left unpriced instead of getting an
 * older, different price.
 */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude 5 and 5.5, list prices checked 2026-11-03 at
  // platform.claude.com/docs/en/about-claude/pricing. These are list prices;
  // `findModelPricing` adds the Bedrock `us.` profile premium.
  "claude-opus-5-5": anthropicPricing(4, 20, 0.05),
  "claude-opus-5": anthropicPricing(5, 25),
  // Fable and Mythos: $10 / $50, 5m write 1.25x, 1h write 2x. Reads are 0.025x
  // on the 5.1 releases and 0.1x on 5 (pricing page, checked 2026-11-04).
  // Fable and Mythos 5.2: $8 / $40, reads 0.025x ($0.20), 5m write $10, 1h write
  // $16 (platform.claude.com/docs/en/about-claude/pricing, read 2026-11-10).
  "claude-fable-5-2": anthropicPricing(8, 40, 0.025),
  "claude-mythos-5-2": anthropicPricing(8, 40, 0.025),
  "claude-fable-5-1": anthropicPricing(10, 50, 0.025),
  "claude-fable-5": anthropicPricing(10, 50),
  "claude-mythos-5-1": anthropicPricing(10, 50, 0.025),
  "claude-mythos-5": anthropicPricing(10, 50),
  "claude-sonnet-5-5": anthropicPricing(2, 10, 0.05),
  "claude-sonnet-5": anthropicPricing(2, 10),
  "claude-haiku-5-5": {
    ...anthropicPricing(0.1, 0.5),
    longContext: { aboveTokens: 100_000, pricing: anthropicPricing(0.5, 2.5) },
  },
  "claude-sonnet-4-6": anthropicPricing(3, 15),
  "claude-sonnet-4-5": anthropicPricing(3, 15),
  "claude-sonnet-4-2025": anthropicPricing(3, 15), // claude-sonnet-4-20250514
  "claude-opus-4-8": anthropicPricing(5, 25),
  "claude-opus-4-7": anthropicPricing(5, 25),
  "claude-opus-4-6": anthropicPricing(5, 25),
  "claude-opus-4-5": anthropicPricing(5, 25),
  "claude-opus-4-1": anthropicPricing(15, 75),
  "claude-opus-4-2025": anthropicPricing(15, 75), // claude-opus-4-20250514
  "claude-haiku-4-5": anthropicPricing(1, 5),
  "claude-3-7-sonnet": anthropicPricing(3, 15),
  "claude-3-5-sonnet": anthropicPricing(3, 15),
  "claude-3-5-haiku": anthropicPricing(0.8, 4),
  "claude-3-sonnet": anthropicPricing(3, 15),
  "claude-3-opus": anthropicPricing(15, 75),
  // Legacy Claude 3 Haiku has its own cache prices, not the 1.25x/0.1x rule.
  "claude-3-haiku": {
    input: 0.25,
    output: 1.25,
    cacheWrite: 0.3,
    cacheWrite1h: 0.5,
    cacheRead: 0.03,
  },
};

// The model ID normalizers live beside the prompt cache table in
// @continuedev/llm-info; re-exported here for the many importers.
export { normalizeClaudeModelId, normalizeNovaModelId };

/**
 * Bare names without a date that mean one specific release (the original
 * Claude 4 models). Matched exactly, never as a prefix, so a later
 * `claude-opus-4-9` is not priced as Opus 4.
 */
const EXACT_ALIASES: Record<string, string> = {
  "claude-sonnet-4": "claude-sonnet-4-2025",
  "claude-opus-4": "claude-opus-4-2025",
};

/**
 * True when what follows a matched prefix is a further minor version (`-6` in
 * `claude-sonnet-5-6`) rather than a date (`-20250929`) or a suffix. A
 * `claude-sonnet-5` entry must not price a later `claude-sonnet-5-6`.
 */
function continuesWithMinorVersion(rest: string): boolean {
  return /^-\d{1,2}(?:-|$)/.test(rest);
}

/**
 * Anthropic: "Regional and multi-region endpoints include a 10 percent premium
 * over global endpoints", for Claude Sonnet 4.5, Haiku 4.5, Opus 4.5 and all
 * later models; "earlier models retain their existing pricing"
 * (platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-04).
 * Measured on one week of Bedrock invocation logs: a `us.` profile billed 1.10
 * times list on every component (input, output, cache reads, both write
 * lifetimes).
 *
 * On Bedrock the endpoint type is the prefix of the model ID: the geographic
 * ones (`us.`, `eu.`, `apac.`, `jp.`, `au.`, `ca.`) carry the premium and
 * `global.` does not. `us-gov.` is GovCloud, which is priced separately, so it
 * is left at list. A bare ID with `crossRegionInference` set is prefixed later,
 * at request time, so it cannot be seen here and stays at list.
 *
 * Only `us.` was seen in billing data; the other prefixes follow the vendor's
 * statement and are not measured.
 *
 * Amazon Nova gets no factor: `NOVA_PRICING` carries the AWS Price List's
 * in-region rate, which is also what a `us.` profile bills at, and a row of
 * its own for Nova 2 Lite's cheaper `global.` profile.
 */
const BEDROCK_GEO_PROFILE_FACTOR = 1.1;
const BEDROCK_GEO_PREFIX =
  /^(?:us|eu|apac|jp|au|ca)\.(anthropic|openai|xai)\.(.+)$/i;
/** Normalized IDs of the Claude models the premium applies to: 4.5 and later. */
const REGIONAL_PREMIUM_MODELS =
  /^claude-(?:(?:opus|sonnet|haiku)-(?:4-[5-9]|[5-9])|fable|mythos)/;
/**
 * The OpenAI and xAI models whose geographic profiles carry the premium. GPT
 * 5.x and 6.x: the gateway's table bills `us.openai.gpt-5.6-sol` at $4.40 /
 * $22 against OpenAI's $4 / $20, and the same 1.1 on Terra, Luna and 6.x.
 * Grok: the AWS Price List rows `xai.grok-4.6-mantle-*-standard` are 1.1 times
 * the `-global-standard` rows (2026-11-14). GPT OSS is on-demand by its bare
 * ID and stays at list.
 */
const REGIONAL_PREMIUM_OTHER: Record<string, RegExp> = {
  openai: /^gpt-[5-9](?:[.-]|$)/i,
  xai: /^grok-/i,
};

/** The multiplier to apply to list prices for this model ID. */
export function bedrockRegionalPriceFactor(model: string): number {
  const geo = BEDROCK_GEO_PREFIX.exec(model);
  if (!geo) return 1;
  const vendor = geo[1].toLowerCase();
  if (vendor !== "anthropic") {
    return REGIONAL_PREMIUM_OTHER[vendor]?.test(geo[2])
      ? BEDROCK_GEO_PROFILE_FACTOR
      : 1;
  }
  const id = normalizeClaudeModelId(model);
  return id && REGIONAL_PREMIUM_MODELS.test(id)
    ? BEDROCK_GEO_PROFILE_FACTOR
    : 1;
}

/** Scale a price and drop the floating-point tail (3 * 1.1 is 3.3000000000000003). */
function scalePrice(price: number, factor: number): number {
  return Math.round(price * factor * 1e6) / 1e6;
}

function scalePricing(pricing: ModelPricing, factor: number): ModelPricing {
  if (factor === 1) return pricing;
  const scaled: ModelPricing = {
    input: scalePrice(pricing.input, factor),
    output: scalePrice(pricing.output, factor),
    cacheWrite: scalePrice(pricing.cacheWrite, factor),
    cacheWrite1h: scalePrice(pricing.cacheWrite1h, factor),
    cacheRead: scalePrice(pricing.cacheRead, factor),
  };
  if (pricing.longContext) {
    scaled.longContext = {
      aboveTokens: pricing.longContext.aboveTokens,
      pricing: scalePricing(pricing.longContext.pricing, factor),
    };
  }
  return scaled;
}

/**
 * The prices of a Claude model (Anthropic's list with the Bedrock regional
 * premium applied) or of one of the four Amazon Nova models that cache on
 * Bedrock (`NOVA_PRICING`); null for a model neither table lists. The chat
 * window prices its cache notices and model switches through this.
 *
 * @param inputTokens The request's whole prompt. When the model has a
 * long-context tier and the prompt is over its limit, the tier's prices are
 * returned.
 */
export function findModelPricing(
  model: string,
  inputTokens?: number,
): ModelPricing | null {
  const pricing = findListPricing(model, inputTokens);
  return pricing && scalePricing(pricing, bedrockRegionalPriceFactor(model));
}

function findListPricing(
  model: string,
  inputTokens?: number,
): ModelPricing | null {
  let id = normalizeClaudeModelId(model);
  if (!id) return findNovaPricing(model);
  id = EXACT_ALIASES[id] ?? id;
  const sortedKeys = Object.keys(ANTHROPIC_PRICING).sort(
    (a, b) => b.length - a.length,
  );
  for (const prefix of sortedKeys) {
    if (
      id.startsWith(prefix) &&
      !continuesWithMinorVersion(id.slice(prefix.length))
    ) {
      const pricing = ANTHROPIC_PRICING[prefix];
      const tier = pricing.longContext;
      if (tier && inputTokens !== undefined && inputTokens > tier.aboveTokens) {
        return tier.pricing;
      }
      return pricing;
    }
  }
  return null;
}

/**
 * Claude on any provider, and Amazon Nova on Bedrock, which report usage the
 * same way: `promptTokens` leaves out cache reads and writes, and writes may
 * be split by lifetime.
 */
function calculateCachedModelCost(
  model: string,
  usage: Usage,
  wholePromptTokens?: number,
): CostBreakdown | null {
  // The whole prompt decides the price tier. `promptTokens` leaves out the
  // cache reads and writes, so add them back, unless the caller already
  // counted the whole prompt (OpenRouter's prompt_tokens includes the cache).
  const wholePrompt =
    wholePromptTokens ??
    usage.promptTokens +
      (usage.promptTokensDetails?.cachedTokens ?? 0) +
      (usage.promptTokensDetails?.cacheWriteTokens ?? 0);
  const modelPricing = findModelPricing(model, wholePrompt);
  if (!modelPricing) {
    return null; // Unknown model
  }
  const regionalFactor = bedrockRegionalPriceFactor(model);
  const note =
    regionalFactor !== 1
      ? `Prices: Anthropic list × ${regionalFactor} (Bedrock regional endpoint)`
      : undefined;
  return {
    ...priceCachedUsage(model, usage, modelPricing, note),
    priceSource: ANTHROPIC_PRICE_SOURCE,
  };
}

/**
 * Price a request whose `promptTokens` leaves out the cache (Anthropic's
 * `input_tokens`, Bedrock's `inputTokens`): uncached input at the input rate,
 * cache writes at the write rate (split by lifetime when reported), reads at
 * the read rate. A request whose whole prompt was a cache write has
 * `promptTokens` 0 and is still priced, at the write rate.
 */
function priceCachedUsage(
  model: string,
  usage: Usage,
  modelPricing: ModelPricing,
  note?: string,
): CostBreakdown {
  // Calculate costs
  const inputCost = (usage.promptTokens / 1_000_000) * modelPricing.input;
  const outputCost = (usage.completionTokens / 1_000_000) * modelPricing.output;

  // Build breakdown components
  const breakdownParts: string[] = [];

  // Input tokens breakdown
  if (usage.promptTokens > 0) {
    breakdownParts.push(
      `Input: ${usage.promptTokens.toLocaleString()} tokens × $${modelPricing.input}/MTok = $${inputCost.toFixed(6)}`,
    );
  }

  // Output tokens breakdown
  if (usage.completionTokens > 0) {
    breakdownParts.push(
      `Output: ${usage.completionTokens.toLocaleString()} tokens × $${modelPricing.output}/MTok = $${outputCost.toFixed(6)}`,
    );
  }

  // Handle prompt caching costs if available
  let cacheCost = 0;
  if (usage.promptTokensDetails) {
    const {
      cachedTokens,
      cacheWriteTokens,
      cacheWriteTokens5m,
      cacheWriteTokens1h,
    } = usage.promptTokensDetails;

    // Writes are split by lifetime when the provider reports it. Anything not
    // attributed to the 1-hour lifetime is priced as a 5-minute write.
    const writes1h = Math.min(cacheWriteTokens1h ?? 0, cacheWriteTokens ?? 0);
    const writes5m =
      cacheWriteTokens5m !== undefined && cacheWriteTokens1h !== undefined
        ? cacheWriteTokens5m
        : (cacheWriteTokens ?? 0) - writes1h;

    if (writes5m > 0) {
      const cost5m = (writes5m / 1_000_000) * modelPricing.cacheWrite;
      cacheCost += cost5m;
      breakdownParts.push(
        `Cache Write (5m): ${writes5m.toLocaleString()} tokens × $${modelPricing.cacheWrite}/MTok = $${cost5m.toFixed(6)}`,
      );
    }

    if (writes1h > 0) {
      const cost1h = (writes1h / 1_000_000) * modelPricing.cacheWrite1h;
      cacheCost += cost1h;
      breakdownParts.push(
        `Cache Write (1h): ${writes1h.toLocaleString()} tokens × $${modelPricing.cacheWrite1h}/MTok = $${cost1h.toFixed(6)}`,
      );
    }

    if (cachedTokens && cachedTokens > 0) {
      const cacheReadCost = (cachedTokens / 1_000_000) * modelPricing.cacheRead;
      cacheCost += cacheReadCost;
      breakdownParts.push(
        `Cache Read: ${cachedTokens.toLocaleString()} tokens × $${modelPricing.cacheRead}/MTok = $${cacheReadCost.toFixed(6)}`,
      );
    }
  }

  const totalCost = inputCost + outputCost + cacheCost;

  // Build final breakdown string
  let breakdown = `Model: ${model}\n`;
  if (note) {
    breakdown += `${note}\n`;
  }
  breakdown += breakdownParts.join("\n");
  if (breakdownParts.length > 1) {
    breakdown += `\nTotal: $${totalCost.toFixed(6)}`;
  }

  return {
    cost: totalCost,
    breakdown,
  };
}

/**
 * Amazon Nova on Bedrock, USD per million tokens, on-demand in-region rates
 * for US East (N. Virginia). Read from the AWS Price List API on 2026-11-08
 * (offer AmazonBedrock, region us-east-1, version 20261106184538, published
 * 2026-11-06): the `USE1-Nova*-input-tokens`, `-output-tokens`,
 * `-cache-read-input-token-count` and `-cache-write-input-token-count` rows.
 * On every Nova row a cache read is 0.25x the input price and a cache write
 * is $0.00: the tokens a request writes are billed once, as input, with no
 * surcharge. A geographic cross-region profile (`us.`, `eu.`, `apac.`) is
 * priced at these same rates: the Price List shows no regional premium for
 * Nova, and the pricing page (aws.amazon.com/bedrock/pricing, read the same
 * day) lists one price for geo cross-region and in-region. The page lists
 * Nova 2 Lite's global cross-region profile 10% lower, so `global.` has its
 * own row. Only the four models that take cache points
 * (`bedrockCachePointFields`) are here; `normalizeNovaModelId` in
 * @continuedev/llm-info names the same four.
 */
function novaPricing(input: number, output: number): ModelPricing {
  return {
    input,
    output,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cacheRead: input * 0.25,
  };
}

const NOVA_PRICING: { match: RegExp; pricing: ModelPricing }[] = [
  {
    match: /^global\.amazon\.nova-2-lite-v\d/i,
    pricing: novaPricing(0.3, 2.5),
  },
  { match: /(^|\.)amazon\.nova-2-lite-v\d/i, pricing: novaPricing(0.33, 2.75) },
  { match: /(^|\.)amazon\.nova-pro-v\d/i, pricing: novaPricing(0.8, 3.2) },
  { match: /(^|\.)amazon\.nova-lite-v\d/i, pricing: novaPricing(0.06, 0.24) },
  {
    match: /(^|\.)amazon\.nova-micro-v\d/i,
    pricing: novaPricing(0.035, 0.14),
  },
];

/** The Nova price row for a Bedrock model ID, with or without a profile prefix. */
export function findNovaPricing(model: string): ModelPricing | null {
  return NOVA_PRICING.find((row) => row.match.test(model))?.pricing ?? null;
}

/** A row of BEDROCK_PRICING: input and output only, no cache rates. */
function tokenPricing(input: number, output: number): ModelPricing {
  return { input, output, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
}

/**
 * Other model families on Bedrock, USD per million tokens, standard on-demand
 * rates for US East (N. Virginia) from the AWS Price List API (offer
 * AmazonBedrock, region us-east-1, fetched 2026-11-08): the `-input-tokens`
 * and `-output-tokens` rows. None of these families has a cache row (Bedrock
 * refuses a cachePoint on them), so cache reads and writes are priced at 0.
 * The `-mantle-...-standard` usage types carry the same prices, so the
 * bedrock-mantle provider prices through this table too. Keys are the model
 * ID without a geography prefix (`us.`, `eu.`, `apac.`, `global.`) and
 * without the `-v1:0`, `-1:0` or `-instruct-v1:0` tail, which the match
 * ignores. Nova Premier has no row: it is retired. Qwen3 Next 80B A3B has
 * only flex and priority rows in the Price List and stays unpriced.
 */
const BEDROCK_PRICING: { id: string; pricing: ModelPricing }[] = [
  { id: "deepseek.v3.2", pricing: tokenPricing(0.62, 1.85) },
  { id: "openai.gpt-oss-120b", pricing: tokenPricing(0.15, 0.6) },
  { id: "openai.gpt-oss-20b", pricing: tokenPricing(0.07, 0.3) },
  // xAI Grok: the AWS Price List's `xai.grok-4.x-mantle-*-global-standard`
  // rows (us-east-1 and us-east-2, fetched 2026-11-14); a regional profile
  // bills 1.1 times this (bedrockRegionalPriceFactor). Cache reads have their
  // own row ($0.50 per MTok for 4.6 and 4.7).
  {
    id: "xai.grok-4.7",
    pricing: { ...tokenPricing(2, 6), cacheRead: 0.5 },
  },
  {
    id: "xai.grok-4.6",
    pricing: { ...tokenPricing(2, 6), cacheRead: 0.5 },
  },
  {
    id: "mistral.mistral-large-3-675b-instruct",
    pricing: tokenPricing(0.5, 1.5),
  },
  { id: "meta.llama4-maverick-17b", pricing: tokenPricing(0.24, 0.97) },
  { id: "meta.llama4-scout-17b", pricing: tokenPricing(0.17, 0.66) },
  { id: "moonshotai.kimi-k2.5", pricing: tokenPricing(0.6, 3.0) },
  { id: "qwen.qwen3-coder-next", pricing: tokenPricing(0.5, 1.2) },
  { id: "qwen.qwen3-32b", pricing: tokenPricing(0.15, 0.6) },
  { id: "qwen.qwen3-coder-30b-a3b", pricing: tokenPricing(0.15, 0.6) },
  { id: "qwen.qwen3-vl-235b-a22b", pricing: tokenPricing(0.53, 2.66) },
  { id: "zai.glm-5", pricing: tokenPricing(1.0, 3.2) },
  { id: "minimax.minimax-m2.5", pricing: tokenPricing(0.3, 1.2) },
  { id: "nvidia.nemotron-super-3-120b", pricing: tokenPricing(0.15, 0.65) },
].map((row) => ({ ...row }));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The BEDROCK_PRICING row for a model ID: the key preceded by nothing or a
 * geography prefix, and followed by nothing or a `-`/`:` tail
 * (`us.meta.llama4-scout-17b-instruct-v1:0`, `openai.gpt-oss-120b-1:0`,
 * `deepseek.v3.2`). `deepseek.v3.2` does not match `deepseek.v3.1`.
 */
export function findBedrockPricing(model: string): ModelPricing | null {
  for (const row of BEDROCK_PRICING) {
    const match = new RegExp(`(^|\\.)${escapeRegExp(row.id)}([-:]|$)`, "i");
    if (match.test(model)) return row.pricing;
  }
  return null;
}

/**
 * Bedrock (and bedrock-mantle, which serves the same models at the same
 * prices): Nova by its own table, the other families by BEDROCK_PRICING,
 * Claude by Anthropic's list prices with the regional premium. Any other
 * Bedrock model is unpriced.
 */
function calculateBedrockCost(
  model: string,
  usage: Usage,
  mantle = false,
): CostBreakdown | null {
  const fromList = priceFromAwsPriceList(model, usage, mantle);
  if (fromList) return fromList;
  const nova = findNovaPricing(model);
  if (nova) {
    return {
      ...priceCachedUsage(
        model,
        usage,
        nova,
        "Prices: AWS Price List, us-east-1 on-demand (Amazon Nova)",
      ),
      priceSource: AWS_PRICE_LIST_SOURCE,
    };
  }
  const other = findBedrockPricing(model);
  if (other) {
    const factor = bedrockRegionalPriceFactor(model);
    return {
      ...priceCachedUsage(
        model,
        usage,
        scalePricing(other, factor),
        factor === 1
          ? "Prices: AWS Price List, us-east-1 on-demand"
          : `Prices: AWS Price List, us-east-1 on-demand × ${factor} (Bedrock regional endpoint)`,
      ),
      priceSource: AWS_PRICE_LIST_SOURCE,
    };
  }
  // OpenAI's GPT models on Bedrock (us.openai.gpt-6.1-sol and the like) bill
  // at OpenAI's list prices, times 1.1 on a regional profile; nothing priced
  // them before, so their cost showed as unknown
  const gpt = findBedrockOpenAIPricing(model);
  if (gpt) {
    const factor = bedrockRegionalPriceFactor(model);
    return {
      ...priceCachedUsage(
        model,
        usage,
        scalePricing(gpt, factor),
        factor === 1
          ? "Prices: OpenAI list (Bedrock)"
          : `Prices: OpenAI list × ${factor} (Bedrock regional endpoint)`,
      ),
      priceSource: OPENAI_PRICE_SOURCE,
    };
  }
  return calculateCachedModelCost(model, usage);
}

/**
 * OpenAI's list prices for a GPT model served by Bedrock, in Bedrock's
 * pricing shape (`promptTokens` there leaves the cache out): the model ID
 * after its `openai.` part (`us.openai.gpt-6.1-sol` -> `gpt-6.1-sol`).
 * Cache writes at OpenAI's 30-minute rate for both lifetimes Bedrock reports.
 * Null for GPT OSS (its own rows in BEDROCK_PRICING) and unlisted models.
 */
export function findBedrockOpenAIPricing(model: string): ModelPricing | null {
  const match = /(?:^|\.)openai\.(gpt-[^:]+?)(?:-v\d+)?(?::\d+)?$/i.exec(model);
  if (!match || /^gpt-oss/i.test(match[1])) return null;
  const price = openAIPriceFor(match[1]);
  if (!price) return null;
  const cacheRead = price.cachedInput ?? price.input;
  const cacheWrite = price.writes?.cacheWrite ?? price.input;
  return {
    input: price.input,
    output: price.output,
    cacheRead,
    cacheWrite,
    cacheWrite1h: cacheWrite,
  };
}

/**
 * The downloaded AWS Price List of the selected Bedrock model's region
 * (bedrockPriceList.ts), ahead of the tables above. The served tier is
 * priced at its own rows when the list has them (flex, priority); cache
 * rates the list does not carry come from the tables. Null when no list is
 * loaded or it does not price this model, and for a prompt over a
 * long-context limit, which the list's standard rows do not cover.
 */
function priceFromAwsPriceList(
  model: string,
  usage: Usage,
  mantle: boolean,
): CostBreakdown | null {
  const list = getBedrockPriceList();
  if (!list) return null;
  const curated =
    findNovaPricing(model) ??
    findBedrockPricing(model) ??
    findModelPricing(model);
  const wholePrompt =
    usage.promptTokens +
    (usage.promptTokensDetails?.cachedTokens ?? 0) +
    (usage.promptTokensDetails?.cacheWriteTokens ?? 0);
  if (curated?.longContext && wholePrompt > curated.longContext.aboveTokens) {
    return null;
  }
  const served = usage.response?.serviceTier?.toLowerCase();
  const tier: PriceRowTier =
    served === "flex" || served === "priority" ? served : "standard";
  const listed =
    priceListPricing(list, model, { tier, mantle }) ??
    (tier === "standard"
      ? undefined
      : priceListPricing(list, model, { mantle }));
  if (!listed) return null;
  const details = usage.promptTokensDetails;
  const usesCache =
    (details?.cachedTokens ?? 0) > 0 || (details?.cacheWriteTokens ?? 0) > 0;
  const cacheFromTable =
    usesCache &&
    (listed.cacheRead === undefined || listed.cacheWrite === undefined);
  const pricing: ModelPricing = {
    input: listed.input,
    output: listed.output,
    cacheRead: listed.cacheRead ?? curated?.cacheRead ?? 0,
    cacheWrite: listed.cacheWrite ?? curated?.cacheWrite ?? 0,
    cacheWrite1h:
      listed.cacheWrite1h ?? curated?.cacheWrite1h ?? listed.cacheWrite ?? 0,
  };
  const route =
    listed.route === "in-region"
      ? "in-region"
      : listed.route === "global"
        ? "global cross-region"
        : "cross-region";
  const note = `Prices: AWS Price List, ${list.region} ${route}${
    listed.tier === "standard" ? "" : `, ${listed.tier} tier`
  }, downloaded ${list.fetchedAt.slice(0, 10)}${
    cacheFromTable ? "; cache prices from the built-in table" : ""
  }`;
  return {
    ...priceCachedUsage(model, usage, pricing, note),
    priceSource: {
      kind: "provider",
      label: "AWS Price List",
      url: list.source,
      asOf: list.fetchedAt,
    },
    ...(listed.tier === "standard" ? {} : { pricedTier: listed.tier }),
  };
}

interface OpenAIPrice {
  input: number;
  /** Price of cached input; absent where the model has no cached rate. */
  cachedInput?: number;
  output: number;
  /** Cache write rates (GPT-5.6 and later only; see openaiCacheWrite.ts). */
  writes?: OpenAIWriteRates;
  /**
   * The listed prices are for prompts up to this many tokens; longer prompts
   * are billed at long-context rates the table does not carry, so no price
   * is given for them.
   */
  shortContextUpTo?: number;
}

/**
 * OpenAI Standard-tier prices per million tokens, from
 * developers.openai.com/api/docs/pricing (checked 2026-11-05). Older models
 * no longer on that page keep their previous prices.
 */
const OPENAI_PRICES: Record<string, OpenAIPrice> = {
  "gpt-6-astra": {
    input: 10,
    cachedInput: 1,
    output: 50,
    writes: openAIWriteRates(10),
  },
  "gpt-6.1-sol": {
    input: 2,
    cachedInput: 0.1,
    output: 10,
    writes: openAIWriteRates(2),
  },
  "gpt-6.1-terra": {
    input: 1,
    cachedInput: 0.05,
    output: 5,
    writes: openAIWriteRates(1),
  },
  "gpt-6-luna": {
    input: 0.1,
    cachedInput: 0.01,
    output: 0.5,
    writes: openAIWriteRates(0.1),
  },
  "gpt-6-sol": {
    input: 2,
    cachedInput: 0.2,
    output: 10,
    writes: openAIWriteRates(2),
  },
  "gpt-5.6-sol": {
    input: 4,
    cachedInput: 0.4,
    output: 20,
    writes: openAIWriteRates(4),
  },
  "gpt-5.6-terra": {
    input: 2,
    cachedInput: 0.2,
    output: 12,
    writes: openAIWriteRates(2),
  },
  "gpt-5.6-luna": {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
    writes: openAIWriteRates(0.2),
  },
  "gpt-5.5": {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    shortContextUpTo: 272_000,
  },
  "gpt-5.5-pro": { input: 30, output: 180, shortContextUpTo: 272_000 },
  "gpt-5.4": {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    shortContextUpTo: 272_000,
  },
  "gpt-5.4-pro": { input: 30, output: 180, shortContextUpTo: 272_000 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-pro": { input: 21, output: 168 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },
  "gpt-5-pro": { input: 15, output: 120 },
  "gpt-4.1": { input: 2, cachedInput: 0.5, output: 8 },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6 },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10 },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6 },
  "o3-pro": { input: 20, output: 80 },
  o3: { input: 2, cachedInput: 0.5, output: 8 },
  // Older models, no longer on the pricing page
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-3.5-turbo-0125": { input: 0.5, output: 1.5 },
  "gpt-3.5-turbo-1106": { input: 1, output: 2 },
  "gpt-3.5-turbo": { input: 1.5, output: 2 },
  "gpt-4": { input: 30, output: 60 },
};

/**
 * The price entry for a model id: a key matches the id exactly or followed by
 * a date suffix (gpt-4o-2024-08-06, gpt-4-0613). A variant the table does not
 * list (gpt-4.1-nano, gpt-5-chat-latest) gets no price rather than its
 * family's, and "gpt-5" never prices "gpt-5.5".
 */
export function openAIPriceFor(model: string): OpenAIPrice | undefined {
  const id = model.toLowerCase().replace(/^openai\//, "");
  const base = id.replace(/-(?:\d{4}-\d{2}-\d{2}|\d{4})$/, "");
  for (const key of [id, base]) {
    if (Object.hasOwn(OPENAI_PRICES, key)) return OPENAI_PRICES[key];
  }
  return undefined;
}

function calculateOpenAICost(
  model: string,
  usage: Usage,
): CostBreakdown | null {
  const price = openAIPriceFor(model);
  if (!price) return null; // Unknown model
  if (price.shortContextUpTo && usage.promptTokens > price.shortContextUpTo) {
    return null; // long-context rates are not in the table
  }

  // OpenAI's prompt_tokens includes the cached part.
  const cached = Math.min(
    usage.promptTokensDetails?.cachedTokens ?? 0,
    usage.promptTokens,
  );
  // Writes are part of the uncached input and billed at their own rate
  const write = price.writes
    ? openAIWriteCost(
        price.writes,
        Math.min(
          usage.promptTokensDetails?.cacheWriteTokens ?? 0,
          usage.promptTokens - cached,
        ),
        usage.promptTokensDetails?.cacheWriteTokens1h ?? 0,
      )
    : undefined;
  const uncached = usage.promptTokens - cached - (write?.tokens ?? 0);
  const cachedRate = price.cachedInput ?? price.input;

  const inputCost = (uncached / 1_000_000) * price.input;
  const cachedCost = (cached / 1_000_000) * cachedRate;
  const outputCost = (usage.completionTokens / 1_000_000) * price.output;

  const breakdownParts: string[] = [];
  if (uncached > 0) {
    breakdownParts.push(
      `Input: ${uncached.toLocaleString()} tokens × $${price.input}/MTok = $${inputCost.toFixed(6)}`,
    );
  }
  if (cached > 0) {
    breakdownParts.push(
      `Cached input: ${cached.toLocaleString()} tokens × $${cachedRate}/MTok = $${cachedCost.toFixed(6)}`,
    );
  }
  if (usage.completionTokens > 0) {
    breakdownParts.push(
      `Output: ${usage.completionTokens.toLocaleString()} tokens × $${price.output}/MTok = $${outputCost.toFixed(6)}`,
    );
  }

  if (write?.lines.length) breakdownParts.push(...write.lines);
  const totalCost = inputCost + cachedCost + outputCost + (write?.cost ?? 0);
  let breakdown = `Model: ${model}\n`;
  breakdown += breakdownParts.join("\n");
  if (breakdownParts.length > 1) {
    breakdown += `\nTotal: $${totalCost.toFixed(6)}`;
  }

  return { cost: totalCost, breakdown, priceSource: OPENAI_PRICE_SOURCE };
}

/**
 * OpenRouter reports usage the OpenAI way: `prompt_tokens` already includes
 * cache reads and writes, and the split is only in `prompt_tokens_details`.
 * `priceCachedUsage` bills `promptTokens` as uncached input, so those have to
 * come out first or a cached prompt is charged twice.
 */
function usageWithCacheTakenOut(usage: Usage): Usage {
  const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
  const written = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
  if (cached === 0 && written === 0) return usage;
  return {
    ...usage,
    promptTokens: Math.max(0, usage.promptTokens - cached - written),
  };
}

/**
 * Tier names that mean the standard (on-demand) tier the tables price:
 * Anthropic `standard`, Bedrock `default`, OpenAI `default` / `auto`.
 */
const STANDARD_TIERS = new Set(["standard", "default", "auto", "on_demand"]);

/** Whether `tier` is the standard (on-demand) tier the tables price. */
export function isStandardTier(tier: string | undefined): boolean {
  return !tier || STANDARD_TIERS.has(tier.toLowerCase());
}

/**
 * The served tier a cost was priced at the standard rates for, which is what
 * `tierNote` describes: the tier the provider reported, unless the prices
 * used were that tier's own (`pricedTier`, the AWS Price List's flex and
 * priority rows), in which case there is nothing to note.
 */
export function standardPricedServedTier(
  cost: Pick<CostBreakdown, "servedTier" | "pricedTier"> | null | undefined,
): string | undefined {
  const tier = cost?.servedTier;
  if (!tier) return undefined;
  return cost?.pricedTier?.toLowerCase() === tier.toLowerCase()
    ? undefined
    : tier;
}

/** What a non-standard tier means for the standard price shown. */
export function tierNote(tier: string): string {
  const t = tier.toLowerCase();
  const effect =
    t === "flex" || t === "batch"
      ? "which is billed at a discount, so the actual charge is lower"
      : t === "priority" || t === "fast"
        ? "which is billed at a premium, so the actual charge is higher"
        : t === "reserved"
          ? "which is billed by the reservation rather than per token"
          : "whose price may differ";
  return `Prices: standard tier; the provider served this request at the ${tier} tier, ${effect}`;
}

/**
 * The cost of one request, from the first source that prices the model: the
 * provider's list or the curated tables, then (with `community` left on) the
 * community catalogue, models.dev, when a copy is held
 * (`setCommunityCatalog`). A community price never replaces a better one: it
 * is only asked for when the others have none. A price the person entered
 * comes before all of these and is applied by `costOf`.
 */
export function calculateRequestCost(
  provider: string,
  model: string,
  usage: Usage,
  opts: { community?: boolean } = {},
): CostBreakdown | null {
  const priced =
    priceByProvider(provider, model, usage) ??
    (opts.community === false
      ? null
      : priceFromCommunity(provider, model, usage));
  if (!priced) return null;
  const tier = usage.response?.serviceTier;
  if (isStandardTier(tier) || !tier) return priced;
  // Priced at the served tier's own rows: nothing to correct
  if (priced.pricedTier?.toLowerCase() === tier.toLowerCase()) {
    return { ...priced, servedTier: tier };
  }
  // The note goes right under the "Model:" line, with the other "Prices:" notes
  const [first, ...rest] = priced.breakdown.split("\n");
  return {
    ...priced,
    servedTier: tier,
    breakdown: [first, tierNote(tier), ...rest].join("\n"),
  };
}

function priceByProvider(
  provider: string,
  model: string,
  usage: Usage,
): CostBreakdown | null {
  switch (provider.toLowerCase()) {
    case "bedrock":
      return calculateBedrockCost(model, usage);
    case "bedrock-mantle":
      return calculateBedrockCost(model, usage, true);
    case "anthropic":
    // Claude models served by other providers use the same list prices as an
    // estimate. Regional pricing, data residency and reseller margins can differ.
    case "vertexai":
      return calculateCachedModelCost(model, usage);
    case "openrouter": {
      // The downloaded OpenRouter prices come first when the list holds this
      // id; otherwise the Claude-style ids keep the table price below.
      const fromList = priceFromCatalog(model, usage);
      if (fromList) {
        return {
          ...fromList,
          priceSource: {
            kind: "provider",
            label: "OpenRouter model list",
            url: OPENROUTER_MODELS_URL,
            asOf: fromList.estimate.fetchedAt,
          },
        };
      }
      return calculateCachedModelCost(
        model,
        usageWithCacheTakenOut(usage),
        // prompt_tokens is already the whole prompt, cache included.
        usage.promptTokens,
      );
    }
    case "openai":
      return calculateOpenAICost(model, usage);
    default:
      return null;
  }
}
