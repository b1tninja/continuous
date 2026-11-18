import type { SessionUsage } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-11-13T12:00:00Z");

const session = (byModel: Record<string, unknown>): SessionUsage =>
  ({
    totalCost: 0.25,
    promptTokens: 1000,
    completionTokens: 100,
    byModel,
  }) as SessionUsage;

const priced = (extra: Record<string, unknown>) => ({
  provider: "p",
  model: "m",
  requests: 1,
  pricedRequests: 1,
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0.25,
  ...extra,
});

describe("formatPriceSourceLines", () => {
  it("one line per kind of source", async () => {
    const { formatPriceSourceLines } = await import("./sessionCost.js");
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { kind: "curated", label: "Anthropic list prices", asOf: "2026-11-02" },
        "Prices: Anthropic list prices, as of 2026-11-02",
      ],
      [
        {
          kind: "provider",
          label: "AWS Price List",
          asOf: "2026-11-13T09:00:00Z",
        },
        "Prices: AWS Price List, fetched 3 h ago",
      ],
      [{ kind: "user", label: "Your price" }, "Prices: your config"],
      [
        {
          kind: "community",
          label: "community catalogue (models.dev)",
          asOf: "2026-11-10T08:00:00Z",
        },
        "Prices: community catalogue (models.dev), 2026-11-10 — estimate",
      ],
    ];
    for (const [source, line] of cases) {
      expect(
        formatPriceSourceLines(
          session({ "p/m": priced({ priceSource: source }) }),
          NOW,
        ),
      ).toEqual([line]);
    }
  });

  it("adds the served-tier note, and says nothing for an unpriced session", async () => {
    const { formatPriceSourceLines } = await import("./sessionCost.js");
    const lines = formatPriceSourceLines(
      session({
        "p/m": priced({
          priceSource: { kind: "curated", label: "AWS Price List" },
          servedTier: "flex",
        }),
      }),
      NOW,
    );
    expect(lines[1]).toBe(
      "Prices: standard tier; the provider served this request at the flex tier, which is billed at a discount, so the actual charge is lower",
    );
    expect(
      formatPriceSourceLines(
        session({ "p/m": priced({ pricedRequests: 0, cost: 0 }) }),
        NOW,
      ),
    ).toEqual([]);
  });
});

const info = vi.fn();
vi.mock("./logger.js", () => ({
  logger: { info: (m: string) => info(m), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock("../session.js", () => ({
  getSessionUsage: () =>
    session({
      "mistral/mistral-large-latest": priced({
        priceSource: {
          kind: "community",
          label: "community catalogue (models.dev)",
          asOf: "2026-11-10T08:00:00Z",
        },
      }),
    }),
}));
vi.mock("../services/BackgroundJobService.js", () => ({
  backgroundJobService: {},
}));
vi.mock("../telemetry/telemetryService.js", () => ({ telemetryService: {} }));

describe("the end-of-run summary (--verbose)", () => {
  beforeEach(() => info.mockClear());

  it("prints the price source under the total cost", async () => {
    const { displaySessionUsage } = await import("./exit.js");
    const argv = process.argv;
    process.argv = [...argv, "--verbose"];
    try {
      displaySessionUsage();
    } finally {
      process.argv = argv;
    }
    const lines = info.mock.calls.map((c) => c[0]);
    const total = lines.findIndex((l) => l.startsWith("Total Cost:"));
    expect(total).toBeGreaterThan(-1);
    expect(lines[total + 1]).toBe(
      "Prices: community catalogue (models.dev), 2026-11-10 — estimate",
    );
  });
});
