import { beforeEach, describe, expect, test, vi } from "vitest";

import nativeChat from "../__fixtures__/ollama/native-chat-cache-hit.json";

// _streamChat reads the body through streamResponse; feed it text pieces.
const pieces = vi.hoisted(() => ({ list: [] as string[], json: {} as any }));
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  streamResponse: async function* () {
    for (const p of pieces.list) yield p;
  },
}));

import { ChatMessage } from "../../index.js";
import Ollama from "./Ollama.js";

function createOllama(): Ollama {
  // Skip the constructor, which contacts the server.
  const o = Object.create(Ollama.prototype);
  o.model = "qwen3:8b";
  o.completionOptions = {};
  o.ensureModelInfo = async () => {};
  o._getModel = () => "qwen3:8b";
  o.getEndpoint = (p: string) => new URL(p, "http://localhost:11434/");
  o.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => pieces.json,
  });
  return o;
}

async function run(stream = true): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for await (const m of (createOllama() as any)._streamChat(
    [{ role: "user", content: "hi" }],
    new AbortController().signal,
    { model: "qwen3:8b", stream },
  )) {
    out.push(m);
  }
  return out;
}

const expected = {
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
};

describe("Ollama native chat usage", () => {
  beforeEach(() => {
    pieces.list = [];
  });

  test("the done line's counts and durations become the reply's usage", async () => {
    pieces.list = nativeChat.lines.map((l) => JSON.stringify(l) + "\n");
    const out = await run();
    const withUsage = out.filter((m) => m.role === "assistant" && m.usage);
    expect(withUsage).toHaveLength(1);
    expect((withUsage[0] as any).usage).toEqual(expected);
    expect(
      out.map((m) => (typeof m.content === "string" ? m.content : "")).join(""),
    ).toBe("Hello");
  });

  test("a non-streamed reply carries the same usage", async () => {
    pieces.json = {
      ...nativeChat.lines[2],
      message: { role: "assistant", content: "Hello" },
    };
    const out = await run(false);
    expect(out).toHaveLength(1);
    expect((out[0] as any).usage).toEqual(expected);
    expect(out[0].content).toBe("Hello");
  });

  test("a thinking-only done line gets a usage message of its own", async () => {
    pieces.list = [
      JSON.stringify({
        ...nativeChat.lines[2],
        message: { role: "assistant", content: "", thinking: "hm" },
      }) + "\n",
    ];
    const out = await run();
    expect(out.map((m) => m.role)).toEqual(["thinking", "assistant"]);
    expect((out[1] as any).usage.completionTokens).toBe(300);
  });

  test("a done line without counts adds no usage", async () => {
    pieces.list = [
      JSON.stringify(nativeChat.lines[0]) + "\n",
      JSON.stringify({
        model: "qwen3:8b",
        created_at: "2026-11-15T12:00:07Z",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
      }) + "\n",
    ];
    const out = await run();
    expect(out.some((m) => m.role === "assistant" && m.usage)).toBe(false);
  });
});
