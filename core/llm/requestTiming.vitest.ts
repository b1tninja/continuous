import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMessage, LLMInteractionItemDetails, Usage } from "../index.js";
import llamaCpp from "./__fixtures__/llamacpp/stream-drafts.json";
import strata from "./__fixtures__/strata/stream-2026-11-15-reread.json";
import anthropic from "./__fixtures__/timing/anthropic-thinking-omitted.json";
import bedrock from "./__fixtures__/timing/bedrock-converse.json";
import openai from "./__fixtures__/timing/openai-tool-call.json";
import OpenAI from "./llms/OpenAI";
import { resetPromptProgressSupport } from "./localServers";
import {
  MIN_LIVE_MS,
  RequestTimer,
  STALL_MS,
  withTiming,
} from "./requestTiming";
import { ollamaUsage } from "./serverTimings";

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Replays `events` (ms after sending) into a timer started at T0. */
function replay(events: { at: number; message: unknown }[]) {
  const timer = new RequestTimer();
  for (const e of events) {
    vi.setSystemTime(T0 + e.at);
    timer.chunk(e.message as ChatMessage);
  }
  return timer;
}

const phasesOf = (t: { phases: { phase: string; tool?: string }[] }) =>
  t.phases.map((p) => (p.tool ? `${p.phase}:${p.tool}` : p.phase));

describe("Anthropic, thinking not shown", () => {
  it("is thinking from the empty delta, then writing; the rate is measured", () => {
    const timer = replay(anthropic.events);
    const r = timer.finish();
    expect(phasesOf(r)).toEqual(["waiting", "thinking", "writing"]);
    expect(r.thinkingHidden).toBe(true);
    expect(r.firstTokenMs).toEqual({ value: 1400, source: "measured" });
    expect(r.firstContentAt).toBe(T0 + 6300);
    expect(r.outputTokens).toEqual({ value: 310, source: "server" });
    // 310 tokens from the first token (1.4 s) to the end (7.4 s)
    expect(r.outputRate?.source).toBe("measured");
    expect(r.outputRate?.value).toBeCloseTo(310 / 6, 6);
    expect(r.promptTokens).toBe(1200);
    // No prompt speed: Anthropic does not report one
    expect(r.prefill).toBeUndefined();
    expect(r.drafts).toBeUndefined();
  });
});

describe("OpenAI, a tool call", () => {
  it("names the tool, counts its argument bytes and measures the rate", () => {
    const r = replay(openai.events).finish();
    expect(phasesOf(r)).toEqual(["waiting", "writing", "tool-call:edit_file"]);
    expect(r.toolName).toBe("edit_file");
    // "é" is two bytes
    expect(r.toolArgBytes).toBe(27 + 15);
    expect(r.outputChars).toBe("Let me edit it.".length + 41);
    expect(r.firstContentAt).toBe(T0 + 900);
    expect(r.outputRate).toEqual({ value: 40, source: "measured" });
  });

  it("starts a new phase entry for a second tool", () => {
    const timer = replay(openai.events);
    vi.setSystemTime(T0 + 3100);
    timer.chunk({
      role: "assistant",
      content: "",
      toolCalls: [{ type: "function", function: { name: "read_file" } }],
    });
    expect(phasesOf(timer.snapshot()).at(-1)).toBe("tool-call:read_file");
  });
});

describe("Bedrock ConverseStream", () => {
  it("carries the server latency beside the measured rate", () => {
    const r = replay(bedrock.events).finish();
    expect(phasesOf(r)).toEqual(["waiting", "thinking", "writing"]);
    expect(r.thinkingHidden).toBeUndefined();
    expect(r.serverLatencyMs).toBe(21_400);
    expect(r.firstTokenMs?.value).toBe(1600);
    // 1,220 tokens over 20 s
    expect(r.outputRate).toEqual({ value: 61, source: "measured" });
    expect(r.prefill).toBeUndefined();
  });
});

