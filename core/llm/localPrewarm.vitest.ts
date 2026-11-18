import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, LLMFullCompletionOptions, Tool } from "../index.js";
import { summaryMessageText } from "../util/summaryMessage.js";
import OpenAI from "./llms/OpenAI";
import {
  freeMemoryFromStatus,
  localPrewarm,
  prewarmAllowed,
  prewarmMemoryBytes,
  prewarmRequestOptions,
  prewarmSetting,
  summaryPinMessages,
} from "./localPrewarm";
import {
  resetFullPromptCountServers,
  resetPromptProgressSupport,
  resetStrataServers,
} from "./localServers";

/**
 * A recorded-behaviour stand-in for Strata (no live server is asked). It
 * implements what Strata documents (docs/DETAILS.md "strata_prefix",
 * serve/server.py resolve_prefix, the checkpoint rules of section 3.8 of the
 * note): a prompt reuses the longest checkpoint of the live session it starts
 * with; checkpoints are taken every `every` tokens, at the last
 * `<|im_start|>` (the turn boundary), and at a `strata_prefix` pin, which
 * stays (one per engine). Characters stand in for tokens.
 */
class MockStrata {
  live = "";
  checkpoints: number[] = [];
  pin: number | undefined;
  readonly requests: {
    body: any;
    promptTokens: number;
    reused: number;
    pin?: number;
  }[] = [];
  constructor(
    readonly ram: { used_gib: number; total_gib: number } | null = {
      used_gib: 20,
      total_gib: 64,
    },
    readonly every = 1_000_000,
  ) {}

  static render(messages: any[], generation = true): string {
    const text = messages
      .map((m) => {
        const content =
          typeof m.content === "string"
            ? m.content
            : (m.content ?? []).map((p: any) => p.text ?? "").join("");
        return `<|im_start|>${m.role}\n${content}<|im_end|>\n`;
      })
      .join("");
    return generation ? `${text}<|im_start|>assistant\n` : text;
  }

  fetch = vi.fn(async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/status") {
      return json({
        service: "strata",
        machine: this.ram ? { ram: this.ram } : {},
      });
    }
    if (path === "/props") {
      return json({ default_generation_settings: { n_ctx: 524288 } });
    }
    return json({ error: "not found" }, 404);
  });

  chat(body: any) {
    const prompt = MockStrata.render(body.messages);
    let lcp = 0;
    while (
      lcp < prompt.length &&
      lcp < this.live.length &&
      prompt[lcp] === this.live[lcp]
    ) {
      lcp++;
    }
    const reused = Math.max(
      0,
      ...this.checkpoints.filter((c) => c <= lcp),
      ...(this.pin !== undefined && this.pin <= lcp ? [this.pin] : []),
    );
    let pin: number | undefined;
    const k = body.strata_prefix?.messages;
    if (typeof k === "number" && k < body.messages.length) {
      const head = MockStrata.render(body.messages.slice(0, k), false);
      let n = 0;
      while (n < head.length && head[n] === prompt[n]) n++;
      pin = n;
      this.pin = n;
    }
    const marks: number[] = [];
    for (let at = this.every; at < prompt.length; at += this.every) {
      marks.push(at);
    }
    marks.push(prompt.lastIndexOf("<|im_start|>"));
    this.checkpoints = marks;
    this.live = prompt;
    this.requests.push({ body, promptTokens: prompt.length, reused, pin });
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const tool: Tool = {
  type: "function",
  displayTitle: "Read",
  wouldLikeTo: "read",
  isCurrently: "reading",
  hasAlready: "read",
  readonly: true,
  group: "builtin",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
};

function modelAt(
  apiBase: string,
  server: MockStrata,
  /** Pre-warm is off by default this release, so the tests turn it on */
  contextManagement: { prewarm?: "off" | "local" | "always" } = {
    prewarm: "local",
  },
) {
  const llm = new OpenAI({
    model: "qwen3.6-35b",
    apiBase,
    apiKey: "k",
    contextLength: 524_288,
    contextManagement,
  });
  (llm as any).openaiAdapter = {
    chatCompletionStream: async function* (body: any, signal: AbortSignal) {
      server.chat(body);
      signal.throwIfAborted();
      yield {
        id: "c",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
      };
    },
  };
  return llm;
}

const LOCAL = "http://127.0.0.1:8080/v1/";

/** The compacted conversation as buildChatRequest builds it after C104. */
const compacted: ChatMessage[] = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", content: summaryMessageText("Turns 1 to 80: the refactor.") },
  { role: "user", content: "Now run the tests." },
  { role: "assistant", content: "They pass." },
];
const options: LLMFullCompletionOptions = {
  tools: [tool],
  reasoning: true,
  reasoningBudgetTokens: 2048,
};

