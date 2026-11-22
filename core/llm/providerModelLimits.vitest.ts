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
    ).toEqual({
      contextLength: 100_000,
      contextLengthSource: "config",
      maxTokens: 2000,
      maxTokensSource: "config",
    });
  });

  it("the provider's answer wins over llm-info, with the quarter-window rule", () => {
    expect(
      resolveModelLimits({
        ...base,
        llmInfo: { contextLength: 200_000, maxCompletionTokens: 64_000 },
        provider: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
      }),
    ).toEqual({
      contextLength: 1_000_000,
      contextLengthSource: "provider",
      maxTokens: 128_000,
      maxTokensSource: "provider",
    });
    expect(
      resolveModelLimits({
        ...base,
        provider: { contextLength: 200_000, maxOutputTokens: 128_000 },
      }),
    ).toEqual({
      contextLength: 200_000,
      contextLengthSource: "provider",
      maxTokens: 50_000,
      maxTokensSource: "provider",
    });
  });

  it("a field the provider did not send leaves llm-info's", () => {
    expect(
      resolveModelLimits({
        ...base,
        llmInfo: { contextLength: 200_000, maxCompletionTokens: 64_000 },
        provider: {},
      }),
    ).toEqual({
      contextLength: 200_000,
      contextLengthSource: "published",
      maxTokens: 50_000,
      maxTokensSource: "published",
    });
  });

  it("matches today's rule without a provider answer", () => {
    expect(resolveModelLimits(base)).toEqual({
      contextLength: undefined,
      contextLengthSource: "unknown",
      maxTokens: 4096,
      maxTokensSource: "fallback",
    });
    expect(
      resolveModelLimits({
        ...base,
        llmInfo: { contextLength: 128_000, maxCompletionTokens: 16_384 },
      }),
    ).toEqual({
      contextLength: 128_000,
      contextLengthSource: "published",
      maxTokens: 16_384,
      maxTokensSource: "published",
    });
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

  it("says which rule gave a class default", () => {
    expect(
      resolveModelLimits({ ...base, classMaxTokens: 8192 }).maxTokensSource,
    ).toBe("class");
    expect(
      resolveModelLimits({
        ...base,
        classMaxTokens: 8192,
        provider: { maxOutputTokens: 4096 },
      }).maxTokensSource,
    ).toBe("provider");
  });

  describe("a local OpenAI-compatible server (serverDecidesMaxTokens)", () => {
    const local = { ...base, serverDecidesMaxTokens: true };

    it("has no output cap when none is known", () => {
      expect(resolveModelLimits(local)).toEqual({
        contextLength: undefined,
        contextLengthSource: "unknown",
        maxTokens: undefined,
        maxTokensSource: "none",
      });
    });

    it("keeps a cap that is known", () => {
      expect(
        resolveModelLimits({
          ...local,
          provider: { contextLength: 65_536, maxOutputTokens: 8192 },
        }),
      ).toMatchObject({ maxTokens: 8192, maxTokensSource: "provider" });
      expect(
        resolveModelLimits({
          ...local,
          llmInfo: { contextLength: 128_000, maxCompletionTokens: 16_384 },
        }),
      ).toMatchObject({ maxTokens: 16_384, maxTokensSource: "published" });
      expect(
        resolveModelLimits({ ...local, classMaxTokens: 2048 }),
      ).toMatchObject({ maxTokens: 2048, maxTokensSource: "class" });
    });

    it("always uses the person's own value", () => {
      expect(
        resolveModelLimits({ ...local, userMaxTokens: 900 }),
      ).toMatchObject({ maxTokens: 900, maxTokensSource: "config" });
    });
  });
});
