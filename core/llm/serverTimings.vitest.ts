import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMessage, Usage } from "../index.js";
import llamaCpp from "./__fixtures__/llamacpp/stream-drafts.json";
import ollamaOpenAI from "./__fixtures__/ollama/openai-stream-cache-hit.json";
import strata from "./__fixtures__/strata/stream-2026-11-15-reread.json";
import OpenAI from "./llms/OpenAI";
import { resetPromptProgressSupport } from "./localServers";
import {
  ollamaUsage,
  serverTimingsOf,
  withServerTimings,
} from "./serverTimings";

/** No /props, no /metrics: the stream alone says what the server timed. */
const noServerInfo = vi.fn(async () => new Response("{}", { status: 404 }));

beforeEach(() => {
  resetPromptProgressSupport();
  vi.stubGlobal("fetch", noServerInfo);
});
afterEach(() => vi.unstubAllGlobals());

async function usageOfStream(
  chunks: unknown[],
  apiBase = "http://127.0.0.1:8083/v1/",
): Promise<Usage> {
  const llm = new OpenAI({ model: "qwen", apiBase, apiKey: "k" });
  (llm as any).openaiAdapter = {
    chatCompletionStream: async function* () {
      for (const c of chunks) yield c;
    },
  };
  const out: ChatMessage[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "x" }],
    new AbortController().signal,
  )) {
    out.push(m);
  }
  const withUsage = out.filter((m) => m.role === "assistant" && m.usage);
  expect(withUsage).toHaveLength(1);
  return (withUsage[0] as any).usage;
}

describe("llama.cpp timings", () => {
  it("maps every field, drafts included, and takes cache_n as the cached count", async () => {
    const usage = await usageOfStream(llamaCpp.chunks);
    expect(usage.serverTimings).toEqual({
      promptN: 2000,
      cacheN: 10_000,
      promptMs: 800,
      promptPerSecond: 2500,
      predictedN: 400,
      predictedMs: 5000,
      predictedPerSecond: 80,
      draftN: 300,
      draftNAccepted: 240,
    });
    expect(usage.promptTokensPerSecond).toBe(2500);
    expect(usage.promptTokensDetails?.cachedTokens).toBe(10_000);
  });

  it("keeps timings sent on an earlier chunk than the usage", async () => {
    const [reasoning, text, last] = llamaCpp.chunks as any[];
    const { usage, timings, ...finish } = last;
    const usageOnly = { ...finish, choices: [], usage };
    const out = await usageOfStream([
      reasoning,
      text,
      { ...finish, timings },
      usageOnly,
    ]);
    expect(out.serverTimings?.predictedPerSecond).toBe(80);
  });

  it("leaves a usage without timings alone (a cloud API)", async () => {
    const [, text] = llamaCpp.chunks as any[];
    const usage = await usageOfStream(
      [
        text,
        {
          id: "c",
          object: "chat.completion.chunk",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ],
      "https://api.openai.com/v1/",
    );
    expect(usage.serverTimings).toBeUndefined();
    expect(usage.promptTokensPerSecond).toBeUndefined();
  });
});

describe("Strata timings", () => {
  it("carries the read, the decode speed and the drafts of the section 5 request", async () => {
    const usage = await usageOfStream(strata.chunks);
    expect(usage.serverTimings).toMatchObject({
      promptN: 401_472,
      cacheN: 16_384,
      promptPerSecond: 4649,
      predictedN: 729,
      predictedPerSecond: 74.5,
      draftN: 530,
      draftNAccepted: 420,
    });
    // Strata's prompt_n already leaves the cache out: copied as is
    expect(usage.promptTokensPerSecond).toBe(4649);
    expect(usage.promptTokensDetails?.cachedTokens).toBe(16_384);
  });

  it("drops the nulls Strata sends for a rate it cannot tell", () => {
    expect(
      serverTimingsOf({
        cache_n: 500,
        prompt_n: 0,
        prompt_ms: 3,
        prompt_per_second: null,
        predicted_n: 0,
        predicted_ms: null,
        predicted_per_second: null,
      }),
    ).toEqual({ promptN: 0, cacheN: 500, promptMs: 3, predictedN: 0 });
  });
});

describe("Ollama's OpenAI-compatible endpoint after a cache hit", () => {
  it("recomputes the read speed from the uncached tokens", async () => {
    const usage = await usageOfStream(
      ollamaOpenAI.chunks,
      "http://127.0.0.1:11434/v1/",
    );
    // Ollama says 80,000 tok/s: 20,000 tokens over 250 ms, 19,000 of them cached
    expect(ollamaOpenAI.chunks[2].timings?.prompt_per_second).toBe(80_000);
    expect(usage.promptTokensPerSecond).toBe(4000);
    expect(usage.serverTimings).toMatchObject({
      promptN: 1000,
      cacheN: 19_000,
      promptMs: 250,
      promptPerSecond: 4000,
      predictedPerSecond: 50,
    });
    expect(usage.promptTokensDetails?.cachedTokens).toBe(19_000);
  });

  it("copies the rate when the server does not give the cached count", () => {
    const usage = withServerTimings(
      { promptTokens: 20_000, completionTokens: 300 },
      { prompt_n: 20_000, prompt_ms: 250, prompt_per_second: 80_000 },
    );
    expect(usage.promptTokensPerSecond).toBe(80_000);
  });

  it("gives no read speed when the whole prompt came from the cache", () => {
    const usage = withServerTimings(
      {
        promptTokens: 20_000,
        completionTokens: 1,
        promptTokensDetails: { cachedTokens: 20_000 },
      },
      { prompt_n: 20_000, prompt_ms: 40, prompt_per_second: 500_000 },
    );
    expect(usage.promptTokensPerSecond).toBeUndefined();
    expect(usage.serverTimings).toMatchObject({ promptN: 0, cacheN: 20_000 });
  });
});

describe("ollamaUsage (native /api/chat done line)", () => {
  it("maps the counts, the four durations and the load time", () => {
    expect(
      ollamaUsage({
        total_duration: 7_400_000_000,
        load_duration: 900_000_000,
        prompt_eval_count: 20_000,
        prompt_eval_cached_count: 19_000,
        prompt_eval_duration: 250_000_000,
        eval_count: 300,
        eval_duration: 6_000_000_000,
      }),
    ).toEqual({
      promptTokens: 20_000,
      completionTokens: 300,
      promptTokensDetails: { cachedTokens: 19_000 },
      promptTokensPerSecond: 4000,
      serverTimings: {
        promptN: 1000,
        cacheN: 19_000,
        promptMs: 250,
        promptPerSecond: 4000,
        predictedN: 300,
        predictedMs: 6000,
        predictedPerSecond: 50,
        loadMs: 900,
        totalMs: 7400,
      },
    });
  });

  it("works on an older server with no cached count", () => {
    const usage = ollamaUsage({
      prompt_eval_count: 1000,
      prompt_eval_duration: 500_000_000,
      eval_count: 10,
      eval_duration: 200_000_000,
    })!;
    expect(usage.promptTokensDetails).toBeUndefined();
    expect(usage.promptTokensPerSecond).toBe(2000);
    expect(usage.serverTimings?.predictedPerSecond).toBe(50);
  });

  it("is undefined on a line without counts", () => {
    expect(ollamaUsage({ total_duration: 5 })).toBeUndefined();
  });
});
