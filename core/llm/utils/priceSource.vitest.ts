import { afterEach, describe, expect, it } from "vitest";

import { costOf, USER_PRICE_SOURCE } from "../../util/costOf";
import { parseOpenRouterModels, type ModelCatalog } from "../openRouterCatalog";

import {
  ANTHROPIC_PRICE_SOURCE,
  AWS_PRICE_LIST_SOURCE,
  calculateRequestCost,
  OPENAI_PRICE_SOURCE,
} from "./calculateRequestCost";
import { setOpenRouterCatalog } from "./catalogPricing";

const plain = { promptTokens: 1000, completionTokens: 500 };

afterEach(() => setOpenRouterCatalog(undefined));

describe("price source on every priced cost", () => {
  it("names Anthropic's list for Claude on the Anthropic API, Vertex and Bedrock", () => {
    for (const [provider, model] of [
      ["anthropic", "claude-sonnet-4-6"],
      ["vertexai", "claude-sonnet-4-6"],
      ["bedrock", "us.anthropic.claude-sonnet-4-6"],
    ]) {
      expect(calculateRequestCost(provider, model, plain)?.priceSource).toBe(
        ANTHROPIC_PRICE_SOURCE,
      );
    }
    expect(ANTHROPIC_PRICE_SOURCE.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("names the AWS Price List for Nova and the other Bedrock families", () => {
    expect(
      calculateRequestCost("bedrock", "amazon.nova-pro-v1:0", plain)
        ?.priceSource,
    ).toBe(AWS_PRICE_LIST_SOURCE);
    expect(
      calculateRequestCost("bedrock-mantle", "openai.gpt-oss-120b-1:0", plain)
        ?.priceSource,
    ).toBe(AWS_PRICE_LIST_SOURCE);
  });

  it("names OpenAI's pricing page for OpenAI models", () => {
    expect(calculateRequestCost("openai", "gpt-4o", plain)?.priceSource).toBe(
      OPENAI_PRICE_SOURCE,
    );
  });

  it("names the downloaded OpenRouter list with its download time", () => {
    const catalog: ModelCatalog = {
      schemaVersion: 1,
      source: "https://openrouter.ai/api/v1/models",
      fetchedAt: "2026-11-12T00:00:00.000Z",
      models: parseOpenRouterModels({
        data: [
          {
            id: "zz/plain",
            name: "ZZ Plain",
            pricing: { prompt: "0.000001", completion: "0.000002" },
          },
        ],
      }),
    };
    setOpenRouterCatalog(catalog);
    expect(
      calculateRequestCost("openrouter", "zz/plain", plain)?.priceSource,
    ).toEqual({
      kind: "provider",
      label: "OpenRouter model list",
      url: "https://openrouter.ai/api/v1/models",
      asOf: "2026-11-12T00:00:00.000Z",
    });
  });

  it("leaves an unpriced model without a source", () => {
    expect(calculateRequestCost("openai", "no-such-model", plain)).toBeNull();
  });

  it("carries the source through costOf, and marks a price the person entered", () => {
    const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 };
    expect(
      costOf(usage, { provider: "anthropic", model: "claude-sonnet-4-6" })
        .priceSource,
    ).toBe(ANTHROPIC_PRICE_SOURCE);
    expect(
      costOf(
        usage,
        { provider: "ollama", model: "qwen3" },
        { userPrice: { input: 0, output: 0 } },
      ).priceSource,
    ).toBe(USER_PRICE_SOURCE);
    expect(
      costOf(usage, { provider: "ollama", model: "qwen3" }).priceSource,
    ).toBeUndefined();
  });
});

describe("the tier that served the request", () => {
  const nova = "amazon.nova-pro-v1:0";

  it("adds no note for the standard tier, under any of its names", () => {
    for (const tier of ["default", "standard", "auto"]) {
      const r = calculateRequestCost("bedrock", nova, {
        ...plain,
        response: { serviceTier: tier },
      })!;
      expect(r.servedTier).toBeUndefined();
      expect(r.breakdown).not.toContain("served this request");
    }
  });

  it("says a flex request is priced at standard rates and costs less", () => {
    const standard = calculateRequestCost("bedrock", nova, plain)!;
    const r = calculateRequestCost("bedrock", nova, {
      ...plain,
      response: { serviceTier: "flex" },
    })!;
    // Same figure: the tables hold standard prices only
    expect(r.cost).toBe(standard.cost);
    expect(r.servedTier).toBe("flex");
    const lines = r.breakdown.split("\n");
    expect(lines[0]).toBe(`Model: ${nova}`);
    expect(lines[1]).toContain("served this request at the flex tier");
    expect(lines[1]).toContain("actual charge is lower");
  });

  it("says a priority request costs more than shown", () => {
    const r = calculateRequestCost(
      "bedrock",
      "us.anthropic.claude-sonnet-4-6",
      { ...plain, response: { serviceTier: "priority" } },
    )!;
    expect(r.breakdown).toContain("actual charge is higher");
  });

  it("turns the note into an assumption in costOf's reading of a breakdown", () => {
    // costOf lists every "Prices:" line as an assumption; the tier note is one
    const r = calculateRequestCost("anthropic", "claude-sonnet-4-6", {
      ...plain,
      response: { serviceTier: "batch" },
    })!;
    expect(
      r.breakdown.split("\n").filter((l) => l.startsWith("Prices:")),
    ).toHaveLength(1);
  });
});
