import { afterEach, describe, expect, test, vi } from "vitest";

// Requests go through the shared fetch; route it to the global stub below.
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

import { AnthropicApi, anthropicFinishReason } from "../apis/Anthropic.js";

function sse(events: object[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const api = () =>
  new AnthropicApi({ provider: "anthropic", apiKey: "k" } as any);

async function streamReasons(stopReason: string) {
  const events = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  const chunks = [];
  for await (const c of api().handleStreamResponse(sse(events), "m")) {
    chunks.push(c);
  }
  // The last chunk that carries a finish_reason, as clients read it.
  return chunks
    .map((c) => c.choices[0]?.finish_reason)
    .filter(Boolean)
    .pop();
}

describe("anthropicFinishReason", () => {
  test.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
    [undefined, "stop"],
  ])("%s -> %s", (reason, expected) => {
    expect(anthropicFinishReason(reason)).toBe(expected);
  });
});

describe("Anthropic streaming finish_reason", () => {
  test.each([
    ["end_turn", "stop"],
    ["max_tokens", "length"],
    ["tool_use", "tool_calls"],
    ["refusal", "content_filter"],
  ])("stop_reason %s ends with finish_reason %s", async (reason, expected) => {
    expect(await streamReasons(reason)).toBe(expected);
  });
});

describe("Anthropic non-streaming finish_reason", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function run(stop_reason: string, text = "Hello") {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "msg_1",
              content: [{ type: "text", text }],
              stop_reason,
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
            { status: 200 },
          ),
      ),
    );
    return api().chatCompletionNonStream(
      { model: "m", messages: [{ role: "user", content: "x" }] } as any,
      new AbortController().signal,
    );
  }

  test("max_tokens is length and the text is kept", async () => {
    const r = await run("max_tokens");
    expect(r.choices[0].finish_reason).toBe("length");
    expect(r.choices[0].message.content).toBe("Hello");
    expect(r.choices[0].message.refusal).toBeNull();
  });

  test("end_turn is still stop", async () => {
    expect((await run("end_turn")).choices[0].finish_reason).toBe("stop");
  });

  test("refusal is content_filter and exposes the refusal text", async () => {
    const r = await run("refusal", "I can't help with that.");
    expect(r.choices[0].finish_reason).toBe("content_filter");
    expect(r.choices[0].message.refusal).toBe("I can't help with that.");
    expect(r.choices[0].message.content).toBe("I can't help with that.");
  });
});
