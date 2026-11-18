/**
 * The provider defects in the message validity audit that normalizeTurns
 * does not cover, each tested on its converter alone (no normalisation in
 * front of it, no network call).
 */
import { constructLlmApi } from "@continuedev/openai-adapters";
import { convertOpenAIMessagesToVercel } from "@continuedev/openai-adapters/dist/openaiToVercelMessages.js";
import type { ChatCompletionMessageParam } from "openai/resources/index";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../index.js";
import Anthropic from "./llms/Anthropic.js";
import Cloudflare from "./llms/Cloudflare.js";
import { toChatBody } from "./openaiTypeConverters.js";

const idlessCall: ChatMessage[] = [
  { role: "user", content: "hi" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { type: "function", function: { name: "read", arguments: "{}" } },
    ],
  },
  { role: "tool", content: "file text", toolCallId: undefined as any },
  { role: "user", content: "next" },
];

describe("Anthropic: a result whose call was dropped is sent as text", () => {
  it("native", () => {
    const a = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" } as any);
    const converted = a.convertMessages(idlessCall, false) as any[];
    const blocks = converted.flatMap((m) => m.content);
    expect(blocks.some((b: any) => b.type === "tool_use")).toBe(false);
    expect(blocks.some((b: any) => b.type === "tool_result")).toBe(false);
    expect(blocks).toContainEqual({
      type: "text",
      text: "Tool call output for Tool Call ID unknown:\n\nfile text",
    });
  });

  it("adapter", () => {
    const api = constructLlmApi({
      provider: "anthropic",
      apiKey: "k",
    } as any) as any;
    const converted = api._convertMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "file text", tool_call_id: "" },
    ]) as any[];
    const blocks = converted.flatMap((m) => m.content);
    expect(blocks.some((b: any) => b.type === "tool_result")).toBe(false);
    expect(blocks).toContainEqual({
      type: "text",
      text: "Tool call output for Tool Call ID unknown:\n\nfile text",
    });
  });

  it("a result for a call that was sent stays a tool_result", () => {
    const a = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" } as any);
    const converted = a.convertMessages(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "ok", toolCallId: "c1" },
      ],
      false,
    ) as any[];
    expect(converted[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
    });
  });
});

describe("toChatBody", () => {
  const body = (messages: ChatMessage[]) =>
    toChatBody(messages, { model: "gpt-4o" } as any).messages as any[];

  it("sends no tool call without an id or a name, and no tool_calls: []", () => {
    const sent = body([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "a",
        toolCalls: [
          { type: "function", function: { name: "read", arguments: "{}" } },
          { id: "c2", type: "function", function: { arguments: "{}" } },
        ],
      },
      { role: "assistant", content: "b", toolCalls: [] },
    ]);
    expect(sent[1]).not.toHaveProperty("tool_calls");
    expect(sent[2]).not.toHaveProperty("tool_calls");
  });

  it("keeps a well-formed call as it was", () => {
    const sent = body([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: "" },
          },
        ],
      },
    ]);
    expect(sent[0]).toEqual({
      role: "assistant",
      content: " ",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ],
    });
  });

  it("sends an empty user string as a space, and an image-only assistant as a space", () => {
    const sent = body([
      { role: "user", content: "" },
      {
        role: "assistant",
        content: [
          { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AA" } },
        ],
      },
    ]);
    expect(sent[0].content).toBe(" ");
    expect(sent[1].content).toBe(" ");
  });
});

describe("Gemini adapter", () => {
  const gemini = constructLlmApi({
    provider: "gemini",
    apiKey: "k",
  } as any) as any;
  const contents = (messages: ChatCompletionMessageParam[]) =>
    gemini._convertBody({ model: "gemini-2.5-pro", messages }, false, true)
      .contents as any[];

  it("skips an http image instead of sending inlineData without data", () => {
    const sent = contents([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/a.png" },
          },
        ],
      },
    ]);
    expect(sent).toEqual([{ role: "user", parts: [{ text: "what is this" }] }]);
  });

  it("keeps a data URL image", () => {
    const sent = contents([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64,AAAA" },
          },
        ],
      },
    ]);
    expect(sent[0].parts[0].inlineData.data).toBe("AAAA");
  });

  it("drops a turn left with no parts", () => {
    const sent = contents([
      { role: "user", content: "hi" },
      { role: "assistant", content: [] as any },
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://x/a.png" } }],
      },
    ]);
    for (const c of sent) expect(c.parts.length).toBeGreaterThan(0);
  });

  it("sends no functionCall without a name", () => {
    const sent = contents([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "looking",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
    ]);
    const calls = sent[1].parts.filter((p: any) => p.functionCall);
    expect(calls.map((p: any) => p.functionCall.name)).toEqual(["read"]);
  });
});

describe("AiSdk: tool call input is always an object", () => {
  const input = (args: string) =>
    (
      convertOpenAIMessagesToVercel([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read", arguments: args },
            },
          ],
        },
      ])[0].content as any[]
    )[0].input;

  it.each([
    ["", {}],
    ['{"path": "a', {}],
    ["[1,2]", {}],
    ['"text"', {}],
    ['{"path":"a.ts"}', { path: "a.ts" }],
  ])("%j", (args, expected) => {
    expect(input(args)).toEqual(expected);
  });

  it("sends array assistant content as text parts and images as image parts", () => {
    const converted = convertOpenAIMessagesToVercel([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "a cat" }],
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
    ]);
    expect(converted[0].content).toEqual([
      { type: "text", text: "see" },
      { type: "image", image: "data:image/png;base64,AA" },
    ]);
    expect((converted[1].content as any[])[0]).toEqual({
      type: "text",
      text: "a cat",
    });
  });
});

describe("Cohere adapter does not change the body it is given", () => {
  it("a retry sends the same request", () => {
    const api = constructLlmApi({
      provider: "cohere",
      apiKey: "k",
    } as any) as any;
    const body = {
      model: "command-r",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
    };
    const before = JSON.stringify(body);
    const first = api._convertBody(body);
    const second = api._convertBody(body);
    expect(JSON.stringify(body)).toBe(before);
    expect(second).toEqual(first);
    expect(first.message).toBe("again");
    expect(first.preamble).toBe("sys");
    expect(first.chat_history).toEqual([
      { role: "USER", message: "hi" },
      { role: "CHATBOT", message: "hello" },
    ]);
  });
});

describe("Cloudflare sends no thinking role", () => {
  it("leaves the reasoning turn out of the request", async () => {
    const cf = new Cloudflare({
      model: "@cf/meta/llama-3.1-8b-instruct",
      apiKey: "k",
      accountId: "a",
    } as any) as any;
    let sent: any;
    cf.fetch = async (_url: URL, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    for await (const _ of cf._streamChat(
      [
        { role: "user", content: "hi" },
        { role: "thinking", content: "hmm" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
      new AbortController().signal,
      { model: "m" },
    )) {
      // drain
    }
    expect(sent.messages.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });
});
