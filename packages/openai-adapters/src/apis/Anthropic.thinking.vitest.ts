import { afterEach, describe, expect, it, vi } from "vitest";

// Requests go through the shared fetch; route it to the global stub below.
vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

import { AnthropicApi, anthropicThinkingBlocks } from "./Anthropic.js";
import { VertexAIApi } from "./VertexAI.js";

const api = (requestOptions?: Record<string, unknown>) =>
  new AnthropicApi({
    provider: "anthropic",
    apiKey: "k",
    ...(requestOptions && { requestOptions }),
  } as any);

const body = (model: string, extra: Record<string, unknown> = {}) =>
  ({
    model,
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.2,
    ...extra,
  }) as any;

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic adapter: the thinking request", () => {
  it("sends no thinking when nothing asks for it on a model that does not think by default", () => {
    const sent = api()._convertToCleanAnthropicBody(
      body("claude-sonnet-4-5"),
    ) as any;
    expect(sent).not.toHaveProperty("thinking");
    expect(sent).not.toHaveProperty("output_config");
    expect(sent.temperature).toBe(0.2);
  });

  it("asks a model that thinks anyway for its summary, with no effort", () => {
    for (const model of [
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-fable-5-2",
    ]) {
      const sent = api()._convertToCleanAnthropicBody(body(model)) as any;
      expect(sent.thinking).toEqual({
        type: "adaptive",
        display: "summarized",
      });
      expect(sent.output_config).toBeUndefined();
      // Thinking is on, so no sampling values
      expect(sent.temperature).toBeUndefined();
    }
  });

  it("turns reasoning_effort into adaptive thinking with an effort on 4.6 and later", () => {
    const opus46 = api()._convertToCleanAnthropicBody(
      body("claude-opus-4-6", { reasoning_effort: "high" }),
    ) as any;
    expect(opus46.thinking).toEqual({ type: "adaptive" });
    expect(opus46.output_config).toEqual({ effort: "high" });
    expect(opus46.temperature).toBeUndefined();

    const opus47 = api()._convertToCleanAnthropicBody(
      body("claude-opus-4-7", { reasoning_effort: "low" }),
    ) as any;
    expect(opus47.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(opus47.output_config).toEqual({ effort: "low" });

    // xhigh and max are sent as high, the most every model takes
    const max = api()._convertToCleanAnthropicBody(
      body("claude-opus-4-6", { reasoning_effort: "max" }),
    ) as any;
    expect(max.output_config).toEqual({ effort: "high" });
  });

  it("uses a token budget before 4.6, and keeps max_tokens above it", () => {
    const sonnet45 = api()._convertToCleanAnthropicBody(
      body("claude-sonnet-4-5", { reasoning_effort: "medium" }),
    ) as any;
    expect(sonnet45.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(sonnet45.max_tokens).toBe(32_000);

    const haiku45 = api()._convertToCleanAnthropicBody(
      body("claude-haiku-4-5", { reasoning_effort: "high" }),
    ) as any;
    expect(haiku45.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(haiku45.max_tokens).toBeGreaterThan(16384);
  });

  it("turns reasoning off with none, as core does", () => {
    const off = api()._convertToCleanAnthropicBody(
      body("claude-opus-4-6", { reasoning_effort: "none" }),
    ) as any;
    expect(off.thinking).toBeUndefined();
    expect(off.temperature).toBe(0.2);
    // A model that thinks anyway still gets its summary
    const opus55 = api()._convertToCleanAnthropicBody(
      body("claude-opus-5-5", { reasoning_effort: "none" }),
    ) as any;
    expect(opus55.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
  });

  it("reads the config's reasoning_effort and never sends the OpenAI field to Anthropic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [], usage: {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withEffort = api({
      extraBodyProperties: { reasoning_effort: "high", metadata: { a: 1 } },
    });
    await withEffort.chatCompletionNonStream(
      body("claude-opus-4-6"),
      new AbortController().signal,
    );
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.thinking).toEqual({ type: "adaptive" });
    expect(sent.output_config).toEqual({ effort: "high" });
    expect(sent).not.toHaveProperty("reasoning_effort");
    // The fetch merges the config's extra fields into the body: the effort is
    // no longer among them, the others still are
    const requestOptions = fetchMock.mock.calls[0][2];
    expect(requestOptions.extraBodyProperties).toEqual({ metadata: { a: 1 } });
  });

  it("Vertex Claude gets the same thinking", () => {
    const vertex = new VertexAIApi({
      provider: "vertexai",
      env: { projectId: "p", region: "us-east5" },
    } as any) as any;
    const sent = vertex.convertAnthropicBody(
      body("claude-opus-4-6", { reasoning_effort: "medium" }),
    );
    expect(sent.thinking).toEqual({ type: "adaptive" });
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent.anthropic_version).toBeDefined();
  });
});

