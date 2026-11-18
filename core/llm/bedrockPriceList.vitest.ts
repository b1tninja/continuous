import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Usage } from "..";
import {
  bedrockPriceListPath,
  bedrockPriceListUrl,
  ensureBedrockPriceList,
  fetchBedrockPriceList,
  JsonMemberScanner,
  parseBedrockOffer,
  readBedrockPriceList,
  resetBedrockPriceListState,
} from "./bedrockPriceList";
import type { ModelCatalogSettings } from "./modelCatalogStore";
import {
  classifyUsageType,
  getBedrockPriceList,
  perMillionTokens,
  priceListPricing,
  setBedrockPriceList,
  type BedrockPriceList,
} from "./utils/bedrockPriceListPricing";
import {
  AWS_PRICE_LIST_SOURCE,
  calculateRequestCost,
  standardPricedServedTier,
} from "./utils/calculateRequestCost";
import { addRequestUsage, summarizeSessionUsage } from "./utils/sessionUsage";

/**
 * A trimmed AmazonBedrock offer file for us-east-1, in the bulk file's
 * layout (formatVersion, offerCode, version, publicationDate, products keyed
 * by SKU with `attributes.usagetype`, terms.OnDemand[sku][term].priceDimensions
 * with `unit` and `pricePerUnit.USD`). Usage types follow the patterns named
 * in plans/research/provider-model-metadata.md; the prices are the ones the
 * curated tables carry, so a fallback is easy to tell apart only where a row
 * differs (Qwen3 32B on the mantle endpoint).
 */
const FIXTURE_TEXT = fs.readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "aws-price-list-bedrock-us-east-1.trimmed.json",
  ),
  "utf8",
);

const AUTOMATIC: ModelCatalogSettings = {
  policy: "automatic",
  refreshHours: 24,
};
const MANUAL: ModelCatalogSettings = { policy: "ask", refreshHours: 24 };
const OFF: ModelCatalogSettings = { policy: "off", refreshHours: 24 };

function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function usage(
  prompt: number,
  completion: number,
  extra: Partial<Usage> = {},
): Usage {
  return { promptTokens: prompt, completionTokens: completion, ...extra };
}

/** A fetch answer whose body is a Node stream, as node-fetch gives it. */
function nodeStreamResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: Readable.from(chunked(text, 777).map((c) => Buffer.from(c))),
  } as unknown as Response;
}

describe("JsonMemberScanner", () => {
  it("hands over the members of the chosen objects, across any chunk size", () => {
    const text = JSON.stringify({
      version: 'v"1',
      skip: { products: { no: 1 } },
      products: { "A\\B": { x: [1, { y: "}" }] }, C: { z: '{"' } },
      terms: { OnDemand: { A: { p: 1 } }, Reserved: { B: 2 } },
    });
    for (const size of [1, 2, 3, 7, 64, text.length]) {
      const seen: [string, string, unknown][] = [];
      const scanner = new JsonMemberScanner(
        [[], ["products"], ["terms", "OnDemand"]],
        (p, k, v) => seen.push([p.join("/"), k, v]),
      );
      for (const c of chunked(text, size)) scanner.write(c);
      scanner.end();
      expect(seen, `chunk size ${size}`).toEqual([
        ["", "version", 'v"1'],
        ["products", "A\\B", { x: [1, { y: "}" }] }],
        ["products", "C", { z: '{"' }],
        ["terms/OnDemand", "A", { p: 1 }],
      ]);
    }
  });

  it("refuses a file that ends early", () => {
    const scanner = new JsonMemberScanner([["products"]], () => {});
    scanner.write('{"products":{"A":{"x":');
    expect(() => scanner.end()).toThrow(/ended early/);
  });
});

