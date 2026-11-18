import { describe, expect, it } from "vitest";
import { AnthropicApi } from "./Anthropic.js";
import {
  claudeRefusesSampling,
  omitsSampling,
} from "./anthropicSamplingGuard.js";
import { bedrockSamplingParams } from "./bedrockHelpers.js";

describe("claudeRefusesSampling (adapter copy)", () => {
  it("matches Claude 4.7 and later only", () => {
    for (const m of [
      "claude-opus-4-7",
      "claude-sonnet-5-5",
      "claude-mythos-preview",
      "claude-haiku-5-5",
      "claude-fable-5-2",
      "anthropic.claude-opus-4-8-v1:0",
      "us.anthropic.claude-sonnet-5-v1:0",
      "claude-opus-4-7@20260601",
    ]) {
      expect(claudeRefusesSampling(m), m).toBe(true);
    }
    for (const m of [
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-20241022",
      "anthropic.claude-opus-4-6-v1:0",
      "claude-sonnet-4-6@20260301",
      "gpt-5",
    ]) {
      expect(claudeRefusesSampling(m), m).toBe(false);
    }
  });

  const api = new AnthropicApi({ provider: "anthropic", apiKey: "k" });
  const messages = [{ role: "user" as const, content: "Hi" }];
  type S = { temperature?: number; top_p?: number; top_k?: number };

  it("leaves the sampling fields out for a refusing model", () => {
    const b = api._convertToCleanAnthropicBody({
      model: "claude-opus-4-8",
      messages,
      temperature: 0.5,
      top_p: 0.9,
    }) as S;
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
  });

  it("is unchanged for an earlier model", () => {
    const b = api._convertToCleanAnthropicBody({
      model: "claude-sonnet-4-5",
      messages,
      temperature: 0.5,
    }) as S;
    expect(b.temperature).toBe(0.5);
  });

  it("applies on Bedrock", () => {
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-opus-4-8-v1:0",
        0.5,
        undefined,
        false,
      ),
    ).toEqual({});
    expect(
      bedrockSamplingParams(
        "us.anthropic.claude-sonnet-4-6",
        0.5,
        undefined,
        false,
      ),
    ).toEqual({ temperature: 0.5 });
  });
});

describe("omitSampling override (adapter copy)", () => {
  it("wins over the predicate in both directions", () => {
    expect(omitsSampling("claude-opus-4-8", false)).toBe(false);
    expect(omitsSampling("claude-sonnet-4-6", true)).toBe(true);
    expect(omitsSampling("claude-opus-4-8")).toBe(true);
  });
  it("is honoured by the Anthropic body", () => {
    const messages = [{ role: "user" as const, content: "Hi" }];
    type S = { temperature?: number; top_p?: number };
    const send = new AnthropicApi({
      provider: "anthropic",
      apiKey: "k",
      omitSampling: false,
    });
    expect(
      (
        send._convertToCleanAnthropicBody({
          model: "claude-opus-4-8",
          messages,
          temperature: 0.5,
        }) as S
      ).temperature,
    ).toBe(0.5);
    const omit = new AnthropicApi({
      provider: "anthropic",
      apiKey: "k",
      omitSampling: true,
    });
    expect(
      (
        omit._convertToCleanAnthropicBody({
          model: "claude-sonnet-4-6",
          messages,
          temperature: 0.5,
        }) as S
      ).temperature,
    ).toBeUndefined();
  });
  it("is honoured by the Bedrock sampling fields", () => {
    expect(
      bedrockSamplingParams(
        "anthropic.claude-opus-4-8-v1:0",
        0.5,
        0.9,
        false,
        false,
      ),
    ).toEqual({ temperature: 0.5 });
    expect(
      bedrockSamplingParams("amazon.nova-pro-v1:0", 0.5, 0.9, false, true),
    ).toEqual({});
  });
});
