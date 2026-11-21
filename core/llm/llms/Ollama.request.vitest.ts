import { beforeEach, describe, expect, test, vi } from "vitest";

// _streamChat reads the body through streamResponse; one finished reply.
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  streamResponse: async function* () {
    yield '{"message":{"role":"assistant","content":"ok"},"done":true}\n';
  },
}));

import { ChatMessage, LLMOptions, Tool } from "../../index.js";
import { learnedFactsFor, resetLearned } from "../learnedLimits.js";
import Ollama from "./Ollama.js";

interface Server {
  /** The `parameters` text of `/api/show` (the Modelfile's). */
  parameters?: string;
  /** The body of `/api/ps`. */
  ps?: unknown;
}

/** An Ollama whose server is a stub; `sent` collects each request by path. */
function createOllama(options: Partial<LLMOptions>, server: Server = {}) {
  const sent: { path: string; body: any }[] = [];
  const ollama = new Ollama({ model: "qwen3:8b", ...options });
  (ollama as any).fetch = async (url: URL, init: { body?: string }) => {
    const path = url.pathname;
    sent.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    const json =
      path === "/api/show"
        ? { parameters: server.parameters }
        : path === "/api/ps"
          ? server.ps
          : {};
    return { status: 200, ok: true, json: async () => json };
  };
  return { ollama, sent };
}

async function chat(
  ollama: Ollama,
  messages: ChatMessage[],
  tools?: Tool[],
): Promise<void> {
  for await (const _ of (ollama as any)._streamChat(
    messages,
    new AbortController().signal,
    { model: "qwen3:8b", stream: true, tools },
  )) {
    // drain
  }
}

const chatBodies = (sent: { path: string; body: any }[]) =>
  sent.filter((r) => r.path === "/api/chat").map((r) => r.body);

const hi: ChatMessage[] = [{ role: "user", content: "hi" }];
const loadedAt = (context_length?: number) => ({
  models: [{ name: "qwen3:8b", model: "qwen3:8b", context_length }],
});

beforeEach(() => resetLearned());

describe("Ollama tools in a tool loop", () => {
  const tool: Tool = {
    type: "function",
    displayTitle: "Read file",
    readonly: true,
    group: "built-in",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: {} },
    },
  } as Tool;

  test("the request after a tool result carries the tools", async () => {
    const { ollama, sent } = createOllama({});
    await chat(
      ollama,
      [
        { role: "user", content: "read a.txt then b.txt" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", content: "contents of a", toolCallId: "tc_1" },
      ],
      [tool],
    );
    const [body] = chatBodies(sent);
    expect(body.messages.at(-1).role).toBe("tool");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  test("a request without tools sends none", async () => {
    const { ollama, sent } = createOllama({});
    await chat(ollama, hi);
    expect(chatBodies(sent)[0]).not.toHaveProperty("tools");
  });
});

describe("Ollama num_ctx", () => {
  test("no context length set and none in the Modelfile: the server picks", async () => {
    const { ollama, sent } = createOllama({}, { ps: loadedAt(4096) });
    await chat(ollama, hi);

    expect(chatBodies(sent)[0].options).not.toHaveProperty("num_ctx");
    // The model was loaded without a window too, then asked which it got.
    const load = sent.find((r) => r.path === "/api/generate");
    expect(load?.body).toEqual({ model: "qwen3:8b", keep_alive: 1800 });
    expect(sent.map((r) => r.path)).toEqual([
      "/api/show",
      "/api/generate",
      "/api/ps",
      "/api/chat",
    ]);
    // The window in use is what the prompt is cut to and what the row shows.
    expect(ollama.contextLength).toBe(4096);
    expect(ollama.contextLengthSource).toBe("provider");
    expect(learnedFactsFor(ollama.limitsKey)).toEqual({ contextLength: 4096 });
  });

  test("the server is asked once", async () => {
    const { ollama, sent } = createOllama({}, { ps: loadedAt(4096) });
    await chat(ollama, hi);
    await chat(ollama, hi);
    expect(sent.filter((r) => r.path === "/api/ps")).toHaveLength(1);
    expect(chatBodies(sent)[1].options).not.toHaveProperty("num_ctx");
  });

  test("a model rebuilt with the learned window still sends none", async () => {
    const first = createOllama({}, { ps: loadedAt(4096) });
    await chat(first.ollama, hi);
    const { ollama, sent } = createOllama({}, { ps: loadedAt(4096) });
    expect(ollama.contextLength).toBe(4096);
    await chat(ollama, hi);
    expect(chatBodies(sent)[0].options).not.toHaveProperty("num_ctx");
  });

  test("the person's context length is sent and nothing is asked", async () => {
    const { ollama, sent } = createOllama(
      { contextLength: 16384 },
      { parameters: "num_ctx 2048", ps: loadedAt(4096) },
    );
    await chat(ollama, hi);
    expect(chatBodies(sent)[0].options.num_ctx).toBe(16384);
    expect(sent.some((r) => r.path === "/api/ps")).toBe(false);
    expect(ollama.contextLengthSource).toBe("config");
  });

  test("the Modelfile's num_ctx is sent", async () => {
    const { ollama, sent } = createOllama(
      {},
      { parameters: "temperature 0.2\nnum_ctx 2048", ps: loadedAt(4096) },
    );
    await chat(ollama, hi);
    expect(chatBodies(sent)[0].options.num_ctx).toBe(2048);
    expect(sent.some((r) => r.path === "/api/ps")).toBe(false);
    expect(ollama.contextLength).toBe(2048);
    expect(ollama.contextLengthSource).toBe("provider");
  });

  test("a server that does not say its window keeps the request and the cut in step", async () => {
    // Older servers list loaded models without context_length.
    const { ollama, sent } = createOllama({}, { ps: loadedAt(undefined) });
    await chat(ollama, hi);
    expect(chatBodies(sent)[0].options.num_ctx).toBe(ollama.contextLength);
    expect(ollama.contextLengthSource).toBe("unknown");
  });
});
