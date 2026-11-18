import { describe, expect, it } from "vitest";

import {
  CATALOG_SCHEMA_VERSION,
  catalogAgeDays,
  parseOpenRouterModels,
  validateCatalog,
} from "./openRouterCatalog";
import { sonnetEntry } from "./openRouterCatalogFixtures";

describe("parseOpenRouterModels", () => {
  it("keeps names, sizes, the tools flag and every price field", () => {
    const [m] = parseOpenRouterModels({ data: [sonnetEntry] });
    expect(m).toEqual({
      id: "anthropic/claude-sonnet-4.5",
      name: "Anthropic: Claude Sonnet 4.5",
      contextLength: 1000000,
      maxCompletionTokens: 64000,
      supportsTools: true,
      pricing: {
        prompt: 0.000003,
        completion: 0.000015,
        webSearch: 0.01,
        inputCacheRead: 0.0000003,
        inputCacheWrite: 0.00000375,
        inputCacheWrite1h: 0.000006,
        overrides: [
          {
            minPromptTokens: 200000,
            prompt: 0.000006,
            completion: 0.0000225,
            inputCacheRead: 0.0000006,
            inputCacheWrite: 0.0000075,
            inputCacheWrite1h: 0.000012,
          },
        ],
      },
    });
  });

  it("keeps free models as zero prices, not as unpriced", () => {
    const [m] = parseOpenRouterModels({
      data: [
        {
          id: "x/y:free",
          name: "Y (free)",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    });
    expect(m.pricing).toEqual({ prompt: 0, completion: 0 });
    expect(m.supportsTools).toBe(false);
  });

  it("treats a variable price (-1) as no price", () => {
    const [m] = parseOpenRouterModels({
      data: [
        {
          id: "openrouter/auto",
          name: "Auto",
          pricing: { prompt: "-1", completion: "-1" },
        },
      ],
    });
    expect(m.pricing).toBeUndefined();
  });

  it("skips entries without an id or a name, and bad bodies", () => {
    expect(
      parseOpenRouterModels({ data: [{ name: "n" }, { id: "a" }, 5, null] }),
    ).toEqual([]);
    expect(parseOpenRouterModels(null)).toEqual([]);
    expect(parseOpenRouterModels({ data: "no" })).toEqual([]);
  });
});

describe("validateCatalog", () => {
  const good = () => ({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: "https://openrouter.ai/api/v1/models",
    fetchedAt: "2026-11-12T00:00:00.000Z",
    models: parseOpenRouterModels({ data: [sonnetEntry] }),
  });

  it("accepts what parseOpenRouterModels produced", () => {
    expect(validateCatalog(good())?.models).toHaveLength(1);
  });

  it("ignores another schema version", () => {
    expect(validateCatalog({ ...good(), schemaVersion: 2 })).toBeUndefined();
  });

  it("ignores a missing or future date", () => {
    expect(validateCatalog({ ...good(), fetchedAt: "soon" })).toBeUndefined();
    expect(
      validateCatalog({ ...good(), fetchedAt: "2999-01-01T00:00:00Z" }),
    ).toBeUndefined();
  });

  it("drops a model with a negative price, keeps the rest", () => {
    const c: any = good();
    c.models.push({
      id: "bad",
      name: "Bad",
      supportsTools: false,
      pricing: { prompt: -1, completion: 1 },
    });
    expect(validateCatalog(c)?.models.map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-4.5",
    ]);
  });

  it("is undefined when nothing valid is left", () => {
    expect(validateCatalog({ ...good(), models: [{ id: 1 }] })).toBeUndefined();
    expect(validateCatalog("text")).toBeUndefined();
  });
});

describe("catalogAgeDays", () => {
  it("counts whole days", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    expect(catalogAgeDays("2026-11-02T12:00:00Z", now)).toBe(10);
    expect(catalogAgeDays("2026-11-12T11:00:00Z", now)).toBe(0);
    expect(catalogAgeDays("nonsense", now)).toBe(Infinity);
  });
});
