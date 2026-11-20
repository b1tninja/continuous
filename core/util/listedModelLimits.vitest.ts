import { describe, expect, it } from "vitest";
import {
  describeListedLimits,
  limitsFromModelsBody,
  limitsFromOllamaShow,
  limitsOfEntry,
  tokenCount,
} from "./listedModelLimits";

describe("tokenCount", () => {
  it("accepts positive whole numbers and numeric strings", () => {
    expect(tokenCount(8192)).toBe(8192);
    expect(tokenCount(" 4096 ")).toBe(4096);
  });
  it("rejects zero, negatives, fractions, blanks and non-numbers", () => {
    for (const v of [0, -1, 1.5, "", "  ", "abc", null, undefined, {}, NaN]) {
      expect(tokenCount(v)).toBeUndefined();
    }
  });
});

describe("limitsOfEntry", () => {
  it("reads vLLM max_model_len", () => {
    expect(limitsOfEntry({ id: "m", max_model_len: 131072 })).toEqual({
      contextLength: 131072,
      field: "max_model_len",
      kind: "max",
    });
  });
  it("reads OpenRouter context_length and the output cap", () => {
    expect(
      limitsOfEntry({
        context_length: 200000,
        top_provider: { max_completion_tokens: 64000 },
      }),
    ).toEqual({
      contextLength: 200000,
      maxOutputTokens: 64000,
      field: "context_length",
      kind: "max",
    });
  });
  it("prefers the loaded window over the maximum (LM Studio)", () => {
    const l = limitsOfEntry({
      max_context_length: 131072,
      loaded_context_length: 8192,
    });
    expect(l).toMatchObject({ contextLength: 8192, kind: "loaded" });
  });
  it("reads the llama.cpp /props runtime window", () => {
    expect(
      limitsOfEntry({ default_generation_settings: { n_ctx: 16384 } }),
    ).toMatchObject({ contextLength: 16384, kind: "loaded" });
  });
  it("marks the trained window as a ceiling and ranks it last", () => {
    expect(limitsOfEntry({ meta: { n_ctx_train: 262144 } })).toMatchObject({
      contextLength: 262144,
      kind: "trained",
    });
    expect(
      limitsOfEntry({ meta: { n_ctx_train: 262144 }, context_window: 32768 }),
    ).toMatchObject({ contextLength: 32768, kind: "max" });
  });
  it("skips an invalid field and uses the next", () => {
    expect(
      limitsOfEntry({ context_length: 0, max_model_len: 4096 }),
    ).toMatchObject({ contextLength: 4096 });
  });
  it("is empty for an entry that says nothing, or a non-object", () => {
    expect(limitsOfEntry({ id: "x" })).toEqual({});
    expect(limitsOfEntry(null)).toEqual({});
    expect(limitsOfEntry("text")).toEqual({});
  });
});

describe("limitsFromModelsBody", () => {
  const body = {
    data: [
      { id: "a", max_model_len: 1000 },
      { id: "b" },
      { id: "c", context_window: 2000 },
    ],
  };
  it("finds the entry by id", () => {
    expect(limitsFromModelsBody(body, "c")?.contextLength).toBe(2000);
  });
  it("is undefined for an unlisted id or an entry without limits", () => {
    expect(limitsFromModelsBody(body, "zzz")).toBeUndefined();
    expect(limitsFromModelsBody(body, "b")).toBeUndefined();
  });
  it("accepts a bare array and rejects other shapes", () => {
    expect(
      limitsFromModelsBody([{ id: "a", context_length: 5 }], "a"),
    ).toMatchObject({ contextLength: 5 });
    expect(limitsFromModelsBody({ nope: 1 }, "a")).toBeUndefined();
    expect(limitsFromModelsBody(undefined, "a")).toBeUndefined();
  });
});

describe("limitsFromOllamaShow", () => {
  it("prefers num_ctx in the parameters as the running window", () => {
    expect(
      limitsFromOllamaShow({
        parameters: "stop  <|im_end|>\nnum_ctx                        16384",
        model_info: { "qwen3.context_length": 262144 },
      }),
    ).toMatchObject({ contextLength: 16384, kind: "loaded" });
  });
  it("falls back to the trained window as a ceiling", () => {
    expect(
      limitsFromOllamaShow({
        model_info: {
          "general.architecture": "llama",
          "llama.context_length": 131072,
        },
      }),
    ).toMatchObject({ contextLength: 131072, kind: "trained" });
  });
  it("is empty for anything else", () => {
    expect(limitsFromOllamaShow({})).toEqual({});
    expect(limitsFromOllamaShow(null)).toEqual({});
    expect(limitsFromOllamaShow({ parameters: "num_ctx abc" })).toEqual({});
  });
});

describe("describeListedLimits", () => {
  it("words each kind differently", () => {
    expect(
      describeListedLimits({ contextLength: 8192, kind: "loaded" }),
    ).toMatch(/runs this model with a window of 8,192/);
    expect(
      describeListedLimits({ contextLength: 262144, kind: "trained" }),
    ).toMatch(/trained for 262,144.*less/);
    expect(describeListedLimits({ contextLength: 5, kind: "max" })).toMatch(
      /reports a window of 5/,
    );
  });
  it("is undefined without a window", () => {
    expect(describeListedLimits({ maxOutputTokens: 10 })).toBeUndefined();
  });
});
