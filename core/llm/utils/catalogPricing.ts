import type { Usage } from "../..";
import {
  catalogAgeDays,
  type CatalogModel,
  type CatalogRates,
  type ModelCatalog,
} from "../openRouterCatalog";

/**
 * Prices from the downloaded OpenRouter list, as a cost source for the
 * `openrouter` provider. No I/O here (the chat window imports this): whoever
 * owns a process puts the catalogue in with `setOpenRouterCatalog` (core and
 * the terminal agent read the file, the webview asks core for it).
 *
 * Every figure computed from it is an estimate, and carries where the prices
 * came from and the date they were downloaded.
 */

/** The age after which a budget is no longer held on these prices. */
export const BUDGET_CATALOG_MAX_AGE_DAYS = 90;
/** The age after which the person is told the prices may be out of date. */
export const STALE_CATALOG_WARN_DAYS = 30;

interface Held {
  catalog: ModelCatalog;
  byId: Map<string, CatalogModel>;
  /** Older than this many days the prices are not used at all. */
  maxAgeDays: number;
}

let held: Held | undefined;

/**
 * Use `catalog` for OpenRouter prices (undefined removes them). With
 * `maxAgeDays`, a list older than that is not used: its models read as
 * unpriced, which is what a dollar budget needs so it never leans on a price
 * list nobody has looked at for months.
 */
export function setOpenRouterCatalog(
  catalog: ModelCatalog | undefined,
  opts: { maxAgeDays?: number } = {},
): void {
  held = catalog
    ? {
        catalog,
        byId: new Map(catalog.models.map((m) => [m.id, m])),
        maxAgeDays: opts.maxAgeDays ?? Infinity,
      }
    : undefined;
}

export function getOpenRouterCatalog(): ModelCatalog | undefined {
  return held?.catalog;
}

/** Why prices are not used for an id although a list is held, or undefined. */
export function catalogTooOld(now = Date.now()): number | undefined {
  if (!held) return undefined;
  const age = catalogAgeDays(held.catalog.fetchedAt, now);
  return age > held.maxAgeDays ? age : undefined;
}

/** The catalogue entry that prices `id`, when a usable list holds it with a price. */
export function catalogModelWithPrice(
  id: string,
  now = Date.now(),
): { model: CatalogModel; fetchedAt: string } | undefined {
  if (!held || catalogTooOld(now) !== undefined) return undefined;
  const model = held.byId.get(id);
  if (!model?.pricing) return undefined;
  return { model, fetchedAt: held.catalog.fetchedAt };
}

/** "2026-11-12": the date part of a catalogue's time, for labels. */
export function catalogDate(fetchedAt: string): string {
  return fetchedAt.slice(0, 10);
}

const PER_M = 1_000_000;

export interface CatalogCost {
  cost: number;
  breakdown: string;
  /** Always set: a price from this list is an estimate. */
  estimate: { source: string; fetchedAt: string };
}

/**
 * The rates for a request whose whole prompt is `promptTokens`: the base
 * rates, with those of the highest tier the prompt reaches laid over them
 * (a tier is a price for the whole request, not only for the tokens above its
 * limit). `min_prompt_tokens` is read as "at least".
 */
export function ratesFor(
  pricing: NonNullable<CatalogModel["pricing"]>,
  promptTokens: number,
): CatalogRates {
  const { overrides, ...base } = pricing;
  let rates: CatalogRates = base;
  for (const tier of overrides ?? []) {
    if (promptTokens >= tier.minPromptTokens) {
      const { minPromptTokens: _min, ...tierRates } = tier;
      rates = { ...base, ...tierRates };
    }
  }
  return rates;
}

