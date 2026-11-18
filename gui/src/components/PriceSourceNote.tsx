import type { PriceSource } from "core/llm/utils/calculateRequestCost";
import { priceSourceLines } from "core/llm/utils/priceSourceText";

/**
 * The "price source and date" lines under a cost: "Prices: Anthropic list
 * prices, as of 2026-11-02", "Prices: OpenRouter model list, fetched 3 h ago",
 * "Prices: your config", "Prices: community catalogue (models.dev),
 * 2026-11-10 — estimate", and the served-tier note when a provider reported a
 * non-standard tier. Renders nothing when there is nothing to say. For any
 * cost readout: pass the sources of the figures it adds up.
 */
export function PriceSourceNote({
  sources,
  servedTiers = [],
  now,
  className,
}: {
  sources: readonly (PriceSource | undefined)[];
  servedTiers?: readonly (string | undefined)[];
  /** Tests: the time "fetched ... ago" is measured from. */
  now?: number;
  className?: string;
}) {
  const lines = priceSourceLines(sources, servedTiers, now ?? Date.now());
  if (lines.length === 0) return null;
  return (
    <div
      className={
        className ?? "text-xs text-[color:var(--vscode-descriptionForeground)]"
      }
      data-testid="price-source-note"
    >
      {lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}
