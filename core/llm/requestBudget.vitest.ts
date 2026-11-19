import { describe, expect, it } from "vitest";

import type { ChatMessage, CompletionOptions } from "../index.js";
import { BaseLLM } from "./index.js";
import { fitRequestMaxTokens, requestBudgetForModel } from "./requestBudget.js";

/**
 * The output cap that is sent, at the windows Claude is actually run with.
 * A configured 128,000 on a model whose cap is 64,000 is rejected before
 * any text. A prompt that has not been compacted can still be too large to
 * sit beside the full reply cap.
 */
describe("fitRequestMaxTokens", () => {
  it("lowers 128k to Claude 4.5's published 64k", () => {
    expect(
      fitRequestMaxTokens({
        configured: 128_000,
        modelMax: 64_000,
        window: 200_000,
        promptTokens: 1_000,
      }),
    ).toEqual({ maxTokens: 64_000, ceiling: 64_000 });
  });

  it("keeps 64k when the prompt is small beside a 200k window", () => {
    expect(
      fitRequestMaxTokens({
        configured: 64_000,
        modelMax: 64_000,
        window: 200_000,
        promptTokens: 10_000,
      }).maxTokens,
    ).toBe(64_000);
  });

  it("shrinks the reply when a 150k prompt would not fit beside 64k", () => {
    const budget = fitRequestMaxTokens({
      configured: 64_000,
      modelMax: 64_000,
      window: 200_000,
      promptTokens: 150_000,
    });
    expect(budget.maxTokens).toBeLessThanOrEqual(49_000);
    expect(150_000 + budget.maxTokens + 1_000).toBeLessThanOrEqual(200_000);
    expect(budget.ceiling).toBe(budget.maxTokens);
  });

  it("keeps 128k on a Claude 5 window of 1M", () => {
    expect(
      fitRequestMaxTokens({
        configured: 128_000,
        modelMax: 128_000,
        window: 1_000_000,
        promptTokens: 200_000,
      }).maxTokens,
    ).toBe(128_000);
  });

  it("does not send 128k into a configured 100k window", () => {
    const promptTokens = 80_000;
    const budget = fitRequestMaxTokens({
      configured: 128_000,
      modelMax: 128_000,
      window: 100_000,
      promptTokens,
    });
    expect(budget.maxTokens).toBeLessThan(128_000);
    expect(promptTokens + budget.maxTokens + 1_000).toBeLessThanOrEqual(
      100_000,
    );
  });

  it("a 128k config on a 64k model is the model cap, then the room", () => {
    const open = fitRequestMaxTokens({
      configured: 128_000,
      modelMax: 64_000,
      window: 100_000,
      promptTokens: 1_000,
    });
    expect(open.maxTokens).toBe(64_000);
    const tight = fitRequestMaxTokens({
      configured: 128_000,
      modelMax: 64_000,
      window: 100_000,
      promptTokens: 80_000,
    });
    expect(tight.maxTokens).toBeLessThan(64_000);
    expect(80_000 + tight.maxTokens + 1_000).toBeLessThanOrEqual(100_000);
  });

  it("Opus 4.1 stays at its 32k cap", () => {
    expect(
      fitRequestMaxTokens({
        configured: 128_000,
        modelMax: 32_000,
        window: 200_000,
        promptTokens: 4_000,
      }).maxTokens,
    ).toBe(32_000);
  });

  it("a small configured cap can still be raised up to the ceiling", () => {
    const budget = fitRequestMaxTokens({
      configured: 300,
      modelMax: 64_000,
      window: 200_000,
      promptTokens: 1_000,
    });
    expect(budget.maxTokens).toBe(300);
    expect(budget.ceiling).toBe(64_000);
  });

  it("resolves a Claude 4.5 id to the published 64k cap", () => {
    const budget = requestBudgetForModel({
      model: "claude-haiku-4-5",
      provider: "anthropic",
      configured: 128_000,
      contextLength: 200_000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(budget.asked).toBe(128_000);
    expect(budget.maxTokens).toBe(64_000);
    expect(budget.ceiling).toBe(64_000);
    expect(budget.promptTokens).toBeGreaterThan(0);
  });
});

class CaptureLLM extends BaseLLM {
  static providerName = "anthropic";
  seen?: CompletionOptions;
  protected async *_streamChat(
    _messages: ChatMessage[],
    _signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    this.seen = options;
    yield { role: "assistant", content: "ok" };
  }
}

describe("streamChat sends a cap the model will accept", () => {
  it("asks Haiku 4.5 for 64k when the config says 128k", async () => {
    const llm = new CaptureLLM({
      model: "claude-haiku-4-5",
      contextLength: 200_000,
      completionOptions: { model: "claude-haiku-4-5", maxTokens: 128_000 },
    });
    for await (const _ of llm.streamChat(
      [{ role: "user", content: "Implement the ledger. Read the spec first." }],
      new AbortController().signal,
      { model: "claude-haiku-4-5", maxTokens: 128_000 },
    )) {
      // one chunk
    }
    expect(llm.seen?.maxTokens).toBe(64_000);
    expect(llm.seen?.maxTokensCeiling).toBe(64_000);
  });

  it("asks Sonnet 5.5 for less than 128k inside a 100k window", async () => {
    const llm = new CaptureLLM({
      model: "claude-sonnet-5-5",
      contextLength: 100_000,
      completionOptions: { model: "claude-sonnet-5-5", maxTokens: 128_000 },
    });
    const messages: ChatMessage[] = [
      { role: "user", content: "Implement the ledger and keep going." },
    ];
    for await (const _ of llm.streamChat(
      messages,
      new AbortController().signal,
      { model: "claude-sonnet-5-5", maxTokens: 128_000 },
    )) {
      // one chunk
    }
    expect(llm.seen?.maxTokens).toBeLessThan(128_000);
    expect(llm.seen?.maxTokensCeiling).toBeLessThanOrEqual(100_000);
  });
});
