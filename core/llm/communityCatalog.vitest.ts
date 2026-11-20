import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { costOf } from "../util/costOf";
import {
  COMMUNITY_CATALOG_SCHEMA_VERSION,
  MAX_COMMUNITY_CATALOG_BYTES,
  MAX_MODELS_DEV_RESPONSE_BYTES,
  MODELS_DEV_URL,
  parseModelsDev,
  type CommunityCatalog,
} from "./communityCatalog";
import { MODELS_DEV_TRIMMED } from "./communityCatalogFixtures";
import {
  createCommunityRefresher,
  loadCommunityPrices,
  needsCommunityPrice,
  pullCommunityCatalog,
  readCommunityCatalog,
  writeCommunityCatalog,
} from "./communityCatalogStore";
import {
  CATALOG_REQUEST_HEADERS,
  type ModelCatalogSettings,
} from "./modelCatalogStore";
import { calculateRequestCost } from "./utils/calculateRequestCost";
import { setOpenRouterCatalog } from "./utils/catalogPricing";
import {
  getCommunityCatalog,
  setCommunityCatalog,
} from "./utils/communityPricing";

vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

const FETCHED_AT = "2026-11-10T08:00:00.000Z";

function catalog(): CommunityCatalog {
  return {
    schemaVersion: COMMUNITY_CATALOG_SCHEMA_VERSION,
    source: MODELS_DEV_URL,
    fetchedAt: FETCHED_AT,
    prices: parseModelsDev(MODELS_DEV_TRIMMED),
  };
}

const automatic: ModelCatalogSettings = {
  policy: "automatic",
  refreshHours: 24,
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "community-catalog-"));
  setCommunityCatalog(undefined);
  setOpenRouterCatalog(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCommunityCatalog(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseModelsDev (trimmed real answer of 2026-11-13)", () => {
  const prices = parseModelsDev(MODELS_DEV_TRIMMED);
  const ids = prices.map((p) => `${p.provider}/${p.id}`).sort();

  it("keeps the priced models of mapped providers only", () => {
    expect(ids).toEqual([
      "amazon-bedrock/global.anthropic.claude-opus-4-7",
      "amazon-bedrock/mistral.ministral-3-14b-instruct",
      "amazon-bedrock/us.anthropic.claude-opus-4-7",
      "anthropic/claude-opus-4-8",
      "google/gemini-2.5-pro",
      "mistral/mistral-large-latest",
      "openai/gpt-5.6-luna",
    ]);
    // 302ai (a reseller) is not mapped
    expect(ids.some((i) => i.startsWith("302ai/"))).toBe(false);
  });

  it("refuses an unknown tier type, a rate that is not a number and a missing cost", () => {
    expect(ids).not.toContain("mistral/mistral-batch-tier-example");
    expect(ids).not.toContain("mistral/mistral-bad-rate-example");
    expect(ids).not.toContain("mistral/mistral-no-cost-example");
  });

  it("reads rates per million tokens and context tiers", () => {
    const gemini = prices.find((p) => p.id === "gemini-2.5-pro")!;
    expect(gemini).toMatchObject({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
      tiers: [{ aboveTokens: 200000, input: 2.5, output: 15 }],
    });
  });

  it("returns nothing for an answer that is not a catalogue", () => {
    expect(parseModelsDev(null)).toEqual([]);
    expect(parseModelsDev([])).toEqual([]);
    expect(parseModelsDev({ mistral: { models: "x" } })).toEqual([]);
  });
});

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
});

