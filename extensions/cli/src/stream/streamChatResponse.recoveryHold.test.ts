import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionFunctionTool } from "openai/resources.mjs";
import { describe, expect, it, vi } from "vitest";

import { streamChatResponse } from "./streamChatResponse.js";

/*
 * While a reply is held for tool call recovery the stream carries one chunk
 * that says so and one that says it is over; the callback follows them, once
 * each, and a stream without them never calls it.
 */

const writeTool: ChatCompletionFunctionTool = {
  type: "function",
  function: { name: "Write", parameters: { type: "object" } },
};

const handleToolCalls = vi.hoisted(() => vi.fn(async () => false));
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => [writeTool]),
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
  model: "us.amazon.nova-2-lite-v1:0",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "write a.txt" }, contextItems: [] },
];

const HOLD = (phase: "start" | "end") => ({
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  x_continue_recovery_hold: phase,
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

const run = (llmApi: BaseLlmApi, onRecoveryHold: (holding: boolean) => void) =>
  streamChatResponse(history, model, llmApi, new AbortController(), {
    onRecoveryHold,
  });

describe("a reply held for tool call recovery", () => {
  it("tells the caller when the hold starts and when it ends, once each", async () => {
    const onRecoveryHold = vi.fn();
    await run(
      llmApiStreaming([
        HOLD("start"),
        HOLD("end"),
        { choices: [{ delta: { content: "Done." } }] },
      ]),
      onRecoveryHold,
    );
    expect(onRecoveryHold.mock.calls).toEqual([[true], [false]]);
  });

  it("never calls it when the stream holds nothing", async () => {
    const onRecoveryHold = vi.fn();
    await run(
      llmApiStreaming([{ choices: [{ delta: { content: "Done." } }] }]),
      onRecoveryHold,
    );
    expect(onRecoveryHold).not.toHaveBeenCalled();
  });
});
