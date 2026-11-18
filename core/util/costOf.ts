import type { Usage } from "..";
import { promptTokensExcludeCache } from "../llm/utils/cacheStats";
import {
  calculateRequestCost,
  type PriceSource,
} from "../llm/utils/calculateRequestCost";

export type { PriceSource };

/**
 * What a slice of work used, by kind (plans/cost-counter.md). `input` is the
 * input that was neither read from nor written to the cache, as
 * `ModelUsage.inputTokens` counts it, for every provider. Reasoning tokens
 * are already inside `output`: providers bill them as output and report them
 * in the completion count, so they are not a separate kind here.
 */
export interface CostUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Of `cacheWrite`, the part written with the 1-hour lifetime, when reported */
  cacheWrite1h?: number;
  /**
   * How many requests the totals cover (default 1). Prices that depend on a
   * request's prompt length (long-context tiers) are applied to the average
   * request, which is an approximation and is listed as an assumption.
   */
  requests?: number;
}

export interface CostModel {
  provider: string;
  model: string;
}

/** A price the person entered, USD per million tokens. Zero is a real answer. */
export interface UserPrice {
  input: number;
  output: number;
  /** Absent: cache reads are priced at the input rate */
  cacheRead?: number;
  /** Absent: cache writes are priced at the input rate */
  cacheWrite?: number;
}

export interface CostResult {
  /** USD, or "unknown": never a guess and never zero for a model without a price */
  amount: number | "unknown";
  /** One line per priced component, or the reason it is unknown */
  breakdown: string[];
  /** What the figure takes for granted (tier, region, aggregation) */
  assumptions: string[];
  /** Set when the prices came from a downloaded list: its source and date */
  estimate?: { source: string; fetchedAt: string };
  /**
   * Where the prices came from and as of when, for a "price source and
   * date" line next to the figure. Set whenever `amount` is a number.
   */
  priceSource?: PriceSource;
}

/** The source of a price the person entered. */
export const USER_PRICE_SOURCE: PriceSource = {
  kind: "user",
  label: "Your price",
};

const PER_M = 1_000_000;

function count(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
}

function userPriced(usage: CostUsage, price: UserPrice): CostResult {
  const rows: Array<[string, number, number]> = [
    ["Input", usage.input, price.input],
    ["Output", usage.output, price.output],
    ["Cache read", usage.cacheRead, price.cacheRead ?? price.input],
    ["Cache write", usage.cacheWrite, price.cacheWrite ?? price.input],
  ];
  let amount = 0;
  const breakdown: string[] = [];
  for (const [name, tokens, rate] of rows) {
    if (tokens <= 0) continue;
    const part = (tokens / PER_M) * rate;
    amount += part;
    breakdown.push(
      `${name}: ${tokens.toLocaleString("en-US")} tokens x $${rate}/MTok = $${part.toFixed(6)}`,
    );
  }
  return {
    amount,
    breakdown,
    assumptions: [
      "Priced at the per-million-token rates you entered, not at a list price",
    ],
    priceSource: USER_PRICE_SOURCE,
  };
}

/**
 * The cost in USD of `usage` on `model`, or "unknown". Pure. Prices come from
 * the one table the chat's cost display uses (`calculateRequestCost`); a
 * model that table does not price is unknown, not free, unless the person
 * entered a price (`options.userPrice`, which may be zero for a local model).
 */
export function costOf(
  usage: CostUsage,
  model: CostModel,
  options: { userPrice?: UserPrice } = {},
): CostResult {
  const u: CostUsage = {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    ...(usage.cacheWrite1h !== undefined
      ? { cacheWrite1h: count(usage.cacheWrite1h) }
      : {}),
  };
  if (options.userPrice) return userPriced(u, options.userPrice);

  const requests = Math.max(1, count(usage.requests) || 1);
  // One average request, scaled up: exact for everything linear in tokens,
  // and puts a per-request price tier where the average request falls
  const each = (n: number) => n / requests;
  const excludes = promptTokensExcludeCache(model.provider, model.model);
  const input = each(u.input);
  const read = each(u.cacheRead);
  const write = each(u.cacheWrite);
  const write1h =
    u.cacheWrite1h !== undefined ? each(u.cacheWrite1h) : undefined;
  const request: Usage = {
    promptTokens: excludes ? input : input + read + write,
    completionTokens: each(u.output),
    ...(read > 0 || write > 0
      ? {
          promptTokensDetails: {
            ...(read > 0 ? { cachedTokens: read } : {}),
            ...(write > 0 ? { cacheWriteTokens: write } : {}),
            ...(write1h !== undefined && write > 0
              ? {
                  cacheWriteTokens1h: write1h,
                  cacheWriteTokens5m: Math.max(0, write - write1h),
                }
              : {}),
          },
        }
      : {}),
  };
  const priced = calculateRequestCost(model.provider, model.model, request);
  if (!priced) {
    return {
      amount: "unknown",
      breakdown: [
        `No price for ${model.provider}/${model.model}: cost unknown for this model`,
      ],
      assumptions: [],
    };
  }
  const lines = priced.breakdown.split("\n");
  const assumptions = [
    priced.priceSource?.kind === "community"
      ? "Estimate from the community catalogue (models.dev), the last price source: no price you entered, provider list or curated table has this model"
      : priced.estimate
        ? "Estimate from the per-token prices OpenRouter published in the downloaded list (standard tier; web search requests are not counted)"
        : "List price, standard tier (batch, flex and fast tiers are not detected)",
    ...lines.filter((l) => l.startsWith("Prices:")),
  ];
  if (requests > 1) {
    assumptions.push(
      `${requests} requests priced as ${requests} average requests (a per-request price tier is decided by the average prompt)`,
    );
  }
  if (u.cacheWrite > 0 && u.cacheWrite1h === undefined) {
    assumptions.push(
      "Cache writes priced as 5-minute writes (lifetime not reported)",
    );
  }
  const body = lines.filter(
    (l) => !l.startsWith("Model:") && !l.startsWith("Prices:"),
  );
  return {
    amount: priced.cost * requests,
    ...(priced.estimate ? { estimate: priced.estimate } : {}),
    ...(priced.priceSource ? { priceSource: priced.priceSource } : {}),
    breakdown:
      requests > 1 ? [`Per average request (x${requests}):`, ...body] : body,
    assumptions,
  };
}

/** Adds two costs: unknown if either is unknown. */
export function addCost(
  a: number | "unknown",
  b: number | "unknown",
): number | "unknown" {
  return a === "unknown" || b === "unknown" ? "unknown" : a + b;
}

/** "$1.84", "$0.0042" for small amounts, "cost unknown" otherwise. */
export function formatCostAmount(amount: number | "unknown"): string {
  if (amount === "unknown") return "cost unknown";
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export const COST_UNKNOWN_NOTE =
  "cost unknown for this model; dollar budget not enforced";