async function realRequest(llm: OpenAI, messages: ChatMessage[]) {
  const { compiledChatMessages } = llm.compileChatMessages(messages, options);
  for await (const _ of llm.streamChat(
    compiledChatMessages,
    new AbortController().signal,
    options,
    { precompiled: true },
  )) {
    // drained
  }
}

let server: MockStrata;
beforeEach(() => {
  resetStrataServers();
  resetPromptProgressSupport();
  resetFullPromptCountServers();
  server = new MockStrata();
  vi.stubGlobal("fetch", server.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const prewarm = (
  llm: OpenAI,
  extra: Partial<Parameters<typeof localPrewarm>[0]> = {},
) =>
  localPrewarm({
    llm,
    messages: compacted,
    options,
    promptTokens: 58_000,
    liveTokens: 390_000,
    signal: new AbortController().signal,
    fetchFn: server.fetch as unknown as typeof fetch,
    ...extra,
  });

describe("the pre-warm request", () => {
  it("starts with the same bytes as the next real request, with the same tools and reasoning", async () => {
    const llm = modelAt(LOCAL, server);
    const result = await prewarm(llm);
    expect(result).toMatchObject({
      status: "sent",
      server: "strata",
      pinMessages: 2,
    });

    // The turn that applies the compaction: the same messages and a new one
    await realRequest(llm, [
      ...compacted,
      { role: "user", content: "Next, the docs." },
    ]);
    const [warm, real] = server.requests.map((r) => r.body);

    // Byte-compare the compiled messages: each pre-warm message is the real
    // request's message at the same place
    expect(warm.messages.length).toBe(compacted.length);
    expect(JSON.stringify(warm.messages)).toBe(
      JSON.stringify(real.messages.slice(0, warm.messages.length)),
    );
    // Everything else that shapes the prompt is the same
    const { messages: _w, max_tokens, strata_prefix, ...warmRest } = warm;
    const { messages: _r, max_tokens: realMax, ...realRest } = real;
    expect(warmRest).toEqual(realRest);
    expect(max_tokens).toBe(1);
    expect(strata_prefix).toEqual({ messages: 2 });
    expect(warm).not.toHaveProperty("strata_checkpoint");
    expect(real).not.toHaveProperty("strata_prefix");
    expect(warm.tools.map((t: any) => t.function.name)).toEqual(["read_file"]);
  });

  it("makes the next real request read from the end of the last pre-warmed turn", async () => {
    const llm = modelAt(LOCAL, server);
    await prewarm(llm);
    await realRequest(llm, [
      ...compacted,
      { role: "user", content: "Next, the docs." },
    ]);
    const [warm, real] = server.requests;
    const turnEnd = MockStrata.render(compacted, false).length;
    expect(real.reused).toBe(turnEnd);
    expect(real.reused).toBeGreaterThan(warm.pin!);
  });

  it("falls back to the pin, not the root, when the tail changes (the fixture of the C106 row)", async () => {
    const llm = modelAt(LOCAL, server);
    await prewarm(llm);
    // An edit in the tail: everything up to the summary's end is still reused
    const edited = [...compacted];
    edited[2] = { role: "user", content: "Now run the linters." };
    await realRequest(llm, [...edited, { role: "user", content: "Go on." }]);
    const [warm, real] = server.requests;
    const pinAt = MockStrata.render(compacted.slice(0, 2), false).length;
    expect(warm.pin).toBe(pinAt);
    expect(real.reused).toBe(warm.pin);
  });

  it("sends no pin to llama.cpp, which has none", async () => {
    server.fetch.mockImplementation(async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      return path === "/props"
        ? json({ default_generation_settings: { n_ctx: 524288 } })
        : json({ error: "not found" }, 404);
    });
    const llm = modelAt(LOCAL, server);
    expect(await prewarm(llm)).toMatchObject({
      status: "sent",
      server: "llama.cpp",
    });
    expect(server.requests[0].body).not.toHaveProperty("strata_prefix");
    expect(server.requests[0].body.max_tokens).toBe(1);
  });
});

describe("when it is not sent", () => {
  it("skips Strata with too little free memory, and says how much", async () => {
    server = new MockStrata({ used_gib: 60, total_gib: 64 });
    vi.stubGlobal("fetch", server.fetch);
    const llm = modelAt(LOCAL, server);
    const result = await prewarm(llm);
    expect(result).toMatchObject({ status: "skipped", reason: "low-memory" });
    expect(result.status === "skipped" && result.detail).toMatch(
      /about 4\.3 GB of free memory .* about 8\.7 GB/,
    );
    expect(server.requests).toHaveLength(0);
  });

  it("skips Strata when it does not report memory", async () => {
    server = new MockStrata(null);
    vi.stubGlobal("fetch", server.fetch);
    const result = await prewarm(modelAt(LOCAL, server));
    expect(result).toMatchObject({ reason: "memory-unknown" });
    expect(server.requests).toHaveLength(0);
  });

  it("follows contextManagement.prewarm: unset, off, local, always", async () => {
    expect(await prewarm(modelAt(LOCAL, server, {}))).toMatchObject({
      reason: "off",
    });
    expect(
      await prewarm(modelAt(LOCAL, server, { prewarm: "off" })),
    ).toMatchObject({ reason: "off" });
    expect(
      await prewarm(modelAt(LOCAL, server, { prewarm: "local" })),
    ).toMatchObject({ status: "sent" });
    expect(
      await prewarm(modelAt(LOCAL, server, { prewarm: "always" })),
    ).toMatchObject({ status: "sent" });
    // No cloud pre-warm in this slice (C109), whatever the setting
    for (const prewarmValue of ["local", "always"] as const) {
      expect(
        await prewarm(
          modelAt("https://api.openai.com/v1/", server, {
            prewarm: prewarmValue,
          }),
        ),
      ).toMatchObject({ reason: "cloud" });
    }
    expect(server.requests).toHaveLength(2);
    expect(server.fetch).not.toHaveBeenCalledWith(
      expect.objectContaining({ host: "api.openai.com" }),
      expect.anything(),
    );
  });

  it("skips a local server that is neither Strata nor llama.cpp", async () => {
    server.fetch.mockImplementation(async () =>
      json({ error: "not found" }, 404),
    );
    expect(await prewarm(modelAt(LOCAL, server))).toMatchObject({
      reason: "unsupported-server",
    });
  });

  it("skips a request without the summary message", async () => {
    const result = await prewarm(modelAt(LOCAL, server), {
      messages: [compacted[0], ...compacted.slice(2)],
    });
    expect(result).toMatchObject({ reason: "no-summary-message" });
  });

  it("stops when aborted, and reports it as an abort", async () => {
    const llm = modelAt(LOCAL, server);
    const controller = new AbortController();
    (llm as any).openaiAdapter.chatCompletionStream = async function* () {
      controller.abort();
      yield* [];
      throw new Error("aborted");
    };
    const result = await prewarm(llm, { signal: controller.signal });
    expect(result).toMatchObject({ status: "skipped", reason: "aborted" });
  });

  it("is not sent once the signal is aborted before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await prewarm(modelAt(LOCAL, server), {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ reason: "aborted" });
    expect(server.requests).toHaveLength(0);
  });
});

describe("the parts", () => {
  it("reads the setting, off by default until the Strata live check", () => {
    expect(prewarmSetting({})).toBe("off");
    expect(prewarmSetting({ contextManagement: { prewarm: "local" } })).toBe(
      "local",
    );
    expect(prewarmSetting({ contextManagement: { prewarm: "off" } })).toBe(
      "off",
    );
    expect(prewarmAllowed("local", true)).toBe(true);
    expect(prewarmAllowed("local", false)).toBe(false);
    expect(prewarmAllowed("always", false)).toBe(false);
    expect(prewarmAllowed("off", true)).toBe(false);
  });

  it("estimates the memory from the note's figures", () => {
    // 390k parked is about 7 GB; six checkpoints at 118 MB
    expect(prewarmMemoryBytes(0, 390_000)).toBeCloseTo(7e9 + 2 * 118e6, -6);
    expect(prewarmMemoryBytes(58_000, 390_000) / 1e9).toBeCloseTo(8.7, 1);
  });

  it("reads free memory from /v1/status machine.ram", () => {
    expect(
      freeMemoryFromStatus({
        machine: { ram: { used_gib: 48, total_gib: 64 } },
      }),
    ).toBe(16 * 2 ** 30);
    expect(freeMemoryFromStatus({ machine: { ram: null } })).toBeUndefined();
    expect(freeMemoryFromStatus(undefined)).toBeUndefined();
  });

  it("pins after the summary message, the first message after the system one", () => {
    expect(summaryPinMessages(compacted)).toBe(2);
    expect(summaryPinMessages(compacted.slice(1))).toBe(1);
    expect(summaryPinMessages(compacted.slice(0, 2))).toBeUndefined();
    expect(summaryPinMessages([compacted[0], compacted[2]])).toBeUndefined();
  });

  it("changes only max_tokens and the pin", () => {
    expect(prewarmRequestOptions(options, 2)).toEqual({
      ...options,
      maxTokens: 1,
      strataPrefix: { messages: 2 },
    });
    expect(prewarmRequestOptions(options, undefined)).toEqual({
      ...options,
      maxTokens: 1,
    });
  });

  it("never sends strata_prefix to a cloud API", async () => {
    const llm = modelAt("https://api.openai.com/v1/", server);
    for await (const _ of llm.streamChat(
      compacted,
      new AbortController().signal,
      { strataPrefix: { messages: 2 } },
    )) {
      // drained
    }
    expect(server.requests[0].body).not.toHaveProperty("strata_prefix");
  });
});
