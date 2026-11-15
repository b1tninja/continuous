import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_SMOOTHING,
  CORRECTION_HEADROOM,
  MAX_CALIBRATION,
  MAX_CORRECTION,
  MIN_CALIBRATION,
  contextCorrectionFor,
  correctedContextLength,
  correctionFromOverflow,
  learnContextCorrection,
  learnTokenCalibration,
  parseContextOverflow,
  resetContextCorrections,
  tokenCalibrationFor,
} from "./contextOverflow";

/** The 412,266-token Strata request of the research note, with our estimate. */
const STRATA = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "__fixtures__",
      "strata",
      "metrics-2026-11-15-calibration.json",
    ),
    "utf8",
  ),
);
const QWEN = STRATA.engine.model as string;

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

describe("the usage calibration (local servers)", () => {
  const real = STRATA.requests[0].prompt_tokens as number;
  const estimated = STRATA._client.estimated_prompt_tokens as number;

  it("reads the fixture the way the grant was made", () => {
    const c = STRATA._client;
    expect(
      c.context_length - c.counting_safety_buffer - c.granted_max_tokens,
    ).toBe(estimated);
  });

  it("learns 0.81 from the Strata request, below 1, and gives the room back", () => {
    expect(learnTokenCalibration(QWEN, real, estimated)).toBeCloseTo(0.81, 2);
    expect(tokenCalibrationFor(QWEN)).toBeCloseTo(0.81, 2);
    // With 5% headroom the window is divided by about 0.85: the 524k window
    // holds about 614k tokens as we count them, 97k more than before
    expect(contextCorrectionFor(QWEN)).toBeCloseTo(
      (real / estimated) * CORRECTION_HEADROOM,
      6,
    );
    const window = STRATA.engine.context as number;
    const corrected = correctedContextLength(window, QWEN)!;
    expect(corrected).toBeGreaterThan(window);
    // As the provider counts them, the corrected window is the real one less
    // the headroom: the pruning budget never passes the real window
    expect(corrected * (real / estimated)).toBeLessThan(window);
    expect(corrected * (real / estimated)).toBeGreaterThan(window * 0.95);
  });

  it("is smoothed: one request moves it part of the way", () => {
    learnTokenCalibration(QWEN, real, estimated);
    const first = tokenCalibrationFor(QWEN)!;
    learnTokenCalibration(QWEN, 10_000, 10_000);
    expect(tokenCalibrationFor(QWEN)).toBeCloseTo(
      first + CALIBRATION_SMOOTHING * (1 - first),
      9,
    );
  });

  it("is clamped to [0.6, 2]", () => {
    learnTokenCalibration("low", 1_000, 100_000);
    expect(tokenCalibrationFor("low")).toBe(MIN_CALIBRATION);
    expect(contextCorrectionFor("low")).toBeCloseTo(
      MIN_CALIBRATION * CORRECTION_HEADROOM,
      9,
    );
    learnTokenCalibration("high", 900_000, 100_000);
    expect(tokenCalibrationFor("high")).toBe(MAX_CALIBRATION);
    expect(contextCorrectionFor("high")).toBe(MAX_CALIBRATION);
  });

  it("ignores a missing count and a prompt too small to say anything", () => {
    expect(learnTokenCalibration("m", undefined, 50_000)).toBeUndefined();
    expect(learnTokenCalibration("m", 0, 50_000)).toBeUndefined();
    expect(learnTokenCalibration("m", 80, 100)).toBeUndefined();
    expect(contextCorrectionFor("m")).toBe(1);
  });

  it("is per model", () => {
    learnTokenCalibration(QWEN, real, estimated);
    expect(contextCorrectionFor("other")).toBe(1);
  });

  it("still lets a refusal raise the factor", () => {
    learnTokenCalibration(QWEN, real, estimated);
    const before = contextCorrectionFor(QWEN);
    expect(before).toBeLessThan(1);
    // The provider refused a prompt we counted at 600k as 530k: the overflow
    // path learns as it always did, never below 1
    const factor = correctionFromOverflow(
      { actualTokens: 530_000, maxTokens: 524_288 },
      600_000,
      before,
    )!;
    expect(factor).toBe(1);
    learnContextCorrection(QWEN, factor);
    expect(contextCorrectionFor(QWEN)).toBe(1);
    // And later usage cannot take that back below the refusal's correction
    learnTokenCalibration(QWEN, 0.7 * 100_000, 100_000);
    expect(contextCorrectionFor(QWEN)).toBe(1);
    // A higher ratio from usage still applies on top of it
    for (let i = 0; i < 20; i++) learnTokenCalibration(QWEN, 150_000, 100_000);
    expect(contextCorrectionFor(QWEN)).toBeCloseTo(
      1.5 * CORRECTION_HEADROOM,
      2,
    );
  });
});
