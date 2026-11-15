import { afterEach, describe, expect, it } from "vitest";
import {
  CORRECTION_HEADROOM,
  MAX_CORRECTION,
  contextCorrectionFor,
  correctedContextLength,
  correctionFromOverflow,
  learnContextCorrection,
  parseContextOverflow,
  resetContextCorrections,
} from "./contextOverflow";

afterEach(() => resetContextCorrections());

describe("parseContextOverflow", () => {
  it("reads Bedrock's and Anthropic's wording, as seen live", () => {
    expect(
      parseContextOverflow(
        "The model returned the following errors: prompt is too long: 1067710 tokens > 1000000 maximum",
      ),
    ).toEqual({ actualTokens: 1067710, maxTokens: 1000000 });
  });

  it("reads OpenAI's wording", () => {
    expect(
      parseContextOverflow(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130,001 tokens. Please reduce the length of the messages.",
      ),
    ).toEqual({ actualTokens: 130001, maxTokens: 128000 });
  });

  it("reads Gemini's wording", () => {
    expect(
      parseContextOverflow(
        "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).",
      ),
    ).toEqual({ actualTokens: 1100000, maxTokens: 1048576 });
  });

  it("reads vLLM's wording, as Bedrock GPT OSS sent it live", () => {
    expect(
      parseContextOverflow(
        'The model returned the following errors: Mantle streaming error for requestId 3eeff274: ErrorEvent { error: APIError { type: "BadRequestError", code: Some(400), message: "Input length (515073) exceeds model\'s maximum context length (131072).", param: None } }',
      ),
    ).toEqual({ actualTokens: 515073, maxTokens: 131072 });
  });

  it("recognises an overflow that gives no counts", () => {
    for (const message of [
      "ValidationException: Input is too long for requested model.",
      "context_length_exceeded",
      "The request exceeds the model's maximum context length",
      "Input exceeds model's maximum context length",
    ]) {
      expect(parseContextOverflow(message)).toEqual({});
    }
  });

  it("ignores other errors", () => {
    expect(
      parseContextOverflow("ThrottlingException: Too many requests"),
    ).toBeUndefined();
    expect(
      parseContextOverflow("max_tokens must be at least 1"),
    ).toBeUndefined();
    expect(parseContextOverflow("")).toBeUndefined();
  });
});

describe("correctionFromOverflow", () => {
  it("is the provider's count over our estimate, with headroom", () => {
    expect(
      correctionFromOverflow(
        { actualTokens: 1_067_710, maxTokens: 1_000_000 },
        995_000,
      ),
    ).toBeCloseTo((1_067_710 / 995_000) * CORRECTION_HEADROOM, 6);
  });

  it("never goes below the current correction, nor below 1", () => {
    expect(correctionFromOverflow({ actualTokens: 900 }, 1000, 1.3)).toBe(1.3);
    expect(correctionFromOverflow({ actualTokens: 500 }, 1000)).toBe(1);
  });

  it("is capped, so one odd count cannot run away", () => {
    expect(correctionFromOverflow({ actualTokens: 10_000_000 }, 1000)).toBe(
      MAX_CORRECTION,
    );
  });

  it("is undefined without a count or an estimate", () => {
    expect(correctionFromOverflow({}, 1000)).toBeUndefined();
    expect(correctionFromOverflow({ actualTokens: 1000 }, 0)).toBeUndefined();
  });
});

describe("learned corrections", () => {
  it("start at 1 and leave the context length alone", () => {
    expect(contextCorrectionFor("m")).toBe(1);
    expect(correctedContextLength(1_000_000, "m")).toBe(1_000_000);
  });

  it("shrink the budget for that model only, and only grow", () => {
    learnContextCorrection("sonnet", 1.2);
    learnContextCorrection("sonnet", 1.1);
    expect(contextCorrectionFor("sonnet")).toBe(1.2);
    expect(correctedContextLength(1_000_000, "sonnet")).toBe(833_333);
    expect(correctedContextLength(1_000_000, "opus")).toBe(1_000_000);
  });

  it("leave an unset context length unset", () => {
    learnContextCorrection("m", 1.5);
    expect(correctedContextLength(undefined, "m")).toBeUndefined();
  });

  it("are capped", () => {
    learnContextCorrection("m", 9);
    expect(contextCorrectionFor("m")).toBe(MAX_CORRECTION);
  });
});