/**
 * Cost of one request from the catalogue's prices, or undefined when the id is
 * not in a usable list. OpenRouter reports usage the OpenAI way: the prompt
 * count already holds cache reads and writes, and the completion count holds
 * the reasoning tokens.
 *
 * - tiers are chosen by the whole prompt;
 * - cache reads, 5-minute and 1-hour writes use their own rates, each falling
 *   back to the prompt rate when the list gives none;
 * - reasoning tokens stay in the completion at the completion rate, unless the
 *   list gives a non-zero reasoning rate and the response reports them;
 * - the per-request web search price is not added: a response does not say
 *   whether a search ran.
 */
export function priceFromCatalog(
  id: string,
  usage: Usage,
  now = Date.now(),
): CatalogCost | undefined {
  const hit = catalogModelWithPrice(id, now);
  if (!hit?.model.pricing) return undefined;
  const rates = ratesFor(hit.model.pricing, usage.promptTokens);
  const prompt = rates.prompt ?? 0;
  const completion = rates.completion ?? 0;

  const whole = Math.max(0, usage.promptTokens);
  const d = usage.promptTokensDetails;
  const read = Math.min(Math.max(0, d?.cachedTokens ?? 0), whole);
  const written = Math.min(Math.max(0, d?.cacheWriteTokens ?? 0), whole - read);
  const write1h = Math.min(Math.max(0, d?.cacheWriteTokens1h ?? 0), written);
  const write5m = written - write1h;
  const uncached = whole - read - written;

  const reasoning = Math.min(
    Math.max(0, usage.completionTokensDetails?.reasoningTokens ?? 0),
    Math.max(0, usage.completionTokens),
  );
  const reasoningRate =
    reasoning > 0 && (rates.internalReasoning ?? 0) > 0
      ? rates.internalReasoning!
      : completion;
  const plainOutput = Math.max(0, usage.completionTokens) - reasoning;

  const rows: Array<[string, number, number]> = [
    ["Input", uncached, prompt],
    ["Cache Read", read, rates.inputCacheRead ?? prompt],
    ["Cache Write (5m)", write5m, rates.inputCacheWrite ?? prompt],
    [
      "Cache Write (1h)",
      write1h,
      rates.inputCacheWrite1h ?? rates.inputCacheWrite ?? prompt,
    ],
    ["Output", plainOutput, completion],
    ["Reasoning", reasoning, reasoningRate],
  ];
  const parts: string[] = [];
  let total = 0;
  for (const [name, tokens, rate] of rows) {
    if (tokens <= 0) continue;
    const cost = tokens * rate;
    total += cost;
    parts.push(
      `${name}: ${tokens.toLocaleString()} tokens × $${+(rate * PER_M).toPrecision(12)}/MTok = $${cost.toFixed(6)}`,
    );
  }
  const source = "openrouter catalogue";
  const label = `Prices: ${source}, ${catalogDate(hit.fetchedAt)} (estimate)`;
  let breakdown = `Model: ${id}\n${label}\n${parts.join("\n")}`;
  if (parts.length > 1) breakdown += `\nTotal: $${total.toFixed(6)}`;
  return {
    cost: total,
    breakdown,
    estimate: { source, fetchedAt: hit.fetchedAt },
  };
}

function perMillion(rate: number): string {
  return `$${+(rate * PER_M).toPrecision(4)}`;
}

/**
 * "$3 in / $15 out per MTok, prices as of 2026-11-12" for a model the
 * downloaded list prices, or undefined. For hints next to a model's name; the
 * date is the day the list was downloaded, not a statement that the prices
 * are current.
 */
export function catalogPriceNote(
  id: string,
  now = Date.now(),
): string | undefined {
  const hit = catalogModelWithPrice(id, now);
  const p = hit?.model.pricing;
  if (!hit || !p) return undefined;
  const date = `prices as of ${catalogDate(hit.fetchedAt)}`;
  if (!p.prompt && !p.completion) return `free, ${date}`;
  return `${perMillion(p.prompt ?? 0)} in / ${perMillion(p.completion ?? 0)} out per MTok, ${date}`;
}
