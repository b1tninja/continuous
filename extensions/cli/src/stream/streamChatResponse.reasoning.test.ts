import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it, vi } from "vitest";

import { streamChatResponse } from "./streamChatResponse.js";

/*
 * A reply's reasoning streams to onReasoning piece by piece, never into the
 * reply's content; the whole of it reaches onReasoningComplete once, before
 * the reply's message, and goes to the history writer with the reply.
 */

const handleToolCalls = vi.hoisted(() => vi.fn(async (_options: any) => false));
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls,
  };
});

vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return {
    ...actual,
    getSessionTaskPlan: () => undefined,
    getSessionLoop: () => undefined,
    trackSessionUsage: vi.fn(),
  };
});

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(async () => "sys"),
      turnTail: vi.fn(() => undefined),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: {
      isReady: vi.fn(() => false),
      getHistory: vi.fn(() => []),
    },
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const model = {
  provider: "anthropic",
  model: "claude-opus-4-6",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "why?" }, contextItems: [] },
];

const delta = (d: Record<string, unknown>) => ({
  choices: [{ index: 0, delta: d, finish_reason: null }],
});

function llmApiStreaming(chunks: unknown[]) {
  return {
    chatCompletionStream: vi.fn().mockImplementation(async () => ({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    })),
  } as unknown as BaseLlmApi;
}

describe("the model's reasoning in the CLI stream", () => {
  it("streams reasoning live, keeps it out of the reply, and hands it on whole", async () => {
    handleToolCalls.mockClear();
    const live: string[] = [];
    const order: string[] = [];
    const completed: any[] = [];
    const reply = await streamChatResponse(
      history,
      model,
      llmApiStreaming([
        delta({ reasoning_content: "Because " }),
        delta({ reasoning_content: "it is." }),
        delta({ reasoning_details: [{ signature: "sig" }] }),
        delta({ content: "It is." }),
      ]),
      new AbortController(),
      {
        onReasoning: (text) => live.push(text),
        onReasoningComplete: (reasoning) => {
          order.push("reasoning");
          completed.push(reasoning);
        },
        onContentComplete: () => order.push("message"),
      },
    );
    expect(live).toEqual(["Because ", "it is."]);
    expect(reply).toBe("It is.");
    expect(order).toEqual(["reasoning", "message"]);
    expect(completed).toHaveLength(1);
    expect(completed[0].text).toBe("Because it is.");
    expect(completed[0].details).toEqual([
      { type: "reasoning.text", text: "Because it is.", signature: "sig" },
    ]);
    expect(completed[0].endAt).toBeGreaterThanOrEqual(completed[0].startAt);

    const written = handleToolCalls.mock.calls[0][0];
    expect(written.content).toBe("It is.");
    expect(written.reasoning.text).toBe("Because it is.");
  });

  it("reads OpenRouter's reasoning string and Responses' reasoning object once each", async () => {
    const live: string[] = [];
    await streamChatResponse(
      history,
      model,
      llmApiStreaming([
        // OpenRouter sends the same text twice: counted once
        delta({
          reasoning: "Weighing.",
          reasoning_details: [{ type: "reasoning.text", text: "Weighing." }],
        }),
        delta({
          reasoning: { content: [{ type: "reasoning_text", text: " Done." }] },
        }),
        delta({ content: "OK" }),
      ]),
      new AbortController(),
      { onReasoning: (text) => live.push(text) },
    );
    expect(live.join("")).toBe("Weighing. Done.");
  });

  it("calls nothing for a reply without reasoning", async () => {
    handleToolCalls.mockClear();
    const onReasoningComplete = vi.fn();
    await streamChatResponse(
      history,
      model,
      llmApiStreaming([delta({ content: "Plain." })]),
      new AbortController(),
      { onReasoningComplete },
    );
    expect(onReasoningComplete).not.toHaveBeenCalled();
    expect(handleToolCalls.mock.calls[0][0].reasoning).toBeUndefined();
  });
});
