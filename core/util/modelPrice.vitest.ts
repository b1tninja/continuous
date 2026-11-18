import { describe, expect, it } from "vitest";

import { costOf } from "./costOf";
import { costMarkOf, costSince } from "./loopCost";
import { USER_PRICE_SOURCE, userPriceOf } from "./modelPrice";

describe("userPriceOf", () => {
  it("reads input, output and the cache rates", () => {
    expect(
      userPriceOf({
        pricing: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
      }),
    ).toEqual({ input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  it("leaves the cache rates out when absent, so costOf uses the input rate", () => {
    expect(userPriceOf({ pricing: { input: 1, output: 4 } })).toEqual({
      input: 1,
      output: 4,
    });
  });

  it.each([
    [undefined],
    [{}],
    [{ pricing: null }],
    [{ pricing: { input: 1 } }],
    [{ pricing: { input: -1, output: 1 } }],
    [{ pricing: { input: "1", output: 1 } }],
    [{ pricing: { input: Number.NaN, output: 1 } }],
  ])("is undefined for %j", (model) => {
    expect(userPriceOf(model as never)).toBeUndefined();
  });

  it("drops an unusable cache rate instead of the whole price", () => {
    expect(
      userPriceOf({ pricing: { input: 1, output: 2, cacheRead: -3 } }),
    ).toEqual({ input: 1, output: 2 });
  });

  it("names its source the way price source lines do", () => {
    expect(USER_PRICE_SOURCE).toBe("your config");
  });
});

describe("costOf with a price from the model's config", () => {
  const local = { provider: "ollama", model: "qwen3-coder" };
  const usage = {
    input: 2_000_000,
    output: 500_000,
    cacheRead: 1_000_000,
    cacheWrite: 0,
  };

  it("prices a model no table knows", () => {
    expect(costOf(usage, local).amount).toBe("unknown");
    const priced = costOf(usage, local, {
      userPrice: userPriceOf({
        pricing: { input: 0.5, output: 2, cacheRead: 0.05 },
      }),
    });
    // 2M x 0.5 + 0.5M x 2 + 1M x 0.05
    expect(priced.amount).toBeCloseTo(1 + 1 + 0.05, 10);
    expect(priced.assumptions[0]).toMatch(/rates you entered/);
  });

  it("wins over a list price", () => {
    const listed = { provider: "anthropic", model: "claude-sonnet-4-5" };
    const list = costOf(usage, listed);
    expect(list.amount).not.toBe("unknown");
    const own = costOf(usage, listed, {
      userPrice: userPriceOf({ pricing: { input: 0, output: 0 } }),
    });
    expect(own.amount).toBe(0);
  });

  it("prices a run's slice through costSince, keyed provider/model", () => {
    const before = costMarkOf({
      promptTokens: 0,
      completionTokens: 0,
      totalCost: 0,
      byModel: {},
    });
    const after = costMarkOf({
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalCost: 0,
      byModel: {
        "ollama/qwen3-coder": {
          provider: "ollama",
          model: "qwen3-coder",
          requests: 1,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
          pricedRequests: 0,
        },
      },
    });
    expect(costSince(before, after).amount).toBe("unknown");
    const price = userPriceOf({ pricing: { input: 1, output: 3 } })!;
    expect(
      costSince(before, after, {
        userPrices: { "ollama/qwen3-coder": price },
      }).amount,
    ).toBe(4);
  });
});
