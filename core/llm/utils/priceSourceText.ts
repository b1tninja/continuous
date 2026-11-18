import type { PriceSource } from "./calculateRequestCost";
import { tierNote } from "./calculateRequestCost";

/**
 * The "price source and date" line shown next to a cost, in every surface
 * that shows one (the chat window's usage views, the terminal agent's `/info`
 * and end-of-run summary). No I/O; the chat window imports this.
 *
 * - curated: "Prices: Anthropic list prices, as of 2026-11-02"
 * - provider: "Prices: OpenRouter model list, fetched 3 h ago"
 * - user: "Prices: your config"
 * - community: "Prices: community catalogue (models.dev), 2026-11-10 — estimate"
 */

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** "just now", "12 min ago", "3 h ago", "4 days ago"; the date when far off. */
export function formatAge(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 0) return `on ${day(iso)}`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 60) return `${days} days ago`;
  return `on ${day(iso)}`;
}

/** The text after "Prices: " for one source. */
export function describePriceSource(
  source: PriceSource,
  now = Date.now(),
): string {
  switch (source.kind) {
    case "user":
      return "your config";
    case "curated":
      return source.asOf
        ? `${source.label}, as of ${day(source.asOf)}`
        : source.label;
    case "provider":
      return source.asOf
        ? `${source.label}, fetched ${formatAge(source.asOf, now)}`
        : source.label;
    case "community":
      return `${source.label}${source.asOf ? `, ${day(source.asOf)}` : ""} — estimate`;
    default:
      return (source as PriceSource).label;
  }
}

/** "Prices: ..." for one source. */
export function formatPriceSource(
  source: PriceSource,
  now = Date.now(),
): string {
  return `Prices: ${describePriceSource(source, now)}`;
}

function sameSource(a: PriceSource, b: PriceSource): boolean {
  return a.kind === b.kind && a.label === b.label;
}

/**
 * The distinct sources of a set of figures, one per kind and label, keeping
 * the oldest date of each (a total is only as current as its oldest price).
 */
export function distinctPriceSources(
  sources: Iterable<PriceSource | undefined>,
): PriceSource[] {
  const out: PriceSource[] = [];
  for (const s of sources) {
    if (!s) continue;
    const i = out.findIndex((o) => sameSource(o, s));
    if (i < 0) {
      out.push(s);
      continue;
    }
    const prev = out[i];
    if (
      s.asOf &&
      (!prev.asOf || Date.parse(s.asOf) < Date.parse(prev.asOf ?? ""))
    ) {
      out[i] = s;
    }
  }
  return out;
}

/**
 * The lines under a cost: one "Prices: ..." line per source (sources joined
 * with "; " when there are several), then the served-tier note for each
 * non-standard tier a provider reported.
 */
export function priceSourceLines(
  sources: Iterable<PriceSource | undefined>,
  servedTiers: Iterable<string | undefined> = [],
  now = Date.now(),
): string[] {
  const distinct = distinctPriceSources(sources);
  const lines: string[] = [];
  if (distinct.length > 0) {
    lines.push(
      `Prices: ${distinct.map((s) => describePriceSource(s, now)).join("; ")}`,
    );
  }
  const tiers = new Set<string>();
  for (const t of servedTiers) if (t) tiers.add(t);
  for (const t of tiers) lines.push(tierNote(t));
  return lines;
}

/** Whether any figure was priced only from the community catalogue. */
export function hasCommunityPrice(
  sources: Iterable<PriceSource | undefined>,
): boolean {
  for (const s of sources) if (s?.kind === "community") return true;
  return false;
}
