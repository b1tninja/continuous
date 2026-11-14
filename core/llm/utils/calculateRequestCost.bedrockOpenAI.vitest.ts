import { describe, expect, it } from "vitest";
import {
  calculateRequestCost,
  findBedrockOpenAIPricing,
} from "./calculateRequestCost";

const MTOK = 1_000_000;
const io = (input: number, output: number) =>
  ({ promptTokens: input, completionTokens: output }) as any;
const cost = (provider: string, model: string, usage = io(MTOK, MTOK)) =>
  calculateRequestCost(provider, model, usage, { community: false });

// Prices the AI gateway's model table lists, per MTok (in / out), and what
// AWS's price list says for Grok (2026-11-14)
describe("Bedrock OpenAI and xAI profiles", () => {
  it.each([
    ["us.openai.gpt-6.1-sol", 2.2 + 11],
    ["us.openai.gpt-6-sol", 2.2 + 11],
    ["us.openai.gpt-6-luna", 0.11 + 0.55],
    ["us.openai.gpt-5.6-sol", 4.4 + 22],
    ["us.openai.gpt-5.6-terra", 2.2 + 13.2],
    ["us.openai.gpt-5.6-luna", 0.22 + 1.32],
    ["us.xai.grok-4.6", 2.2 + 6.6],
    ["us.xai.grok-4.7", 2.2 + 6.6],
  ])("%s costs $%s for 1M in and 1M out", (model, expected) => {
    expect(cost("bedrock", model)?.cost).toBeCloseTo(expected, 6);
  });

  it("prices a global profile at list, without the premium", () => {
    expect(cost("bedrock", "global.openai.gpt-6.1-sol")?.cost).toBeCloseTo(
      2 + 10,
      6,
    );
  });

  it("says where the price came from and that the premium was applied", () => {
    const r = cost("bedrock", "us.openai.gpt-6.1-sol");
    expect(r?.priceSource?.label).toMatch(/OpenAI/);
    expect(r?.breakdown).toMatch(
      /OpenAI list .* 1\.1 \(Bedrock regional endpoint\)/,
    );
  });

  it("prices cache reads at the cached-input rate (Bedrock leaves them out of promptTokens)", () => {
    const r = cost("bedrock", "global.openai.gpt-6.1-sol", {
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: { cachedTokens: MTOK },
    } as any);
    // GPT-6.1 Sol's cached input is $0.10 per MTok on OpenAI's list
    expect(r?.cost).toBeCloseTo(0.1, 6);
  });

  it("leaves GPT OSS to its AWS rows and Daybreak Blue unpriced", () => {
    expect(cost("bedrock", "openai.gpt-oss-120b-1:0")?.cost).toBeCloseTo(
      0.15 + 0.6,
      6,
    );
    expect(findBedrockOpenAIPricing("openai.gpt-oss-120b-1:0")).toBeNull();
    expect(
      cost("bedrock-mantle", "openai.gpt-daybreak-blue-5.6-sol"),
    ).toBeNull();
  });

  it("reads the model out of the Bedrock ID", () => {
    expect(findBedrockOpenAIPricing("us.openai.gpt-6.1-sol")?.input).toBe(2);
    expect(findBedrockOpenAIPricing("openai.gpt-5.6-terra")?.output).toBe(12);
    expect(findBedrockOpenAIPricing("us.anthropic.claude-opus-5-5")).toBeNull();
    expect(findBedrockOpenAIPricing("us.openai.gpt-unknown-9")).toBeNull();
  });
});
