import { loadOpenRouterPrices } from "core/llm/modelCatalogStore.js";
import { catalogAgeDays } from "core/llm/openRouterCatalog.js";
import {
  BUDGET_CATALOG_MAX_AGE_DAYS,
  STALE_CATALOG_WARN_DAYS,
  catalogDate,
  catalogModelWithPrice,
} from "core/llm/utils/catalogPricing.js";

/**
 * The OpenRouter price list on this computer, as a run sees it. Loading it is
 * a file read: nothing here contacts openrouter.ai (that is
 * `continuous models refresh`).
 */
export type PriceListStatus =
  | { state: "none" }
  | {
      /** ok: up to 30 days; stale: over 30; tooOld: over 90 */
      state: "ok" | "stale" | "tooOld";
      fetchedAt: string;
      ageDays: number;
    };

export const REFRESH_HINT = "run `continuous models refresh`";

export function priceListStatus(
  fetchedAt: string | undefined,
  now = Date.now(),
): PriceListStatus {
  if (!fetchedAt) return { state: "none" };
  const ageDays = catalogAgeDays(fetchedAt, now);
  return {
    state:
      ageDays > BUDGET_CATALOG_MAX_AGE_DAYS
        ? "tooOld"
        : ageDays > STALE_CATALOG_WARN_DAYS
          ? "stale"
          : "ok",
    fetchedAt,
    ageDays,
  };
}

/**
 * Put the downloaded prices in front of this process's cost functions. With
 * `forBudget`, a list older than 90 days is not used at all, so a dollar cap
 * is never held on prices nobody has refreshed for a season.
 */
export function loadPricesForRun(
  opts: { forBudget: boolean; now?: number; file?: string } = {
    forBudget: false,
  },
): PriceListStatus {
  const catalog = loadOpenRouterPrices({
    maxAgeDays: opts.forBudget ? BUDGET_CATALOG_MAX_AGE_DAYS : undefined,
    file: opts.file,
  });
  return priceListStatus(catalog?.fetchedAt, opts.now);
}

/** "prices from openrouter.ai as of 2026-11-12", when this model is priced from the list. */
export function priceSourceNote(model: {
  provider: string;
  model: string;
}): string | undefined {
  if (model.provider.toLowerCase() !== "openrouter") return undefined;
  const hit = catalogModelWithPrice(model.model);
  return hit
    ? `prices from openrouter.ai as of ${catalogDate(hit.fetchedAt)}`
    : undefined;
}

/** The warning for a list that may be out of date, or undefined. */
export function stalePriceWarning(status: PriceListStatus): string | undefined {
  if (status.state === "none" || status.state === "ok") return undefined;
  return `prices may be out of date: the OpenRouter list was downloaded ${status.ageDays} days ago (${catalogDate(status.fetchedAt)}); ${REFRESH_HINT}`;
}
