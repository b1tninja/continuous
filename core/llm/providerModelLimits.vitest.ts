import { describe, expect, it } from "vitest";
import { resolveModelLimits, type LimitInputs } from "./providerModelLimits.js";

const base: LimitInputs = {
  defaultContextLength: 32_768,
  defaultMaxTokens: 4096,
};

describe("resolveModelLimits", () => {
  it("config wins over the provider and llm-info", () => {
    expect(
      resolveModelLimits({
        ...base,
        userContextLength: 100_000,
        userMaxTokens: 2000,
        llmInfo: { contextLength: 200_000, maxCompletionTokens: 64_000 },
        provider: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
      }),
    ).toEqual({ contextLength: 100_000, maxTokens: 2000 });
  });

  it("the provider's answer wins over llm-info, with the quarter-window rule", () => {
    expect(
      resolveModelLimits({
        ...base,
        llmInfo: { contextLength: 200_000, maxCompletionTokens: 64_000 },
        provider: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
      }),
    ).toEqual({ contextLength: 1_000_000, maxTokens: 128_000 });
    expect(
      resolveModelLimits({
        ...base,
        provider: { contextLength: 200_000, maxOutputTokens: 128_000 },
      }),
    ).toEqual({ contextLength: 200_000, maxTokens: 50_000 });
  });

  it("a field the provider did not send leaves llm-info's", () => {
    expect(
      resolveModelLimits({
        ...base,
        llmInfo: { contextLength: 200_000, maxCompletionTokens: 64_000 },
        provider: {},
      }),
    ).toEqual({ contextLength: 200_000, maxTokens: 50_000 });
  });

  it("matches today's rule without a provider answer", () => {
    expect(resolveModelLimits(base)).toEqual({
      contextLength: undefined,
      maxTokens: 4096,
    });
    expect(
      resolveModelLimits({
        ...base,
        llmInfo: { contextLength: 128_000, maxCompletionTokens: 16_384 },
      }),
    ).toEqual({ contextLength: 128_000, maxTokens: 16_384 });
  });

  it("a provider class default is only ever lowered by the provider's cap", () => {
    expect(
      resolveModelLimits({
        ...base,
        classMaxTokens: 8192,
        provider: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
      }).maxTokens,
    ).toBe(8192);
    expect(
      resolveModelLimits({
        ...base,
        classMaxTokens: 8192,
        provider: { maxOutputTokens: 4096 },
      }).maxTokens,
    ).toBe(4096);
  });
});
