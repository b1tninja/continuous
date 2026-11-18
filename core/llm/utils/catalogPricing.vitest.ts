import { afterEach, describe, expect, it } from "vitest";

import { costOf } from "../../util/costOf";
import { parseOpenRouterModels, type ModelCatalog } from "../openRouterCatalog";
import { sonnetEntry } from "../openRouterCatalogFixtures";
import { calculateRequestCost } from "./calculateRequestCost";
import {
  BUDGET_CATALOG_MAX_AGE_DAYS,
  catalogTooOld,
  priceFromCatalog,
  setOpenRouterCatalog,
} from "./catalogPricing";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");

const extra = [
  {
    id: "zz/reasoner",
    name: "ZZ Reasoner",
    pricing: {
      prompt: "0.000001",
      completion: "0.000002",
      internal_reasoning: "0.00001",
    },
  },
  {
    id: "zz/plain",
    name: "ZZ Plain",
    pricing: {
      prompt: "0.000001",
      completion: "0.000002",
      internal_reasoning: "0",
    },
  },
  {
    id: "zz/model:free",
    name: "ZZ Free",
    pricing: { prompt: "0", completion: "0" },
  },
  {
    id: "zz/noprice",
    name: "ZZ No Price",
    pricing: { prompt: "-1", completion: "-1" },
  },
];

function catalogAt(fetchedAt: string): ModelCatalog {
  return {
    schemaVersion: 1,
    source: "https://openrouter.ai/api/v1/models",
    fetchedAt,
    models: parseOpenRouterModels({ data: [sonnetEntry, ...extra] }),
  };
}

const SONNET = "anthropic/claude-sonnet-4.5";

afterEach(() => setOpenRouterCatalog(undefined));

describe("openrouter cost from the downloaded catalogue", () => {
  it("prices plain input and output: 1000 x $3/MTok + 500 x $15/MTok = $0.0105", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    const r = calculateRequestCost("openrouter", SONNET, {
      promptTokens: 1000,
      completionTokens: 500,
    });
    // 1000 * 0.000003 = 0.003; 500 * 0.000015 = 0.0075
    expect(r?.cost).toBeCloseTo(0.0105, 10);
    expect(r?.estimate).toEqual({
      source: "openrouter catalogue",
      fetchedAt: "2026-11-12T00:00:00.000Z",
    });
    expect(r?.breakdown).toContain(
      "Prices: openrouter catalogue, 2026-11-12 (estimate)",
    );
  });

  it("prices cache reads and 5-minute writes at their own rates", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    // whole prompt 10,000 = 3,000 uncached + 6,000 read + 1,000 written
    // 3000 * 3e-6 = 0.009; 6000 * 3e-7 = 0.0018; 1000 * 3.75e-6 = 0.00375;
    // 200 * 15e-6 = 0.003; total 0.01755
    const r = calculateRequestCost("openrouter", SONNET, {
      promptTokens: 10_000,
      completionTokens: 200,
      promptTokensDetails: { cachedTokens: 6000, cacheWriteTokens: 1000 },
    });
    expect(r?.cost).toBeCloseTo(0.01755, 10);
  });

  it("prices a 1-hour write at the 1-hour rate", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    // whole prompt 5,000 = 3,000 uncached + 2,000 written (1,500 of them 1h)
    // 3000 * 3e-6 = 0.009; 500 * 3.75e-6 = 0.001875; 1500 * 6e-6 = 0.009;
    // 100 * 15e-6 = 0.0015; total 0.021375
    const r = calculateRequestCost("openrouter", SONNET, {
      promptTokens: 5000,
      completionTokens: 100,
      promptTokensDetails: { cacheWriteTokens: 2000, cacheWriteTokens1h: 1500 },
    });
    expect(r?.cost).toBeCloseTo(0.021375, 10);
  });

  it("applies the tier to the whole request once the prompt reaches it", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    // 250,000 whole = 150,000 uncached + 100,000 read, tier >= 200,000:
    // 150000 * 6e-6 = 0.9; 100000 * 6e-7 = 0.06; 1000 * 22.5e-6 = 0.0225
    const over = calculateRequestCost("openrouter", SONNET, {
      promptTokens: 250_000,
      completionTokens: 1000,
      promptTokensDetails: { cachedTokens: 100_000 },
    });
    expect(over?.cost).toBeCloseTo(0.9825, 10);
    // one token under the tier: base rates, 199,999 * 3e-6 = 0.599997
    const under = calculateRequestCost("openrouter", SONNET, {
      promptTokens: 199_999,
      completionTokens: 0,
    });
    expect(under?.cost).toBeCloseTo(0.599997, 10);
  });

  it("bills reasoning tokens at the reasoning rate only when the list gives a non-zero one", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    const usage = {
      promptTokens: 100,
      completionTokens: 300,
      completionTokensDetails: { reasoningTokens: 200 },
    };
    // 100 * 1e-6 = 0.0001; 100 * 2e-6 = 0.0002; 200 * 1e-5 = 0.002
    expect(
      calculateRequestCost("openrouter", "zz/reasoner", usage)?.cost,
    ).toBeCloseTo(0.0023, 10);
    // reasoning rate "0": the 300 completion tokens stay at 2e-6 = 0.0006
    expect(
      calculateRequestCost("openrouter", "zz/plain", usage)?.cost,
    ).toBeCloseTo(0.0007, 10);
  });

  it("a free model costs $0, which is a price, not unknown", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    const r = calculateRequestCost("openrouter", "zz/model:free", {
      promptTokens: 5000,
      completionTokens: 500,
    });
    expect(r?.cost).toBe(0);
  });

  it("keeps the old behaviour for an id the list does not hold", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    // Claude-style id: the Anthropic table, no estimate label
    const claude = calculateRequestCost(
      "openrouter",
      "anthropic/claude-haiku-4.5",
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
      },
    );
    expect(claude?.cost).toBeCloseTo(1, 10);
    expect(claude?.estimate).toBeUndefined();
    // anything else: unpriced
    expect(
      calculateRequestCost("openrouter", "someone/else-7b", {
        promptTokens: 10,
        completionTokens: 10,
      }),
    ).toBeNull();
    // listed without a usable price: unpriced, not zero
    expect(
      calculateRequestCost("openrouter", "zz/noprice", {
        promptTokens: 10,
        completionTokens: 10,
      }),
    ).toBeNull();
  });

  it("is unpriced with no catalogue at all", () => {
    expect(
      calculateRequestCost("openrouter", "zz/plain", {
        promptTokens: 10,
        completionTokens: 10,
      }),
    ).toBeNull();
  });
});