describe("Anthropic adapter: thinking in the stream", () => {
  it("streams thinking as reasoning_content and the signature as reasoning_details, ahead of the answer", async () => {
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me " },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "check." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-1" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: "opaque" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "Done." },
      },
      { type: "content_block_stop", index: 2 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9 },
      },
      { type: "message_stop" },
    ];
    const deltas: any[] = [];
    for await (const c of api().handleStreamResponse(sse(events), "m")) {
      if (c.choices[0]?.delta) deltas.push(c.choices[0].delta);
    }
    const reasoning = deltas.map((d) => d.reasoning_content ?? "").join("");
    expect(reasoning).toBe("Let me check.");
    const details = deltas.flatMap((d) => d.reasoning_details ?? []);
    expect(details).toEqual([
      { signature: "sig-1" },
      { type: "reasoning.encrypted", data: "opaque" },
    ]);
    expect(deltas.map((d) => d.content ?? "").join("")).toBe("Done.");
    // Reasoning comes before the answer
    const firstText = deltas.findIndex((d) => d.content);
    const lastReasoning = deltas.findLastIndex(
      (d) => d.reasoning_content || d.reasoning_details,
    );
    expect(lastReasoning).toBeLessThan(firstText);
  });

  it("a non-streamed reply's text leaves out its thinking block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "hmm", signature: "s" },
            { type: "text", text: "Answer" },
            { type: "text", text: " here." },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const completion = await api().chatCompletionNonStream(
      body("claude-opus-4-6", { reasoning_effort: "low" }),
      new AbortController().signal,
    );
    expect(completion.choices[0].message.content).toBe("Answer here.");
  });
});

describe("Anthropic adapter: thinking sent back", () => {
  const assistant = (extra: Record<string, unknown>) => ({
    role: "assistant",
    content: "Running it.",
    tool_calls: [
      {
        id: "t1",
        type: "function",
        function: { name: "run", arguments: "{}" },
      },
    ],
    ...extra,
  });

  it("replays signed thinking first on Claude 4.6 and earlier", () => {
    const sent = api()._convertToCleanAnthropicBody({
      model: "claude-opus-4-6",
      messages: [
        { role: "user", content: "go" },
        assistant({
          reasoning_details: [
            { type: "reasoning.text", text: "First.", signature: "s1" },
            { type: "reasoning.encrypted", data: "r1" },
          ],
        }),
        { role: "tool", tool_call_id: "t1", content: "ok" },
      ],
    } as any);
    const content = (sent.messages[1].content as any[]).map((b) => b.type);
    expect(content).toEqual([
      "thinking",
      "redacted_thinking",
      "text",
      "tool_use",
    ]);
    expect((sent.messages[1].content as any[])[0]).toEqual({
      type: "thinking",
      thinking: "First.",
      signature: "s1",
    });
  });

  it("drops the summaries of 4.7 and later but keeps redacted thinking, as core does", () => {
    const blocks = anthropicThinkingBlocks(
      {
        reasoning_details: [
          { type: "reasoning.text", text: "Summary.", signature: "s1" },
          { type: "reasoning.encrypted", data: "r1" },
        ],
      },
      "claude-opus-4-7",
    );
    expect(blocks).toEqual([{ type: "redacted_thinking", data: "r1" }]);
    expect(
      anthropicThinkingBlocks(
        {
          reasoning_details: [
            { type: "reasoning.text", text: "x", signature: "s" },
          ],
        },
        "claude-fable-5-2",
      ),
    ).toEqual([]);
  });

  it("takes the text from reasoning_content when the details carry only the signature (core's shape)", () => {
    expect(
      anthropicThinkingBlocks(
        {
          reasoning_content: "Core text.",
          reasoning_details: [{ signature: "s" }],
        },
        "claude-sonnet-4-5",
      ),
    ).toEqual([{ type: "thinking", thinking: "Core text.", signature: "s" }]);
  });

  it("sends nothing for unsigned or empty thinking", () => {
    expect(
      anthropicThinkingBlocks(
        { reasoning_details: [{ type: "reasoning.text", text: "x" }] },
        "claude-opus-4-6",
      ),
    ).toEqual([]);
    expect(
      anthropicThinkingBlocks(
        { reasoning_details: [{ signature: "s" }] },
        "claude-opus-4-6",
      ),
    ).toEqual([]);
    expect(
      anthropicThinkingBlocks({ content: "x" }, "claude-opus-4-6"),
    ).toEqual([]);
  });
});
