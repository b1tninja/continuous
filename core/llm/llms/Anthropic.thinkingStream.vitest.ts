import { beforeEach, describe, expect, test, vi } from "vitest";

// handleResponse reads events through streamSse; feed it parsed events, as
// Anthropic.responseFacts.vitest.ts does.
const events = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  streamSse: async function* () {
    for (const e of events.list) yield e;
  },
}));

import Anthropic from "./Anthropic.js";

async function streamed() {
  const a = new Anthropic({ apiKey: "k", model: "claude-opus-5-5" } as any);
  const out: any[] = [];
  for await (const m of (a as any).handleResponse(
    new Response("", { status: 200 }),
    true,
  ))
    out.push(m);
  return out;
}

const thinkingBlock = (index: number, deltas: string[], signature: string) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "thinking", thinking: "" },
  },
  ...deltas.map((thinking) => ({
    type: "content_block_delta",
    index,
    delta: { type: "thinking_delta", thinking },
  })),
  {
    type: "content_block_delta",
    index,
    delta: { type: "signature_delta", signature },
  },
  { type: "content_block_stop", index },
];

describe("Anthropic summarized thinking in a stream", () => {
  beforeEach(() => {
    events.list = [];
  });

  test("each thinking delta is a thinking message as it arrives, ahead of the answer", async () => {
    events.list = [
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      ...thinkingBlock(0, ["Weighing ", "the options."], "sig"),
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Done." },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9 },
      },
      { type: "message_stop" },
    ];
    const out = await streamed();
    const roles = out.filter((m) => m.content).map((m) => m.role);
    expect(roles).toEqual(["thinking", "thinking", "assistant"]);
    expect(
      out
        .filter((m) => m.role === "thinking")
        .map((m) => m.content)
        .join(""),
    ).toBe("Weighing the options.");
    // The signature is kept for the block, separately from the text
    expect(out.find((m) => m.signature)).toMatchObject({
      role: "thinking",
      content: "",
      signature: "sig",
    });
  });

  test("an empty (omitted) thinking block yields only its signature", async () => {
    events.list = [
      ...thinkingBlock(0, [], "sig"),
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    const out = await streamed();
    expect(out.filter((m) => m.role === "thinking")).toEqual([
      { role: "thinking", content: "", signature: "sig" },
    ]);
  });
});
