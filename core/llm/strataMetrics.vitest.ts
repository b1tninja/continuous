import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, PromptLog } from "../index.js";
import OpenAI from "./llms/OpenAI";
import {
  parseStrataMetrics,
  resetPromptProgressSupport,
  resetStrataServers,
  strataEntryFor,
  strataRequestCache,
} from "./localServers";

/** Strata's /metrics on 2026-11-15, trimmed to counts (no text). */
const METRICS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "strata-metrics-2026-11-15.trimmed.json"),
    "utf8",
  ),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A Strata server: /v1/status says so, /metrics is the fixture. */
function strata(metrics: unknown = METRICS) {
  return vi.fn(async (url: URL | string) => {
    const p = new URL(String(url)).pathname;
    if (p === "/v1/status") return json({ service: "strata" });
    if (p === "/metrics") return json(metrics);
    if (p === "/props") return json({ total_slots: 1 });
    return json({ error: "not found" }, 404);
  });
}

afterEach(() => {
  resetStrataServers();
  resetPromptProgressSupport();
  vi.unstubAllGlobals();
});

describe("parseStrataMetrics", () => {
  it("reads every request's prompt size and reuse, newest first", () => {
    const entries = parseStrataMetrics(METRICS);
    expect(entries).toHaveLength(12);
    expect(entries[0]).toMatchObject({
      id: "62d8f27624dd",
      promptTokens: 402371,
      reused: 402246,
      promptRead: 125,
    });
    // The two misses of the brief: 16384 reused, the rest read again
    const misses = entries.filter((e) => e.reused === 16384);
    expect(misses.map((e) => e.id)).toEqual([
      "dd863c712151",
      "45e05c2fea20",
      "354a8e60e375",
    ]);
    expect(misses[1]).toMatchObject({
      promptTokens: 400398,
      promptRead: 384014,
    });
  });

  it("is empty for anything that is not a metrics answer", () => {
    expect(parseStrataMetrics(undefined)).toEqual([]);
    expect(parseStrataMetrics({ requests: "no" })).toEqual([]);
    expect(parseStrataMetrics({ requests: [{ id: "x" }] })).toEqual([]);
  });
});

describe("strataEntryFor", () => {
  const entries = parseStrataMetrics(METRICS);

  it("picks the request that started after the send, by its prompt size", () => {
    const startedAt = 1794766908.9605877 * 1000 - 200;
    expect(
      strataEntryFor(entries, { startedAt, promptTokens: 400398 })?.id,
    ).toBe("45e05c2fea20");
  });

  it("finds nothing for a size the server did not see", () => {
    expect(
      strataEntryFor(entries, { startedAt: 0, promptTokens: 1 }),
    ).toBeUndefined();
  });

  it("does not pick a request that started long before this one", () => {
    expect(
      strataEntryFor(entries, {
        startedAt: (1794767670.9958565 + 60) * 1000,
      }),
    ).toBeUndefined();
  });
});

describe("strataRequestCache", () => {
  it("asks Strata's /metrics once per request, after asking /v1/status once", async () => {
    const fetchFn = strata();
    const request = { startedAt: 0, promptTokens: 401835 };
    const a = await strataRequestCache(
      "http://127.0.0.1:8086/v1/",
      request,
      fetchFn,
    );
    expect(a).toMatchObject({ id: "dd863c712151", reused: 16384 });
    await strataRequestCache("http://127.0.0.1:8086/v1/", request, fetchFn);
    const paths = fetchFn.mock.calls.map(([u]) => new URL(String(u)).pathname);
    expect(paths).toEqual(["/v1/status", "/metrics", "/metrics"]);
  });

  it("never asks a cloud address or a server that is not Strata", async () => {
    const fetchFn = vi.fn(async () => json({ service: "llama.cpp" }));
    expect(
      await strataRequestCache(
        "https://api.openai.com/v1/",
        { startedAt: 0 },
        fetchFn,
      ),
    ).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(
      await strataRequestCache(
        "http://127.0.0.1:8080/v1/",
        { startedAt: 0 },
        fetchFn,
      ),
    ).toBeUndefined();
    expect(
      fetchFn.mock.calls.map(([u]) => new URL(String(u)).pathname),
    ).toEqual(["/v1/status"]);
  });
});

describe("the chat stream's cached count from a local server", () => {
  async function run(chunks: any[], fetchFn = strata()) {
    vi.stubGlobal("fetch", fetchFn);
    const llm = new OpenAI({
      model: "qwen3.8-flash-next-nvfp4-uncensored",
      apiBase: "http://127.0.0.1:8086/v1/",
      apiKey: "k",
    });
    (llm as any).openaiAdapter = {
      chatCompletionStream: async function* () {
        for (const c of chunks) yield c;
      },
    };
    const gen = llm.streamChat(
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
    );
    const out: ChatMessage[] = [];
    let next = await gen.next();
    while (!next.done) {
      out.push(next.value);
      next = await gen.next();
    }
    return { out, log: next.value as PromptLog, fetchFn };
  }

  const text = {
    id: "c",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
  };
  const usage = (extra: object = {}) => ({
    id: "c",
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 401835, completion_tokens: 54 },
    ...extra,
  });

  it("takes llama.cpp's timings.cache_n when the usage has no cached count", async () => {
    const { out, log, fetchFn } = await run([
      text,
      usage({ timings: { cache_n: 16384, prompt_per_second: 1300 } }),
    ]);
    const withUsage = out.find((m: any) => m.usage) as any;
    expect(withUsage.usage.promptTokensDetails.cachedTokens).toBe(16384);
    expect(log.serverCache).toBeUndefined();
    expect(
      fetchFn.mock.calls.some(
        ([u]) => new URL(String(u)).pathname === "/metrics",
      ),
    ).toBe(false);
  });

  it("reads Strata's /metrics after the request when the stream said nothing", async () => {
    // Sent just before the server's record of request dd863c712151 starts
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1794767268.9677176 * 1000 - 300);
    const { log } = await run([text, usage()]);
    vi.useRealTimers();
    expect(log.serverCache).toEqual({
      promptTokens: 401835,
      reused: 16384,
      promptRead: 385451,
      promptMs: 295050.1,
    });
  });

  it("reads nothing more when the usage has the cached count", async () => {
    const { log, fetchFn } = await run([
      text,
      usage({
        usage: {
          prompt_tokens: 401835,
          completion_tokens: 54,
          prompt_tokens_details: { cached_tokens: 401365 },
        },
      }),
    ]);
    expect(log.serverCache).toBeUndefined();
    expect(
      fetchFn.mock.calls.some(
        ([u]) => new URL(String(u)).pathname === "/metrics",
      ),
    ).toBe(false);
  });
});
