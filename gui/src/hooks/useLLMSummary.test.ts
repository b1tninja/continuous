import { renderHook } from "@testing-library/react";
import type { RequestTiming } from "core";
import { describe, expect, it } from "vitest";
import useLLMSummary, { firstOutputItem } from "./useLLMSummary";
import type { LLMInteraction, LLMResult } from "./useLLMLog";

const T0 = 1_000_000;

const message = (timestamp: number, m: any): LLMResult =>
  ({
    kind: "message",
    interactionId: "i",
    timestamp,
    message: m,
  }) as LLMResult;

// A llama.cpp-style local server: progress for 86 s, then the reply
const results: LLMResult[][] = [
  [
    message(T0 + 1_000, {
      role: "assistant",
      content: "",
      promptProgress: { total: 10, cache: 0, processed: 1, timeMs: 1 },
    }),
    message(T0 + 50_000, {
      role: "assistant",
      content: "",
      promptProgress: { total: 10, cache: 0, processed: 9, timeMs: 1 },
    }),
    message(T0 + 86_000, { role: "assistant", content: "Hi" }),
    message(T0 + 96_000, { role: "assistant", content: " there" }),
  ],
];

function interaction(timing?: Partial<RequestTiming>): LLMInteraction {
  return {
    start: {
      kind: "startChat",
      interactionId: "i",
      timestamp: T0,
      messages: [],
      options: { model: "qwen" },
      provider: "openai",
    },
    results,
    end: {
      kind: "success",
      interactionId: "i",
      timestamp: T0 + 96_000,
      promptTokens: 10,
      generatedTokens: 500,
      thinkingTokens: 0,
      usage: undefined,
      ...(timing && { timing: timing as RequestTiming }),
    },
  } as unknown as LLMInteraction;
}

describe("console To First Token (J21)", () => {
  it("skips prompt progress when finding the first token", () => {
    expect(firstOutputItem(results)?.timestamp).toBe(T0 + 86_000);
  });

  it("without a timing record, counts from the first reply item", () => {
    const { result } = renderHook(() => useLLMSummary(interaction()));
    expect(result.current.toFirstToken).toBe(86_000);
    // 500 tokens over the 10 s after the first token
    expect(result.current.tokensPerSecond).toBe(50);
  });

  it("uses the request's timing record when the end carries one", () => {
    const { result } = renderHook(() =>
      useLLMSummary(
        interaction({
          firstTokenMs: { value: 85_900, source: "measured" },
          outputRate: { value: 74.5, source: "server" },
        }),
      ),
    );
    expect(result.current.toFirstToken).toBe(85_900);
    expect(result.current.tokensPerSecond).toBe(74.5);
  });
});