describe("Ollama native", () => {
  it("takes the server's decode speed, load time and uncached read", () => {
    const usage = ollamaUsage({
      load_duration: 900_000_000,
      prompt_eval_count: 20_000,
      prompt_eval_cached_count: 19_000,
      prompt_eval_duration: 250_000_000,
      eval_count: 300,
      eval_duration: 6_000_000_000,
    })!;
    const r = replay([
      { at: 1200, message: { role: "assistant", content: "Hel" } },
      { at: 7200, message: { role: "assistant", content: "lo", usage } },
    ]).finish();
    expect(r.outputRate).toEqual({ value: 50, source: "server" });
    expect(r.loadMs).toBe(900);
    expect(r.prefill).toEqual({
      read: 1000,
      cached: 19_000,
      ms: 250,
      rate: 4000,
      source: "server",
    });
  });
});

/** An OpenAI-compatible local server whose stream is `chunks`, each at its time. */
function localServer(
  chunks: { at: number; chunk: unknown }[],
  apiBase = "http://127.0.0.1:8083/v1/",
) {
  const llm = new OpenAI({ model: "qwen", apiBase, apiKey: "k" });
  (llm as any).openaiAdapter = {
    chatCompletionStream: async function* () {
      for (const c of chunks) {
        vi.setSystemTime(T0 + c.at);
        yield c.chunk;
      }
    },
  };
  const logged: LLMInteractionItemDetails[] = [];
  (llm as any).logger = {
    createInteractionLog: () => ({
      logItem: (item: LLMInteractionItemDetails) => logged.push(item),
    }),
  };
  return { llm, logged };
}

async function collect(llm: OpenAI): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for await (const m of llm.streamChat(
    [{ role: "user", content: "x" }],
    new AbortController().signal,
  )) {
    out.push(m);
  }
  return out;
}

const progress = (processed: number, timeMs: number) => ({
  id: "c",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: null }],
  prompt_progress: { total: 12_000, cache: 10_000, processed, time_ms: timeMs },
});

describe("the stream path (llama.cpp)", () => {
  beforeEach(() => {
    resetPromptProgressSupport();
    // No /props: no return_progress is asked for, but the chunks still come
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
  });

  it("reads the prompt, thinks, writes; first token is the first reasoning, not the progress", async () => {
    const [reasoning, text, last] = llamaCpp.chunks;
    const { llm, logged } = localServer([
      { at: 300, chunk: progress(11_000, 300) },
      { at: 800, chunk: progress(12_000, 800) },
      { at: 1000, chunk: reasoning },
      { at: 2000, chunk: text },
      { at: 6000, chunk: last },
    ]);
    const out = await collect(llm);
    const usage = (out.find((m) => m.role === "assistant" && m.usage) as any)
      .usage as Usage;
    const t = usage.timing!;
    expect(phasesOf(t)).toEqual(["waiting", "reading", "thinking", "writing"]);
    expect(t.firstEventAt).toBe(T0 + 300);
    expect(t.firstTokenMs).toEqual({ value: 1000, source: "measured" });
    expect(t.outputRate).toEqual({ value: 80, source: "server" });
    expect(t.prefill).toEqual({
      read: 2000,
      cached: 10_000,
      ms: 800,
      rate: 2500,
      source: "server",
    });
    expect(t.drafts).toEqual({ offered: 300, accepted: 240 });
    // The end of the log carries the record too (the console reads it)
    const end = logged.find((i) => i.kind === "success") as any;
    expect(end.timing.firstTokenMs.value).toBe(1000);
    expect(end.timing.endAt).toBe(T0 + 6000);
  });

  it("Strata: the section 5 request reads as a long prefill at the server's speed", async () => {
    const [text, last] = strata.chunks;
    const { llm } = localServer([
      { at: 86_500, chunk: text },
      { at: 96_300, chunk: last },
    ]);
    const out = await collect(llm);
    const t = (out.find((m) => m.role === "assistant" && m.usage) as any).usage
      .timing;
    expect(t.firstTokenMs.value).toBe(86_500);
    expect(t.prefill).toMatchObject({ read: 401_472, rate: 4649 });
    expect(t.outputRate).toEqual({ value: 74.5, source: "server" });
    expect(t.drafts).toEqual({ offered: 530, accepted: 420 });
  });
});