describe("how old a catalogue may be", () => {
  const usage = { promptTokens: 1000, completionTokens: 0 };
  const iso = (days: number) => new Date(NOW - days * DAY).toISOString();

  it("a list of any age still prices the display, dated", () => {
    setOpenRouterCatalog(catalogAt(iso(400)));
    const r = priceFromCatalog(SONNET, usage, NOW);
    expect(r?.cost).toBeCloseTo(0.003, 10);
    expect(r?.estimate.fetchedAt).toBe(iso(400));
  });

  it("with the budget limit set, a list over 90 days old prices nothing", () => {
    setOpenRouterCatalog(catalogAt(iso(91)), {
      maxAgeDays: BUDGET_CATALOG_MAX_AGE_DAYS,
    });
    expect(catalogTooOld(NOW)).toBe(91);
    expect(priceFromCatalog(SONNET, usage, NOW)).toBeUndefined();
  });

  it("with the budget limit set, a list of exactly 90 days still prices", () => {
    setOpenRouterCatalog(catalogAt(iso(90)), {
      maxAgeDays: BUDGET_CATALOG_MAX_AGE_DAYS,
    });
    expect(catalogTooOld(NOW)).toBeUndefined();
    expect(priceFromCatalog(SONNET, usage, NOW)?.cost).toBeCloseTo(0.003, 10);
  });
});

describe("costOf through the catalogue", () => {
  it("passes the estimate and says it is not a list price", () => {
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    const r = costOf(
      { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
      { provider: "openrouter", model: SONNET },
    );
    expect(r.amount).toBeCloseTo(0.0105, 10);
    expect(r.estimate?.fetchedAt).toBe("2026-11-12T00:00:00.000Z");
    expect(r.assumptions.join("\n")).toMatch(
      /Estimate from the per-token prices/,
    );
    expect(r.assumptions.join("\n")).toMatch(
      /Prices: openrouter catalogue, 2026-11-12 \(estimate\)/,
    );
  });
});

describe("session totals", () => {
  it("carry the oldest list date of the estimates in them", async () => {
    const { addRequestUsage, summarizeSessionUsage } =
      await import("./sessionUsage");
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    let s = addRequestUsage(undefined, "openrouter", SONNET, {
      promptTokens: 1000,
      completionTokens: 500,
    });
    const sum = summarizeSessionUsage(s);
    expect(sum.cost).toBeCloseTo(0.0105, 10);
    expect(sum.priceListDate).toBe("2026-11-12T00:00:00.000Z");
    // a request priced from a table adds no date
    s = addRequestUsage(s, "anthropic", "claude-sonnet-4-5", {
      promptTokens: 10,
      completionTokens: 10,
    });
    expect(summarizeSessionUsage(s).priceListDate).toBe(
      "2026-11-12T00:00:00.000Z",
    );
  });
});

describe("catalogPriceNote", () => {
  it("formats per-million prices with the download date", async () => {
    const { catalogPriceNote } = await import("./catalogPricing");
    setOpenRouterCatalog(catalogAt("2026-11-12T00:00:00.000Z"));
    expect(catalogPriceNote(SONNET)).toBe(
      "$3 in / $15 out per MTok, prices as of 2026-11-12",
    );
    expect(catalogPriceNote("zz/model:free")).toBe(
      "free, prices as of 2026-11-12",
    );
    expect(catalogPriceNote("zz/noprice")).toBeUndefined();
    expect(catalogPriceNote("nope")).toBeUndefined();
  });
});