describe("usage types and units", () => {
  it("classifies per-token usage types and skips the rest", () => {
    expect(
      classifyUsageType("USE1-NovaPro-cache-read-input-token-count"),
    ).toMatchObject({
      kind: "cacheRead",
      tier: "standard",
      route: "in-region",
      model: "NovaPro",
    });
    expect(
      classifyUsageType("USE1-Llama4-Scout-17B-output-tokens-flex"),
    ).toMatchObject({
      kind: "output",
      tier: "flex",
      model: "Llama4-Scout-17B",
    });
    expect(
      classifyUsageType("USE1-Nova2.0Lite-input-tokens-global"),
    ).toMatchObject({ kind: "input", route: "global", model: "Nova2.0Lite" });
    expect(
      classifyUsageType("USE1-Qwen3-32B-mantle-input-tokens-standard"),
    ).toMatchObject({ mantle: true, tier: "standard", model: "Qwen3-32B" });
    expect(
      classifyUsageType("USE1-NovaPro-ProvisionedThroughput-ModelUnits"),
    ).toBe(undefined);
    expect(
      classifyUsageType("USE1-NovaPro-latency-optimized-input-tokens"),
    ).toBe(undefined);
    expect(classifyUsageType("USE1-NovaCanvas-image-output")).toBe(undefined);
  });

  it("converts prices to USD per million tokens", () => {
    expect(perMillionTokens(0.0008, "1K tokens")).toBe(0.8);
    expect(perMillionTokens(0.62, "1M tokens")).toBe(0.62);
    expect(perMillionTokens(0.0000008, "Tokens")).toBe(0.8);
    expect(
      perMillionTokens(0.0008, undefined, "$0.0008 per 1K input tokens"),
    ).toBe(0.8);
    expect(perMillionTokens(20.5, "Hours")).toBe(undefined);
  });
});

describe("parseBedrockOffer", () => {
  it("keeps the per-token rows of the region with their on-demand prices", async () => {
    const list = await parseBedrockOffer(
      chunked(FIXTURE_TEXT, 1000),
      "us-east-1",
    );
    expect(list.version).toBe("20261106184538");
    expect(list.publicationDate).toBe("2026-11-06T18:45:38Z");
    const nova = list.rows.filter((r) => r.model === "Nova Pro");
    expect(nova.map((r) => [r.kind, r.usdPerMTok]).sort()).toEqual(
      [
        ["cacheRead", 0.2],
        ["cacheWrite", 0],
        ["input", 0.8],
        ["output", 3.2],
      ].sort(),
    );
    // The us-west-2 row, provisioned throughput, latency optimized and
    // image rows are not kept
    expect(list.rows.some((r) => r.usagetype.startsWith("USW2-"))).toBe(false);
    expect(
      list.rows.some((r) => /Provisioned|latency|image/i.test(r.usagetype)),
    ).toBe(false);
  });

  it("reads terms that come before products", async () => {
    const offer = JSON.parse(FIXTURE_TEXT);
    const reordered = JSON.stringify({
      terms: offer.terms,
      formatVersion: offer.formatVersion,
      products: offer.products,
    });
    const a = await parseBedrockOffer([reordered], "us-east-1");
    const b = await parseBedrockOffer([FIXTURE_TEXT], "us-east-1");
    expect(a.rows).toEqual(b.rows);
  });
});

describe("priceListPricing", () => {
  let list: BedrockPriceList;
  beforeEach(async () => {
    list = {
      ...(await parseBedrockOffer([FIXTURE_TEXT], "us-east-1")),
      source: bedrockPriceListUrl("us-east-1"),
      fetchedAt: "2026-11-12T00:00:00.000Z",
    };
  });

  it("matches model IDs with and without profile prefixes", () => {
    expect(priceListPricing(list, "amazon.nova-pro-v1:0")).toMatchObject({
      input: 0.8,
      output: 3.2,
      cacheRead: 0.2,
      cacheWrite: 0,
    });
    expect(
      priceListPricing(list, "us.meta.llama4-scout-17b-instruct-v1:0"),
    ).toMatchObject({ input: 0.17, output: 0.66, route: "in-region" });
    expect(priceListPricing(list, "deepseek.v3.2")).toMatchObject({
      input: 0.62,
      output: 1.85,
    });
    expect(priceListPricing(list, "anthropic.claude-opus-5-5")).toBeUndefined();
  });

  it("uses the global rows for a global. profile", () => {
    expect(
      priceListPricing(list, "global.amazon.nova-2-lite-v1:0"),
    ).toMatchObject({
      input: 0.3,
      output: 2.5,
      route: "global",
    });
    expect(priceListPricing(list, "us.amazon.nova-2-lite-v1:0")).toMatchObject({
      input: 0.33,
      route: "in-region",
    });
  });

  it("has flex and priority rows, and mantle rows for the mantle endpoint", () => {
    const id = "meta.llama4-scout-17b-instruct-v1:0";
    expect(priceListPricing(list, id, { tier: "flex" })).toMatchObject({
      input: 0.085,
      output: 0.33,
    });
    expect(priceListPricing(list, id, { tier: "priority" })).toMatchObject({
      input: 0.2975,
    });
    expect(priceListPricing(list, "qwen.qwen3-32b-v1:0")?.input).toBe(0.15);
    expect(
      priceListPricing(list, "qwen.qwen3-32b-v1:0", { mantle: true })?.input,
    ).toBe(0.16);
  });
});

