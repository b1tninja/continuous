import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem, PromptProgress } from "core/index.js";
import { resetPromptProgressSupport } from "core/llm/localServers.js";
import { render } from "ink-testing-library";
import React, { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionStatus, spinnerMessage } from "../ui/components/ActionStatus.js";

import { streamChatResponse } from "./streamChatResponse.js";

/*
 * J17: a llama.cpp-style local server (llama.cpp, Strata) is asked for
 * `prompt_progress` with `return_progress: true`, and the updates reach the
 * spinner row at most once a second, or stderr in headless `--verbose` at
 * most every 10 s. The chunk shapes are llama.cpp's, as in
 * core/llm/promptProgress.vitest.ts.
 */

const isHeadless = vi.hoisted(() => vi.fn(() => false));

vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls: vi.fn(async () => false),
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
      isHeadless,
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A server that answers /props as llama.cpp and Strata do. */
const llamaCppServer = vi.fn(async (url: URL | string) =>
  new URL(String(url)).pathname === "/props"
    ? json({ default_generation_settings: { n_ctx: 4096 }, total_slots: 1 })
    : json({ error: "not found" }, 404),
);
/** A local server without /props (vLLM, LM Studio). */
const noPropsServer = vi.fn(async () => json({ error: "not found" }, 404));

const localModel = {
  provider: "openai",
  name: "qwen",
  model: "qwen",
  apiBase: "http://127.0.0.1:8083/v1/",
  apiKey: "k",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const cloudModel = {
  provider: "openai",
  name: "gpt",
  model: "gpt-4.1",
  apiKey: "k",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "read all of it" }, contextItems: [] },
];

/** llama.cpp's update while it reads the prompt (an empty delta, no text). */
const progress = (processed: number, timeMs: number) => ({
  id: "c",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  prompt_progress: { total: 1000, cache: 200, processed, time_ms: timeMs },
});
const text = (content: string) => ({
  id: "c",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

/** A step of a fixture stream: a chunk, the clock it arrives at, or a pause. */
type Step = { at: number; chunk: unknown } | { gate: Promise<void> };

function llmApiStreaming(steps: Step[]) {
  const sent: any[] = [];
  const llmApi = {
    chatCompletionStream: vi.fn().mockImplementation(async (body: any) => {
      sent.push(body);
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const step of steps) {
            if ("gate" in step) {
              await step.gate;
              continue;
            }
            vi.setSystemTime(step.at);
            yield step.chunk;
          }
        },
      };
    }),
  } as unknown as BaseLlmApi;
  return { llmApi, sent };
}

const expected = (processed: number, timeMs: number): PromptProgress => ({
  total: 1000,
  cache: 200,
  processed,
  timeMs,
});

const argv = process.argv;

beforeEach(() => {
  resetPromptProgressSupport();
  llamaCppServer.mockClear();
  noPropsServer.mockClear();
  vi.stubGlobal("fetch", llamaCppServer);
  vi.useFakeTimers({ toFake: ["Date"], now: 0 });
  isHeadless.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.argv = argv;
});

