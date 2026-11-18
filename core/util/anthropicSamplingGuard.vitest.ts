import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import Anthropic from "../llm/llms/Anthropic.js";
import { bedrockSamplingParams } from "../llm/llms/bedrockHelpers.js";
import {
  claudeRefusesSampling,
  noteSamplingOmitted,
  omitsSampling,
} from "./anthropicSamplingGuard.js";
import { resolveFact, surfaceFamily } from "./surfaceFacts.js";

const REFUSED = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-2",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-4-7-opus",
  "us.anthropic.claude-opus-4-8-v1:0",
  "anthropic.claude-opus-4-8-v1:0",
  "global.anthropic.claude-opus-4-7",
  "eu.anthropic.claude-sonnet-5-v1:0",
  "anthropic.claude-mythos-preview-v1:0",
  "anthropic.claude-fable-5-v1:0",
  "claude-opus-4-7@20260601",
  "claude-sonnet-5@20261001",
  "claude-opus-4-7-20260601",
  "claude-sonnet-5-20261001",
  "claude-opus-4.7",
  "publishers/anthropic/models/claude-opus-4-7@20260601",
  "CLAUDE-OPUS-4-8",
];
const ACCEPTED = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
  "claude-2.1",
  "claude-instant-1.2",
  "anthropic.claude-opus-4-6-v1:0",
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "claude-sonnet-4-6@20260301",
  "claude-opus-4-1@20250805",
  "claude-sonnet-4@20250514",
  "claude-3-5-sonnet-v2@20241022",
  "gpt-5",
  "",
];

describe("claudeRefusesSampling", () => {
  it.each(REFUSED)("refuses %s", (m) => {
    expect(claudeRefusesSampling(m)).toBe(true);
  });
  it.each(ACCEPTED)("accepts %j", (m) => {
    expect(claudeRefusesSampling(m)).toBe(false);
  });
  it("agrees with the samplingParams surface facts", () => {
    for (const m of [...REFUSED, ...ACCEPTED]) {
      const f = resolveFact("samplingParams", {
        provider: "anthropic",
        api: "messages",
        modelFamily: surfaceFamily(undefined, m),
      });
      expect(f.value === "refused", m).toBe(claudeRefusesSampling(m));
      if (f.value) {
        expect(f.source).toMatch(/^https:\/\//);
        expect(f.readOn).toBe("2026-11-11");
      }
    }
  });
});

describe("request building", () => {
  const llm = new Anthropic({
    apiKey: "k",
    model: "claude-opus-4-8",
    apiBase: "https://api.anthropic.com/v1/",
  });

  it("omits temperature, top_p and top_k for Claude 4.7 and later", () => {
    const a = llm.convertArgs({
      model: "claude-opus-4-8",
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
    });
    expect(a.temperature).toBeUndefined();
    expect(a.top_p).toBeUndefined();
    expect(a.top_k).toBeUndefined();
  });

  it("is unchanged for earlier models", () => {
    const a = llm.convertArgs({
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      topK: 40,
    });
    expect(a.temperature).toBe(0.5);
    expect(a.top_k).toBe(40);
  });

  it("omits the Converse sampling fields on Bedrock for refusing models", () => {
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-opus-4-8-v1:0",
        0.5,
        0.9,
        false,
      ),
    ).toEqual({});
    expect(
      bedrockSamplingParams("us.anthropic.claude-sonnet-4-6", 0.5, 0.9, false),
    ).toEqual({ temperature: 0.5 });
    expect(
      bedrockSamplingParams("amazon.nova-pro-v1:0", 0.5, 0.9, false),
    ).toEqual({ temperature: 0.5, topP: 0.9 });
  });
});

describe("omitSampling override", () => {
  it("wins over the predicate in both directions", () => {
    expect(omitsSampling("claude-opus-4-8", false)).toBe(false);
    expect(omitsSampling("claude-sonnet-4-6", true)).toBe(true);
    expect(omitsSampling("gpt-5", true)).toBe(true);
  });
  it("follows the predicate when unset", () => {
    expect(omitsSampling("claude-opus-4-8")).toBe(true);
    expect(omitsSampling("claude-opus-4-8", undefined)).toBe(true);
    expect(omitsSampling("claude-sonnet-4-6", null)).toBe(false);
  });

  const llm = new Anthropic({
    apiKey: "k",
    model: "claude-opus-4-8",
    apiBase: "https://api.anthropic.com/v1/",
  });
  it("force-sends the fields to a refusing model", () => {
    const a = llm.convertArgs({
      model: "claude-opus-4-8",
      temperature: 0.5,
      topK: 40,
      omitSampling: false,
    });
    expect(a.temperature).toBe(0.5);
    expect(a.top_k).toBe(40);
  });
  it("force-omits the fields for an accepting model", () => {
    const a = llm.convertArgs({
      model: "claude-sonnet-4-6",
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      omitSampling: true,
    });
    expect(a.temperature).toBeUndefined();
    expect(a.top_p).toBeUndefined();
    expect(a.top_k).toBeUndefined();
  });
  it("applies on Bedrock", () => {
    const id = "us.anthropic.claude-opus-4-8-v1:0";
    expect(bedrockSamplingParams(id, 0.5, undefined, false, false)).toEqual({
      temperature: 0.5,
    });
    expect(
      bedrockSamplingParams("amazon.nova-pro-v1:0", 0.5, 0.9, false, true),
    ).toEqual({});
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-sonnet-4-6",
        0.5,
        0.9,
        false,
        true,
      ),
    ).toEqual({});
  });
});

describe("noteSamplingOmitted", () => {
  it("logs once per model at debug level, with the guard's wording", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    noteSamplingOmitted("claude-opus-4-9-test");
    noteSamplingOmitted("claude-opus-4-9-test");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain(
      "refuses temperature, top_p and top_k; omitting them from the request",
    );
    noteSamplingOmitted("claude-sonnet-4-6-forced", true);
    expect(spy.mock.calls[1][0]).toContain("omitSampling");
    spy.mockRestore();
  });
});

describe("adapter copy", () => {
  // packages/openai-adapters cannot import from core, so the file is copied.
  // Everything after the header comment must stay identical.
  const body = (rel: string) =>
    readFileSync(path.join(__dirname, rel), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/^\/\*\*[\s\S]*?\*\/\n\n/, "");
  it("is identical to core/util/anthropicSamplingGuard.ts below the header", () => {
    const a = body("./anthropicSamplingGuard.ts");
    const b = body(
      "../../packages/openai-adapters/src/apis/anthropicSamplingGuard.ts",
    );
    expect(a.length).toBeGreaterThan(500);
    expect(b).toBe(a);
  });
});