describe("community prices in calculateRequestCost", () => {
  beforeEach(() => setCommunityCatalog(catalog()));

  it("prices a model no better source has, labelled community with its date", () => {
    const r = calculateRequestCost(
      "mistral",
      "mistral-large-latest",
      usage(1_000_000, 1_000_000),
    );
    expect(r?.cost).toBeCloseTo(0.7 + 2.1, 9);
    expect(r?.priceSource).toEqual({
      kind: "community",
      label: "community catalogue (models.dev)",
      url: MODELS_DEV_URL,
      asOf: FETCHED_AT,
    });
    expect(r?.breakdown).toContain(
      "Prices: community catalogue (models.dev), 2026-11-10 (estimate; mistral/mistral-large-latest)",
    );
  });

  it("never replaces a curated price", () => {
    // Anthropic's list prices the same model; models.dev must not win
    const r = calculateRequestCost(
      "anthropic",
      "claude-opus-4-8",
      usage(1000, 1000),
    );
    expect(r?.priceSource?.kind).toBe("curated");
    const bedrock = calculateRequestCost(
      "bedrock",
      "us.anthropic.claude-opus-4-7",
      usage(1000, 1000),
    );
    expect(bedrock?.priceSource?.kind).toBe("curated");
  });

  it("never replaces OpenRouter's downloaded list", () => {
    setOpenRouterCatalog({
      schemaVersion: 1,
      source: "https://openrouter.ai/api/v1/models",
      fetchedAt: "2026-11-12T00:00:00.000Z",
      models: [
        {
          id: "mistralai/mistral-large",
          name: "Mistral Large",
          supportsTools: true,
          pricing: { prompt: 0.000002, completion: 0.000006 },
        },
      ],
    });
    const r = calculateRequestCost(
      "openrouter",
      "mistralai/mistral-large",
      usage(1000, 1000),
    );
    expect(r?.priceSource?.kind).toBe("provider");
  });

  it("matches the provider and the exact id: no prefix stripped, no other provider", () => {
    // The Bedrock entry is keyed with its region prefix
    expect(
      calculateRequestCost(
        "bedrock",
        "mistral.ministral-3-14b-instruct",
        usage(1000, 1000),
      )?.priceSource?.kind,
    ).toBe("community");
    expect(
      calculateRequestCost(
        "bedrock",
        "us.mistral.ministral-3-14b-instruct",
        usage(1000, 1000),
      ),
    ).toBeNull();
    // Same id under another provider is not this model
    expect(
      calculateRequestCost("groq", "mistral-large-latest", usage(1000, 1000)),
    ).toBeNull();
    // A provider that is not mapped (deployment names, resellers)
    expect(
      calculateRequestCost("azure", "mistral-large-latest", usage(1000, 1000)),
    ).toBeNull();
    // Case only
    expect(
      calculateRequestCost("mistral", "Mistral-Large-Latest", usage(1000, 1000))
        ?.priceSource?.kind,
    ).toBe("community");
  });

  it("uses the tier the whole prompt reaches", () => {
    const small = calculateRequestCost(
      "gemini",
      "gemini-2.5-pro",
      usage(100_000, 0),
    );
    expect(small?.cost).toBeCloseTo(0.125, 9);
    const large = calculateRequestCost(
      "gemini",
      "gemini-2.5-pro",
      usage(300_000, 0),
    );
    expect(large?.cost).toBeCloseTo(0.75, 9);
  });

  it("takes cached tokens out of an OpenAI-style prompt count", () => {
    const r = calculateRequestCost("gemini", "gemini-2.5-pro", {
      promptTokens: 1_000_000,
      completionTokens: 0,
      promptTokensDetails: { cachedTokens: 400_000 },
    });
    // 600K uncached plus 400K reads; the whole prompt (1M) is over the 200K
    // tier, so the tier's input and read rates apply
    expect(r?.cost).toBeCloseTo(0.6 * 2.5 + 0.4 * 0.25, 9);
  });

  it("is skipped with community: false, and when no copy is held", () => {
    expect(
      calculateRequestCost("mistral", "mistral-large-latest", usage(1, 1), {
        community: false,
      }),
    ).toBeNull();
    setCommunityCatalog(undefined);
    expect(
      calculateRequestCost("mistral", "mistral-large-latest", usage(1, 1)),
    ).toBeNull();
  });

  it("costOf carries the community source and says it is an estimate", () => {
    const r = costOf(
      { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
      { provider: "mistral", model: "mistral-large-latest" },
    );
    expect(r.priceSource?.kind).toBe("community");
    expect(r.assumptions[0]).toMatch(/community catalogue \(models\.dev\)/);
  });

  it("a price the person entered comes first", () => {
    const r = costOf(
      { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
      { provider: "mistral", model: "mistral-large-latest" },
      { userPrice: { input: 1, output: 1 } },
    );
    expect(r.priceSource?.kind).toBe("user");
  });
});

describe("needsCommunityPrice", () => {
  it("is true only when the provider list and the tables have no price", () => {
    setCommunityCatalog(catalog());
    expect(
      needsCommunityPrice({
        provider: "mistral",
        model: "mistral-large-latest",
      }),
    ).toBe(true);
    expect(
      needsCommunityPrice({ provider: "anthropic", model: "claude-opus-4-8" }),
    ).toBe(false);
    expect(needsCommunityPrice({ provider: "", model: "" })).toBe(false);
  });
});

const stubFetch = (response: () => Response) => {
  const f = vi.fn(async () => response());
  vi.stubGlobal("fetch", f);
  return f;
};

describe("the cached copy", () => {
  it("one GET to models.dev, no key or body, the fixed headers, written atomically", async () => {
    const f = stubFetch(() => new Response(JSON.stringify(MODELS_DEV_TRIMMED)));
    const file = path.join(dir, "model-catalog", "models-dev.json");
    const c = await pullCommunityCatalog(undefined, {
      file,
      now: () => new Date(FETCHED_AT),
    });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("https://models.dev/api.json");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual(CATALOG_REQUEST_HEADERS);
    expect(c.prices).toHaveLength(7);
    expect(readCommunityCatalog(file)?.fetchedAt).toBe(FETCHED_AT);
    // No temporary file is left behind
    expect(fs.readdirSync(path.dirname(file))).toEqual(["models-dev.json"]);
    // The copy prices the next request of this process
    expect(getCommunityCatalog()?.fetchedAt).toBe(FETCHED_AT);
  });

  it("refuses an answer over the size limit and keeps the old copy", async () => {
    const file = path.join(dir, "models-dev.json");
    writeCommunityCatalog(catalog(), file);
    const before = fs.readFileSync(file, "utf8");
    stubFetch(
      () =>
        new Response("{}", {
          headers: {
            "content-length": String(MAX_MODELS_DEV_RESPONSE_BYTES + 1),
          },
        }),
    );
    await expect(pullCommunityCatalog(undefined, { file })).rejects.toThrow(
      /size limit/,
    );
    stubFetch(() => new Response("not json"));
    await expect(pullCommunityCatalog(undefined, { file })).rejects.toThrow(
      /did not return a catalogue/,
    );
    stubFetch(() => new Response(JSON.stringify({ x: {} })));
    await expect(pullCommunityCatalog(undefined, { file })).rejects.toThrow(
      /no prices/,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("does not read a copy that is too large or not one this build wrote", () => {
    const file = path.join(dir, "models-dev.json");
    fs.writeFileSync(file, JSON.stringify({ ...catalog(), schemaVersion: 99 }));
    expect(readCommunityCatalog(file)).toBeUndefined();
    fs.writeFileSync(file, "x".repeat(MAX_COMMUNITY_CATALOG_BYTES + 1));
    expect(readCommunityCatalog(file)).toBeUndefined();
  });

  it("with model information updates off, the copy is not used", () => {
    const file = path.join(dir, "models-dev.json");
    writeCommunityCatalog(catalog(), file);
    expect(
      loadCommunityPrices({
        file,
        settings: { policy: "off", refreshHours: 24 },
      }),
    ).toBeUndefined();
    expect(getCommunityCatalog()).toBeUndefined();
    expect(loadCommunityPrices({ file, settings: automatic })).toBeDefined();
    expect(getCommunityCatalog()).toBeDefined();
  });
});

describe("createCommunityRefresher: when models.dev is contacted", () => {
  const run = async (
    settings: ModelCatalogSettings,
    unpriced: boolean,
    seed?: string,
  ) => {
    const f = stubFetch(() => new Response(JSON.stringify(MODELS_DEV_TRIMMED)));
    const file = path.join(dir, "models-dev.json");
    if (seed) writeCommunityCatalog({ ...catalog(), fetchedAt: seed }, file);
    const r = createCommunityRefresher({
      unpriced: () => unpriced,
      settings: () => settings,
      file,
    });
    const outcome = await r.check();
    return { outcome, calls: f.mock.calls.length };
  };

  it("automatic, a selected model unpriced, no copy: one request", async () => {
    expect(await run(automatic, true)).toEqual({
      outcome: "refreshed",
      calls: 1,
    });
  });

  it("automatic, every selected model priced: no request", async () => {
    expect(await run(automatic, false)).toEqual({
      outcome: "disabled",
      calls: 0,
    });
  });

  it("automatic with a fresh copy: no request", async () => {
    expect(
      await run(automatic, true, new Date(Date.now() - 3600_000).toISOString()),
    ).toEqual({ outcome: "fresh", calls: 0 });
  });

  it("manual and off never request in the background", async () => {
    for (const policy of ["ask", "never", "off"] as const) {
      expect(await run({ policy, refreshHours: 24 }, true)).toEqual({
        outcome: "disabled",
        calls: 0,
      });
    }
  });
});
