import { describe, expect, it } from "vitest";

import { addRequestUsage, summarizeSessionUsage } from "./sessionUsage";
import {
  ANTHROPIC_PRICE_SOURCE,
  AWS_PRICE_LIST_SOURCE,
  type PriceSource,
} from "./calculateRequestCost";
import {
  distinctPriceSources,
  formatAge,
  formatPriceSource,
  priceSourceLines,
} from "./priceSourceText";

const NOW = Date.parse("2026-11-13T12:00:00Z");

describe("formatPriceSource: one line per source kind", () => {
  it("curated: the label and the date it was checked", () => {
    expect(formatPriceSource(ANTHROPIC_PRICE_SOURCE, NOW)).toBe(
      "Prices: Anthropic list prices, as of 2026-11-02",
    );
    expect(formatPriceSource(AWS_PRICE_LIST_SOURCE, NOW)).toBe(
      "Prices: AWS Price List, us-east-1 on-demand, as of 2026-11-08",
    );
  });

  it("provider: the label and how long ago it was fetched", () => {
    const s: PriceSource = {
      kind: "provider",
      label: "OpenRouter model list",
      asOf: "2026-11-13T09:00:00Z",
    };
    expect(formatPriceSource(s, NOW)).toBe(
      "Prices: OpenRouter model list, fetched 3 h ago",
    );
  });

  it("user: your config", () => {
    expect(formatPriceSource({ kind: "user", label: "Your price" }, NOW)).toBe(
      "Prices: your config",
    );
  });

  it("community: the catalogue, its date and that it is an estimate", () => {
    const s: PriceSource = {
      kind: "community",
      label: "community catalogue (models.dev)",
      url: "https://models.dev/api.json",
      asOf: "2026-11-10T08:00:00.000Z",
    };
    expect(formatPriceSource(s, NOW)).toBe(
      "Prices: community catalogue (models.dev), 2026-11-10 — estimate",
    );
  });
});

describe("formatAge", () => {
  it("reads minutes, hours and days, and a date when far off", () => {
    expect(formatAge("2026-11-13T11:59:40Z", NOW)).toBe("just now");
    expect(formatAge("2026-11-13T11:48:00Z", NOW)).toBe("12 min ago");
    expect(formatAge("2026-11-12T10:00:00Z", NOW)).toBe("26 h ago");
    expect(formatAge("2026-11-09T12:00:00Z", NOW)).toBe("4 days ago");
    expect(formatAge("2026-06-01T00:00:00Z", NOW)).toBe("on 2026-06-01");
    expect(formatAge("not a date", NOW)).toBe("not a date");
  });
});

describe("priceSourceLines", () => {
  it("joins several sources on one line and adds the served-tier note", () => {
    expect(
      priceSourceLines(
        [ANTHROPIC_PRICE_SOURCE, undefined, ANTHROPIC_PRICE_SOURCE],
        ["flex"],
        NOW,
      ),
    ).toEqual([
      "Prices: Anthropic list prices, as of 2026-11-02",
      "Prices: standard tier; the provider served this request at the flex tier, which is billed at a discount, so the actual charge is lower",
    ]);
    expect(
      priceSourceLines(
        [ANTHROPIC_PRICE_SOURCE, { kind: "user", label: "Your price" }],
        [],
        NOW,
      ),
    ).toEqual(["Prices: Anthropic list prices, as of 2026-11-02; your config"]);
    expect(priceSourceLines([], [], NOW)).toEqual([]);
  });

  it("keeps the oldest date of one source", () => {
    const a: PriceSource = {
      kind: "provider",
      label: "OpenRouter model list",
      asOf: "2026-11-12T00:00:00Z",
    };
    const b = { ...a, asOf: "2026-11-01T00:00:00Z" };
    expect(distinctPriceSources([a, b])).toEqual([b]);
  });
});

describe("session totals carry the price source and the served tier", () => {
  it("per model and in the summary", () => {
    let s = addRequestUsage(undefined, "anthropic", "claude-sonnet-4-5", {
      promptTokens: 1000,
      completionTokens: 100,
    });
    s = addRequestUsage(s, "bedrock", "us.amazon.nova-pro-v1:0", {
      promptTokens: 1000,
      completionTokens: 100,
      response: { serviceTier: "priority" },
    });
    const anthropic = s.byModel?.["anthropic/claude-sonnet-4-5"];
    expect(anthropic?.priceSource?.kind).toBe("curated");
    const sum = summarizeSessionUsage(s);
    expect(sum.priceSources.map((p) => p.label)).toEqual([
      "Anthropic list prices",
      "AWS Price List, us-east-1 on-demand",
    ]);
    expect(sum.servedTiers).toEqual(["priority"]);
  });
});
