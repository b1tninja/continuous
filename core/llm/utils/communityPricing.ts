import type { Usage } from "../..";
import {
  MODELS_DEV_URL,
  communityRatesFor,
  modelsDevProvidersFor,
  type CommunityCatalog,
  type CommunityPrice,
} from "../communityCatalog";
import { promptTokensExcludeCache, totalInputTokens } from "./cacheStats";
import type { CostBreakdown, PriceSource } from "./calculateRequestCost";

/**
 * Prices from the community catalogue (models.dev), the last cost source:
 * `calculateRequestCost` asks here only when the person's price, the
 * provider's list and the curated tables have none. No I/O (the chat window
 * imports this); core and the terminal agent put the copy in with
 * `setCommunityCatalog`, the webview asks core for it.
 */

export const COMMUNITY_PRICE_LABEL = "community catalogue (models.dev)";

interface Held {
  catalog: CommunityCatalog;
  byKey: Map<string, CommunityPrice>;
}

let held: Held | undefined;

function key(provider: string, id: string): string {
  return `${provider}\u0000${id}`;
}

/** Use `catalog` as the last price source (undefined removes it). */
export function setCommunityCatalog(
  catalog: CommunityCatalog | undefined,
): void {
  held = catalog
    ? {
        catalog,
        byKey: new Map(catalog.prices.map((p) => [key(p.provider, p.id), p])),
      }
    : undefined;
}

export function getCommunityCatalog(): CommunityCatalog | undefined {
  return held?.catalog;
}

/** The source label of a figure priced from `catalog`. */
export function communityPriceSource(fetchedAt: string): PriceSource {
  return {
    kind: "community",
    label: COMMUNITY_PRICE_LABEL,
    url: MODELS_DEV_URL,
    asOf: fetchedAt,
  };
}

/**
 * The catalogue entry for a Continuous provider and model id. The provider is
 * mapped through `MODELS_DEV_PROVIDERS` and the id must match exactly (or
 * differ only in case): no prefix is stripped and no alias is guessed, so a
 * Bedrock `us.` profile is never priced at the in-region rate, or the other
 * way round.
 */
export function findCommunityPrice(
  provider: string,
  model: string,
): { price: CommunityPrice; fetchedAt: string } | undefined {
  if (!held) return undefined;
  for (const p of modelsDevProvidersFor(provider)) {
    const exact = held.byKey.get(key(p, model));
    if (exact) return { price: exact, fetchedAt: held.catalog.fetchedAt };
  }
  const lower = model.toLowerCase();
  if (lower === model) return undefined;
  for (const p of modelsDevProvidersFor(provider)) {
    const hit = held.byKey.get(key(p, lower));
    if (hit) return { price: hit, fetchedAt: held.catalog.fetchedAt };
  }
  return undefined;
}

const PER_M = 1_000_000;

/**
 * Cost of one request at the community catalogue's rates, or null when it has
 * no entry for the provider and model. Usage is read the way the provider
 * reports it: Anthropic and Bedrock count cache reads and writes outside the
 * prompt count, the OpenAI-style APIs inside it. A missing cache rate falls
 * back to the input rate, so the figure errs high.
 */
export function priceFromCommunity(
  provider: string,
  model: string,
  usage: Usage,
): CostBreakdown | null {
  const hit = findCommunityPrice(provider, model);
  if (!hit) return null;
  const d = usage.promptTokensDetails;
  const read = Math.max(0, d?.cachedTokens ?? 0);
  const written = Math.max(0, d?.cacheWriteTokens ?? 0);
  const whole = totalInputTokens(provider, model, usage);
  const uncached = promptTokensExcludeCache(provider, model)
    ? Math.max(0, usage.promptTokens)
    : Math.max(0, usage.promptTokens - read - written);
  const rates = communityRatesFor(hit.price, whole);

  const output = Math.max(0, usage.completionTokens);
  const reasoning =
    rates.reasoning === undefined
      ? 0
      : Math.min(
          Math.max(0, usage.completionTokensDetails?.reasoningTokens ?? 0),
          output,
        );

  const rows: Array<[string, number, number]> = [
    ["Input", uncached, rates.input],
    ["Cache Read", read, rates.cacheRead ?? rates.input],
    ["Cache Write", written, rates.cacheWrite ?? rates.input],
    ["Output", output - reasoning, rates.output],
    ["Reasoning", reasoning, rates.reasoning ?? rates.output],
  ];
  const parts: string[] = [];
  let total = 0;
  for (const [name, tokens, perM] of rows) {
    if (tokens <= 0) continue;
    const cost = (tokens * perM) / PER_M;
    total += cost;
    parts.push(
      `${name}: ${tokens.toLocaleString()} tokens × $${+perM.toPrecision(12)}/MTok = $${cost.toFixed(6)}`,
    );
  }
  const date = hit.fetchedAt.slice(0, 10);
  let breakdown = `Model: ${model}\nPrices: ${COMMUNITY_PRICE_LABEL}, ${date} (estimate; ${hit.price.provider}/${hit.price.id})\n${parts.join("\n")}`;
  if (parts.length > 1) breakdown += `\nTotal: $${total.toFixed(6)}`;
  return {
    cost: total,
    breakdown,
    priceSource: communityPriceSource(hit.fetchedAt),
  };
}
