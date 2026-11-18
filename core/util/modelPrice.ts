import type { UserPrice } from "./costOf.js";

/**
 * A model's own price (`pricing:` on its config entry, US dollars per million
 * tokens) as the `UserPrice` that `costOf` takes. Pure and webview-safe.
 *
 * The config schema already refuses a negative or non-numeric rate; this is
 * checked again here because a config that failed validation can still load
 * with warnings, and a budget must never be held on a made-up price.
 */
export interface PricedModel {
  pricing?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
  } | null;
}

/** How a price set in the model's config entry is named next to an amount. */
export const USER_PRICE_SOURCE = "your config";

function rate(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** The price written on the model, or undefined when there is none (or it is unusable). */
export function userPriceOf(
  model: PricedModel | null | undefined,
): UserPrice | undefined {
  const p = model?.pricing;
  if (!p || typeof p !== "object") return undefined;
  const input = rate(p.input);
  const output = rate(p.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = rate(p.cacheRead);
  const cacheWrite = rate(p.cacheWrite);
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}