describe("calculateRequestCost with the AWS Price List", () => {
  beforeEach(async () => {
    setBedrockPriceList({
      ...(await parseBedrockOffer([FIXTURE_TEXT], "us-east-1")),
      source: bedrockPriceListUrl("us-east-1"),
      fetchedAt: "2026-11-12T00:00:00.000Z",
    });
  });
  afterEach(() => setBedrockPriceList(undefined));

  it("prices from the list ahead of the curated table, labelled with its date", () => {
    const cost = calculateRequestCost(
      "bedrock",
      "us.meta.llama4-scout-17b-instruct-v1:0",
      usage(1_000_000, 1_000_000),
    )!;
    expect(cost.cost).toBeCloseTo(0.83, 6);
    expect(cost.priceSource).toEqual({
      kind: "provider",
      label: "AWS Price List",
      url: bedrockPriceListUrl("us-east-1"),
      asOf: "2026-11-12T00:00:00.000Z",
    });
    expect(cost.breakdown).toContain(
      "Prices: AWS Price List, us-east-1 in-region, downloaded 2026-11-12",
    );
  });

  it("prices the flex tier at its own rows, without the standard-tier note", () => {
    const cost = calculateRequestCost(
      "bedrock",
      "meta.llama4-scout-17b-instruct-v1:0",
      usage(1_000_000, 1_000_000, { response: { serviceTier: "flex" } } as any),
    )!;
    expect(cost.cost).toBeCloseTo(0.415, 6);
    expect(cost.pricedTier).toBe("flex");
    expect(cost.servedTier).toBe("flex");
    expect(cost.breakdown).toContain(", flex tier,");
    expect(cost.breakdown).not.toContain("Prices: standard tier");
  });

  it("gives session totals no standard-tier note for a tier priced at its own rows", () => {
    const flex = addRequestUsage(
      undefined,
      "bedrock",
      "meta.llama4-scout-17b-instruct-v1:0",
      {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        response: { serviceTier: "flex" },
      } as any,
    );
    expect(summarizeSessionUsage(flex).servedTiers).toEqual([]);
    const priority = addRequestUsage(
      undefined,
      "bedrock",
      "amazon.nova-pro-v1:0",
      {
        promptTokens: 1_000_000,
        completionTokens: 0,
        response: { serviceTier: "priority" },
      } as any,
    );
    expect(summarizeSessionUsage(priority).servedTiers).toEqual(["priority"]);
  });

  it("standardPricedServedTier names only a tier priced at standard rates", () => {
    expect(standardPricedServedTier(undefined)).toBeUndefined();
    expect(standardPricedServedTier({})).toBeUndefined();
    expect(
      standardPricedServedTier({ servedTier: "flex", pricedTier: "flex" }),
    ).toBeUndefined();
    expect(standardPricedServedTier({ servedTier: "priority" })).toBe(
      "priority",
    );
  });

  it("keeps the standard price and the note for a tier the list does not price", () => {
    const cost = calculateRequestCost(
      "bedrock",
      "amazon.nova-pro-v1:0",
      usage(1_000_000, 0, { response: { serviceTier: "priority" } } as any),
    )!;
    expect(cost.cost).toBeCloseTo(0.8, 6);
    expect(cost.pricedTier).toBeUndefined();
    expect(cost.breakdown).toContain("Prices: standard tier");
  });

  it("prices mantle at the mantle rows", () => {
    const cost = calculateRequestCost(
      "bedrock-mantle",
      "qwen.qwen3-32b",
      usage(1_000_000, 0),
    )!;
    expect(cost.cost).toBeCloseTo(0.16, 6);
  });

  it("takes cache rates the list lacks from the table, and says so", () => {
    setBedrockPriceList({
      ...getBedrockPriceList()!,
      rows: getBedrockPriceList()!.rows.filter(
        (r) => !r.kind.startsWith("cache"),
      ),
    });
    const cost = calculateRequestCost(
      "bedrock",
      "amazon.nova-pro-v1:0",
      usage(0, 0, { promptTokensDetails: { cachedTokens: 1_000_000 } } as any),
    )!;
    expect(cost.cost).toBeCloseTo(0.2, 6);
    expect(cost.breakdown).toContain("cache prices from the built-in table");
  });

  it("falls back to the curated tables for a model the list does not price", () => {
    const claude = calculateRequestCost(
      "bedrock",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      usage(1_000_000, 0),
    )!;
    expect(claude.priceSource?.label).toBe("Anthropic list prices");
    setBedrockPriceList(undefined);
    const nova = calculateRequestCost(
      "bedrock",
      "amazon.nova-pro-v1:0",
      usage(1_000_000, 0),
    )!;
    expect(nova.priceSource).toEqual(AWS_PRICE_LIST_SOURCE);
    expect(nova.cost).toBeCloseTo(0.8, 6);
  });
});