describe("live rate", () => {
  const words = (n: number) => "x".repeat(n);

  it("is a ~ estimate over the last seconds, only after 1 s and 20 tokens", () => {
    const timer = new RequestTimer();
    // 40 characters (10 tokens) every 100 ms from 1 s
    for (let at = 1000; at <= 3000; at += 100) {
      vi.setSystemTime(T0 + at);
      timer.chunk({ role: "assistant", content: words(40) });
      if (at - 1000 < MIN_LIVE_MS) {
        expect(timer.snapshot().outputRate).toBeUndefined();
      }
    }
    // 2 s of output, all in the window: 21 deltas x 10 tokens / 2 s
    expect(timer.snapshot().outputRate).toEqual({
      value: 110,
      source: "estimate",
    });
    // A second of silence: the window loses its oldest characters
    // 16 deltas left (1.5 s to 3 s): 160 tokens over the 3 s window
    vi.setSystemTime(T0 + 4500);
    expect(timer.snapshot().outputRate).toEqual({
      value: 53,
      source: "estimate",
    });
  });

  it("gives none under 20 tokens", () => {
    const timer = new RequestTimer();
    vi.setSystemTime(T0 + 100);
    timer.chunk({ role: "assistant", content: words(40) });
    vi.setSystemTime(T0 + 5000);
    expect(timer.snapshot().outputRate).toBeUndefined();
    expect(timer.finish().outputRate).toBeUndefined();
  });
});

describe("final rate without a count", () => {
  it("is an estimate from characters for a stopped turn", () => {
    const timer = new RequestTimer();
    vi.setSystemTime(T0 + 1000);
    timer.chunk({ role: "assistant", content: "x".repeat(400) });
    vi.setSystemTime(T0 + 3000);
    const r = timer.finish(
      { promptTokens: 10, completionTokens: 1 },
      { stopped: true },
    );
    expect(r.outputTokens).toEqual({ value: 100, source: "estimate" });
    expect(r.outputRate).toEqual({ value: 50, source: "estimate" });
  });

  it("is an estimate when the server sent no usage", () => {
    const timer = new RequestTimer();
    vi.setSystemTime(T0 + 1000);
    timer.chunk({ role: "assistant", content: "x".repeat(400) });
    vi.setSystemTime(T0 + 5000);
    expect(timer.finish().outputRate).toEqual({
      value: 25,
      source: "estimate",
    });
  });
});

describe("stall and hold", () => {
  it("is stalled after 15 s without a delta, never while waiting or reading", () => {
    const timer = new RequestTimer();
    vi.setSystemTime(T0 + 20_000);
    expect(timer.snapshot().stalledSince).toBeUndefined();
    timer.chunk({
      role: "assistant",
      content: "",
      promptProgress: { total: 10, cache: 0, processed: 5, timeMs: 1 },
    });
    vi.setSystemTime(T0 + 60_000);
    expect(timer.snapshot().stalledSince).toBeUndefined();
    timer.chunk({ role: "assistant", content: "hi" });
    vi.setSystemTime(T0 + 60_000 + STALL_MS - 1);
    expect(timer.snapshot().stalledSince).toBeUndefined();
    vi.setSystemTime(T0 + 60_000 + STALL_MS);
    expect(timer.snapshot().stalledSince).toBe(T0 + 60_000);
  });

  it("is held while recovery holds the text, then back to its phase", () => {
    const timer = new RequestTimer();
    vi.setSystemTime(T0 + 100);
    timer.chunk({ role: "assistant", content: "a" });
    vi.setSystemTime(T0 + 200);
    timer.chunk({ role: "assistant", content: "", recoveryHold: "start" });
    vi.setSystemTime(T0 + 300);
    timer.chunk({ role: "assistant", content: "b" });
    expect(timer.snapshot().phase).toBe("held");
    vi.setSystemTime(T0 + 30_000);
    expect(timer.snapshot().stalledSince).toBeUndefined();
    timer.chunk({ role: "assistant", content: "", recoveryHold: "end" });
    expect(phasesOf(timer.snapshot())).toEqual([
      "waiting",
      "writing",
      "held",
      "writing",
    ]);
  });
});

describe("withTiming", () => {
  it("puts the record on the usage chunk only", () => {
    const timer = new RequestTimer();
    vi.setSystemTime(T0 + 500);
    const text = withTiming({ role: "assistant", content: "hi" }, timer);
    expect((text as any).usage).toBeUndefined();
    const end = withTiming(
      {
        role: "assistant",
        content: "",
        usage: { promptTokens: 3, completionTokens: 1 },
      },
      timer,
    ) as any;
    expect(end.usage.timing.firstTokenMs.value).toBe(500);
    expect(end.usage.timing.endAt).toBe(T0 + 500);
  });
});