describe("prompt progress in the CLI", () => {
  it("asks a llama.cpp-style local server for it, passes it on at most once a second, and clears it when the reply starts", async () => {
    const { llmApi, sent } = llmApiStreaming([
      { at: 0, chunk: progress(300, 100) },
      { at: 400, chunk: progress(400, 200) },
      { at: 900, chunk: progress(500, 300) },
      { at: 1100, chunk: progress(600, 400) },
      { at: 1500, chunk: text("Done.") },
    ]);
    const onPromptProgress = vi.fn();
    const onContent = vi.fn();
    await streamChatResponse(
      history,
      localModel,
      llmApi,
      new AbortController(),
      {
        onPromptProgress,
        onContent,
      },
    );
    expect(sent[0].return_progress).toBe(true);
    expect(onPromptProgress.mock.calls).toEqual([
      [expected(300, 100)],
      [expected(600, 400)],
      [undefined],
    ]);
    // The updates are not part of the reply
    expect(onContent.mock.calls).toEqual([["Done."]]);
  });

  it("never sends the field to, or asks, a cloud API", async () => {
    const { llmApi, sent } = llmApiStreaming([{ at: 0, chunk: text("hi") }]);
    const onPromptProgress = vi.fn();
    await streamChatResponse(
      history,
      cloudModel,
      llmApi,
      new AbortController(),
      {
        onPromptProgress,
        onContent: vi.fn(),
      },
    );
    expect(sent[0]).not.toHaveProperty("return_progress");
    expect(llamaCppServer).not.toHaveBeenCalled();
    expect(onPromptProgress).not.toHaveBeenCalled();
  });

  it("does not send it to a local server without /props, and shows nothing without progress", async () => {
    vi.stubGlobal("fetch", noPropsServer);
    const { llmApi, sent } = llmApiStreaming([{ at: 0, chunk: text("hi") }]);
    const onPromptProgress = vi.fn();
    await streamChatResponse(
      history,
      localModel,
      llmApi,
      new AbortController(),
      {
        onPromptProgress,
        onContent: vi.fn(),
      },
    );
    expect(noPropsServer).toHaveBeenCalled();
    expect(sent[0]).not.toHaveProperty("return_progress");
    expect(onPromptProgress).not.toHaveBeenCalled();
  });

  it("shows the reading line in the spinner row while the prompt is read, and not once the reply starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { llmApi } = llmApiStreaming([
      { at: 0, chunk: progress(600, 400) },
      { gate },
      { at: 2000, chunk: text("Done.") },
    ]);
    let finished = false;
    function SpinnerRow() {
      const [p, setP] = useState<PromptProgress | undefined>(undefined);
      useEffect(() => {
        void streamChatResponse(
          history,
          localModel,
          llmApi,
          new AbortController(),
          { onPromptProgress: setP, onContent: () => {} },
        ).then(() => (finished = true));
      }, []);
      return (
        <ActionStatus
          visible={true}
          startTime={0}
          message={spinnerMessage(false, p)}
        />
      );
    }
    const { lastFrame, unmount } = render(<SpinnerRow />);
    await vi.waitFor(() =>
      expect(lastFrame()).toContain(
        "Reading the prompt: 400 of 800 tokens, 200 from the cache, about 1 s left",
      ),
    );
    release();
    await vi.waitFor(() => expect(finished).toBe(true));
    await vi.waitFor(() => expect(lastFrame()).not.toContain("Reading"));
    unmount();
  });
});

describe("prompt progress in headless mode", () => {
  const steps = (): Step[] => [
    { at: 0, chunk: progress(300, 100) },
    { at: 5000, chunk: progress(400, 200) },
    { at: 10_000, chunk: progress(600, 400) },
    { at: 12_000, chunk: text("Done.") },
  ];

  it("prints at most one line every 10 s to stderr with --verbose", async () => {
    isHeadless.mockReturnValue(true);
    process.argv = [...argv, "--verbose"];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { llmApi, sent } = llmApiStreaming(steps());
    await streamChatResponse(
      history,
      localModel,
      llmApi,
      new AbortController(),
    );
    expect(sent[0].return_progress).toBe(true);
    const lines = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.startsWith("Reading the prompt"));
    expect(lines).toEqual([
      "Reading the prompt: 100 of 800 tokens, 200 from the cache, about 1 s left\n",
      "Reading the prompt: 400 of 800 tokens, 200 from the cache, about 1 s left\n",
    ]);
  });

  it("prints nothing, and does not ask, without --verbose", async () => {
    isHeadless.mockReturnValue(true);
    process.argv = argv.filter((a) => a !== "--verbose");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { llmApi, sent } = llmApiStreaming(steps());
    await streamChatResponse(
      history,
      localModel,
      llmApi,
      new AbortController(),
    );
    expect(sent[0]).not.toHaveProperty("return_progress");
    expect(llamaCppServer).not.toHaveBeenCalled();
    expect(
      stderr.mock.calls.some(([chunk]) =>
        String(chunk).startsWith("Reading the prompt"),
      ),
    ).toBe(false);
  });
});
