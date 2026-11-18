import type { SessionUsage } from "core/index.js";
import { priceSourceLines } from "core/llm/utils/priceSourceText.js";
import { summarizeSessionUsage } from "core/llm/utils/sessionUsage.js";

/**
 * The session's cost for a summary: "$1.234567", with " (estimate)" when part
 * of the total was priced at the fallback rate because the model has no price
 * table (SessionUsage.costEstimated). A fallback total once read $4.00 for a
 * run the AWS list priced at $2.35, with nothing to say it was a guess.
 */
export function formatSessionCost(usage: {
  totalCost: number;
  costEstimated?: boolean;
}): string {
  return `$${usage.totalCost.toFixed(6)}${usage.costEstimated ? " (estimate)" : ""}`;
}

/**
 * The "price source and date" lines under a session's cost: "Prices:
 * Anthropic list prices, as of 2026-11-02", "Prices: community catalogue
 * (models.dev), 2026-11-10 — estimate", and the served-tier note when a
 * provider reported a non-standard tier. Empty when nothing was priced.
 */
export function formatPriceSourceLines(
  usage: SessionUsage | undefined,
  now = Date.now(),
): string[] {
  const summary = summarizeSessionUsage(usage);
  if (summary.cost === undefined) return [];
  return priceSourceLines(summary.priceSources, summary.servedTiers, now);
}
