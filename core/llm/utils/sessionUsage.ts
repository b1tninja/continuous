import type { ModelUsage, SessionUsage, Usage } from "../..";
import { totalInputTokens } from "./cacheStats";
import {
  calculateRequestCost,
  standardPricedServedTier,
  type PriceSource,
} from "./calculateRequestCost";
import { distinctPriceSources } from "./priceSourceText";

export const EMPTY_SESSION_USAGE: SessionUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalCost: 0,
  byModel: {},
};

export function modelUsageKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function olderEstimate(
  a: ModelUsage["priceEstimate"],
  b: ModelUsage["priceEstimate"],
): NonNullable<ModelUsage["priceEstimate"]> {
  if (!a) return b!;
  if (!b) return a;
  return Date.parse(a.fetchedAt) <= Date.parse(b.fetchedAt) ? a : b;
}

/**
 * Add one request's usage to a session's totals. Returns a new object.
 *
 * A model without a known price adds tokens but no cost, and is counted as
 * unpriced so the display can say the cost is partial instead of inventing one.
 */
export function addRequestUsage(
  session: SessionUsage | undefined,
  provider: string,
  model: string,
  usage: Usage,
  /** The request's price when the caller already has it (the terminal agent). */
  pricedAs?: ReturnType<typeof calculateRequestCost>,
): SessionUsage {
  const base = session ?? EMPTY_SESSION_USAGE;
  const key = modelUsageKey(provider, model);
  const prev: ModelUsage = base.byModel?.[key] ?? {
    provider,
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    pricedRequests: 0,
  };

  const cacheRead = usage.promptTokensDetails?.cachedTokens ?? 0;
  const cacheWrite = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
  const allInput = totalInputTokens(provider, model, usage);
  const freshInput = Math.max(0, allInput - cacheRead - cacheWrite);
  const priced =
    pricedAs === undefined
      ? calculateRequestCost(provider, model, usage)
      : pricedAs;

  const next: ModelUsage = {
    ...prev,
    requests: prev.requests + 1,
    inputTokens: prev.inputTokens + freshInput,
    outputTokens: prev.outputTokens + usage.completionTokens,
    cacheReadTokens: prev.cacheReadTokens + cacheRead,
    cacheWriteTokens: prev.cacheWriteTokens + cacheWrite,
    cost: prev.cost + (priced?.cost ?? 0),
    pricedRequests: prev.pricedRequests + (priced ? 1 : 0),
    ...(priced?.estimate || prev.priceEstimate
      ? {
          priceEstimate: olderEstimate(prev.priceEstimate, priced?.estimate),
        }
      : {}),
    ...(priced?.priceSource ? { priceSource: priced.priceSource } : {}),
    // Only a tier priced at the standard rates needs the tier note
    ...(standardPricedServedTier(priced)
      ? { servedTier: standardPricedServedTier(priced) }
      : {}),
  };

  const prevDetails = base.promptTokensDetails ?? {};
  return {
    promptTokens: base.promptTokens + usage.promptTokens,
    completionTokens: base.completionTokens + usage.completionTokens,
    promptTokensDetails: {
      ...prevDetails,
      cachedTokens: (prevDetails.cachedTokens ?? 0) + cacheRead,
      cacheWriteTokens: (prevDetails.cacheWriteTokens ?? 0) + cacheWrite,
    },
    totalCost: base.totalCost + (priced?.cost ?? 0),
    byModel: { ...base.byModel, [key]: next },
    lastRequest: {
      provider,
      model,
      inputTokens: allInput,
      outputTokens: usage.completionTokens,
    },
  };
}

export interface SessionUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  /** Estimated cost in USD, or undefined when no request could be priced. */
  cost: number | undefined;
  /** True when some requests were priced and some were not, so `cost` undercounts. */
  costIsPartial: boolean;
  /** Set when part of `cost` is an estimate from a downloaded price list: its date (ISO). */
  priceListDate?: string;
  /** Where the prices of `cost` came from, one entry per source. */
  priceSources: PriceSource[];
  /** Non-standard service tiers the providers reported serving. */
  servedTiers: string[];
}

/** Totals across every model of a session. */
export function summarizeSessionUsage(
  usage: SessionUsage | undefined,
): SessionUsageSummary {
  const models = Object.values(usage?.byModel ?? {});
  let requests = 0;
  let priced = 0;
  const sum = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
  for (const m of models) {
    requests += m.requests;
    priced += m.pricedRequests;
    sum.inputTokens += m.inputTokens;
    sum.outputTokens += m.outputTokens;
    sum.cacheReadTokens += m.cacheReadTokens;
    sum.cacheWriteTokens += m.cacheWriteTokens;
    sum.cost += m.cost;
  }
  let oldest: string | undefined;
  for (const m of models) {
    const at = m.priceEstimate?.fetchedAt;
    if (at && (!oldest || Date.parse(at) < Date.parse(oldest))) oldest = at;
  }
  const servedTiers = [
    ...new Set(models.map((m) => m.servedTier).filter((t): t is string => !!t)),
  ];
  return {
    ...sum,
    ...(oldest ? { priceListDate: oldest } : {}),
    priceSources: distinctPriceSources(models.map((m) => m.priceSource)),
    servedTiers,
    requests,
    cost: priced > 0 ? sum.cost : undefined,
    costIsPartial: priced > 0 && priced < requests,
  };
}

/** Context window use: tokens of the latest request against the model's window. */
export function contextUsage(
  usage: SessionUsage | undefined,
  contextLength: number | undefined,
): { tokens: number; limit: number; fraction: number } | undefined {
  const last = usage?.lastRequest;
  if (!last || !contextLength || contextLength <= 0) return undefined;
  const tokens = last.inputTokens + last.outputTokens;
  return {
    tokens,
    limit: contextLength,
    fraction: Math.min(1, tokens / contextLength),
  };
}

/** "$1.23", or "<$0.01" for tiny non-zero amounts. */
export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** "950", "12k", "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