describe("download and cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-prices-"));
    resetBedrockPriceListState();
    setBedrockPriceList(undefined);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    setBedrockPriceList(undefined);
  });

  it("streams the file from the public URL with no credentials and keeps it", async () => {
    const fetch = vi.fn(async () => nodeStreamResponse(FIXTURE_TEXT));
    const list = await fetchBedrockPriceList("us-east-1", {
      fetch,
      dir,
      now: () => new Date("2026-11-13T00:00:00Z"),
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, any];
    expect(url).toBe(
      "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json",
    );
    expect(init.headers).toEqual({
      accept: "application/json",
      "user-agent": "continuous",
    });
    expect(list.fetchedAt).toBe("2026-11-13T00:00:00.000Z");
    expect(readBedrockPriceList("us-east-1", dir)?.rows).toEqual(list.rows);
    expect(fs.readdirSync(dir)).toEqual(["bedrock-prices-us-east-1.json"]);
    // Much smaller than the offer: only the kept rows
    expect(
      fs.statSync(bedrockPriceListPath("us-east-1", dir)).size,
    ).toBeLessThan(FIXTURE_TEXT.length);
  });

  it("reads a web stream body too", async () => {
    const fetch = vi.fn(
      async () => new Response(FIXTURE_TEXT, { status: 200 }) as Response,
    );
    const list = await fetchBedrockPriceList("us-east-1", { fetch, dir });
    expect(list.rows.length).toBeGreaterThan(10);
  });

  it("stops at the size limit and keeps the old copy", async () => {
    const fetch = vi.fn(async () => nodeStreamResponse(FIXTURE_TEXT));
    await expect(
      fetchBedrockPriceList("us-east-1", { fetch, dir, maxBytes: 5000 }),
    ).rejects.toThrow(/size limit/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a body that is not a Price List, a 404 and a bad region", async () => {
    await expect(
      fetchBedrockPriceList("us-east-1", {
        fetch: async () => nodeStreamResponse('{"products":{}, "terms":{}}'),
        dir,
      }),
    ).rejects.toThrow(/no token prices/);
    await expect(
      fetchBedrockPriceList("us-east-1", {
        fetch: async () => nodeStreamResponse("<html>", 404),
        dir,
      }),
    ).rejects.toThrow(/no Bedrock prices for us-east-1/);
    await expect(
      fetchBedrockPriceList("../../etc", { fetch: vi.fn(), dir }),
    ).rejects.toThrow(/Not an AWS region/);
  });

  it("gives up after the timeout", async () => {
    const fetch = vi.fn(
      (_url: string, init: any) =>
        new Promise<Response>((_, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          ),
        ),
    );
    await expect(
      fetchBedrockPriceList("us-east-1", { fetch, dir, timeoutMs: 20 }),
    ).rejects.toThrow(/took too long/);
  });

  describe("ensureBedrockPriceList under the setting", () => {
    const fresh = () => new Date("2026-11-13T00:00:00Z");

    it("off: requests nothing and does not use the kept copy", async () => {
      await fetchBedrockPriceList("us-east-1", {
        fetch: async () => nodeStreamResponse(FIXTURE_TEXT),
        dir,
      });
      const fetch = vi.fn();
      const list = await ensureBedrockPriceList(
        "us-east-1",
        "test-connection",
        {
          settings: OFF,
          fetch,
          dir,
        },
      );
      expect(list).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(getBedrockPriceList()).toBeUndefined();
    });

    it("reuses a copy younger than the refresh interval", async () => {
      await fetchBedrockPriceList("us-east-1", {
        fetch: async () => nodeStreamResponse(FIXTURE_TEXT),
        dir,
        now: fresh,
      });
      const fetch = vi.fn();
      const list = await ensureBedrockPriceList("us-east-1", "background", {
        settings: AUTOMATIC,
        fetch,
        dir,
        now: () => new Date("2026-11-13T23:00:00Z"),
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(list?.fetchedAt).toBe("2026-11-13T00:00:00.000Z");
      expect(getBedrockPriceList()).toBe(list);
    });

    it("manual: downloads on Test connection only", async () => {
      const fetch = vi.fn(async () => nodeStreamResponse(FIXTURE_TEXT));
      for (const trigger of ["model-selected", "background"] as const) {
        expect(
          await ensureBedrockPriceList("us-east-1", trigger, {
            settings: MANUAL,
            fetch,
            dir,
          }),
        ).toBeUndefined();
      }
      expect(fetch).not.toHaveBeenCalled();
      await ensureBedrockPriceList("us-east-1", "test-connection", {
        settings: MANUAL,
        fetch,
        dir,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(getBedrockPriceList()?.region).toBe("us-east-1");
    });

    it("automatic: a failed download keeps the old copy, and a selection waits an hour", async () => {
      await fetchBedrockPriceList("us-east-1", {
        fetch: async () => nodeStreamResponse(FIXTURE_TEXT),
        dir,
        now: () => new Date("2026-11-10T00:00:00Z"),
      });
      const failing = vi.fn(async () => nodeStreamResponse("", 503));
      const now = () => new Date("2026-11-13T00:00:00Z");
      await expect(
        ensureBedrockPriceList("us-east-1", "model-selected", {
          settings: AUTOMATIC,
          fetch: failing,
          dir,
          now,
        }),
      ).rejects.toThrow(/answered 503/);
      expect(getBedrockPriceList()?.fetchedAt).toBe("2026-11-10T00:00:00.000Z");
      const again = await ensureBedrockPriceList(
        "us-east-1",
        "model-selected",
        {
          settings: AUTOMATIC,
          fetch: failing,
          dir,
          now,
        },
      );
      expect(failing).toHaveBeenCalledTimes(1);
      expect(again?.fetchedAt).toBe("2026-11-10T00:00:00.000Z");
    });

    it("downloads one region once when asked twice at the same time", async () => {
      const fetch = vi.fn(async () => nodeStreamResponse(FIXTURE_TEXT));
      await Promise.all([
        ensureBedrockPriceList("us-east-1", "test-connection", {
          settings: AUTOMATIC,
          fetch,
          dir,
        }),
        ensureBedrockPriceList("us-east-1", "background", {
          settings: AUTOMATIC,
          fetch,
          dir,
        }),
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Test connection of another region", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-prices-"));
    resetBedrockPriceListState();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    setBedrockPriceList(undefined);
  });

  it("keeps the selected model's prices in front of the cost functions", async () => {
    const selected = {
      schemaVersion: 1,
      region: "eu-west-1",
      source: bedrockPriceListUrl("eu-west-1"),
      fetchedAt: "2026-11-13T00:00:00.000Z",
      rows: [
        {
          model: "Nova Pro",
          kind: "input" as const,
          tier: "standard" as const,
          route: "in-region" as const,
          usdPerMTok: 1,
          usagetype: "EU-NovaPro-input-tokens",
        },
      ],
    };
    setBedrockPriceList(selected);
    const list = await ensureBedrockPriceList("us-east-1", "test-connection", {
      settings: AUTOMATIC,
      fetch: async () => nodeStreamResponse(FIXTURE_TEXT),
      dir,
      activate: false,
    });
    expect(list?.region).toBe("us-east-1");
    expect(getBedrockPriceList()).toBe(selected);
  });
});
