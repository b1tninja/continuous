import { describe, expect, it, vi } from "vitest";
import { BedrockApi } from "./Bedrock.js";

const tool = {
  type: "function",
  function: { name: "read_file", description: "Read", parameters: {} },
};

function convert(messages: any[], extra: any = {}, config: any = {}) {
  const api = new BedrockApi({
    provider: "bedrock",
    env: {},
    ...config,
  } as any) as any;
  return api._convertBody({
    model: "anthropic.claude-sonnet-4-6",
    messages,
    tools: [tool],
    ...extra,
  }).messages;
}

/** Converse: user first, alternating roles, no empty message or blank text, results after their calls. */
function expectValidConverse(messages: any[]) {
  expect(messages.length).toBeGreaterThan(0);
  expect(messages[0].role).toBe("user");
  messages.forEach((message, i) => {
    if (i > 0) expect(message.role).not.toBe(messages[i - 1].role);
    expect(message.content.length).toBeGreaterThan(0);
    expect(message.content[0].cachePoint).toBeUndefined();
    for (const block of message.content) {
      if (block.text !== undefined) expect(block.text.trim()).not.toBe("");
      if (block.toolResult) {
        const uses = (messages[i - 1]?.content ?? []).map(
          (b: any) => b.toolUse?.toolUseId,
        );
        expect(uses).toContain(block.toolResult.toolUseId);
      }
    }
  });
}

const call = (id: string) => ({
  id,
  type: "function",
  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
});

const earlier = [
  { role: "system", content: "You are an agent." },
  { role: "user", content: "read a.ts" },
  { role: "assistant", content: null, tool_calls: [call("t1")] },
  { role: "tool", content: "export {}", tool_call_id: "t1" },
  { role: "assistant", content: "It exports nothing." },
];

describe("BedrockApi turns that convert to no content", () => {
  it("joins the user turns around an assistant reply stopped before any text", () => {
    for (const content of ["", "  \n", null, [{ type: "text", text: " " }]]) {
      const messages = convert([
        ...earlier,
        { role: "user", content: "and b.ts?" },
        { role: "assistant", content },
        { role: "user", content: "please" },
      ]);
      expectValidConverse(messages);
      expect(messages).toHaveLength(5);
      expect(messages[4].content.map((b: any) => b.text)).toEqual([
        "and b.ts?",
        "please",
      ]);
    }
  });

  it("joins the turns around a reply whose only tool call has no id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages = convert([
      ...earlier,
      { role: "user", content: "read b.ts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ type: "function", function: { name: "read_file" } }],
      },
      { role: "user", content: "never mind" },
    ]);
    warn.mockRestore();
    expectValidConverse(messages);
    expect(messages.at(-1).content.map((b: any) => b.text)).toEqual([
      "read b.ts",
      "never mind",
    ]);
  });

  it("joins the assistant turns around a user message with no text", () => {
    for (const content of ["", "   ", [{ type: "text", text: "" }]]) {
      const messages = convert([
        ...earlier,
        { role: "user", content },
        { role: "assistant", content: "Anything else?" },
        { role: "user", content: "no" },
      ]);
      expectValidConverse(messages);
      expect(messages[3].content.map((b: any) => b.text)).toEqual([
        "It exports nothing.",
        "Anything else?",
      ]);
    }
  });

  it("joins consecutive messages of the same role", () => {
    const messages = convert([
      { role: "user", content: "one" },
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "two" },
      { role: "user", content: "three" },
    ]);
    expectValidConverse(messages);
    expect(messages.map((m: any) => m.content.map((b: any) => b.text))).toEqual(
      [["one"], ["a", "b"], ["two", "three"]],
    );
  });

  it("handles the first turns: an empty opening on either side", () => {
    expect(
      convert([
        { role: "assistant", content: "" },
        { role: "user", content: "hi" },
      ]),
    ).toEqual([{ role: "user", content: [{ text: "hi" }] }]);

    const messages = convert([
      { role: "user", content: "" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "hi" },
    ]);
    expectValidConverse(messages);
    expect(messages.map((m: any) => m.content[0].text)).toEqual([
      ".",
      "Hello",
      "hi",
    ]);
  });

  it("keeps cache points valid after joining turns", () => {
    const messages = convert(
      [
        ...earlier,
        { role: "user", content: "and b.ts?" },
        { role: "assistant", content: "" },
        { role: "user", content: "please" },
      ],
      {},
      { promptCaching: true },
    );
    expectValidConverse(messages);
    const points = messages.flatMap((m: any) =>
      m.content.filter((b: any) => b.cachePoint),
    );
    expect(points).toHaveLength(2);
    expect(messages.at(-1).content.at(-1).cachePoint).toBeDefined();
  });
});

describe("BedrockApi request for a history that is already valid", () => {
  // Generated before the empty-turn repair existed; a change here moves the
  // cached prompt prefix of every conversation
  const GOLDEN = [
    {
      role: "user",
      content: [
        {
          text: "read a.ts",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          toolUse: {
            toolUseId: "t1",
            name: "read_file",
            input: {
              path: "a.ts",
            },
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "t1",
            content: [
              {
                text: "export {}",
              },
            ],
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          text: "It exports nothing.",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          text: "now b.ts and c.ts",
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          text: "Reading both.",
        },
        {
          toolUse: {
            toolUseId: "t2",
            name: "read_file",
            input: {
              path: "a.ts",
            },
          },
        },
        {
          toolUse: {
            toolUseId: "t3",
            name: "read_file",
            input: {
              path: "a.ts",
            },
          },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "t2",
            content: [
              {
                text: "export const b = 1;",
              },
            ],
          },
        },
        {
          toolResult: {
            toolUseId: "t3",
            content: [
              {
                text: "No tool output",
              },
            ],
          },
        },
        {
          cachePoint: {
            type: "default",
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          text: "b exports b; c is empty.",
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          text: "thanks",
        },
        {
          text: "one more",
        },
        {
          cachePoint: {
            type: "default",
          },
        },
      ],
    },
  ];

  it("sends the same bytes as before", () => {
    const messages = convert(
      [
        ...earlier,
        { role: "user", content: "now b.ts and c.ts" },
        {
          role: "assistant",
          content: "Reading both.",
          tool_calls: [call("t2"), call("t3")],
        },
        { role: "tool", content: "export const b = 1;", tool_call_id: "t2" },
        { role: "tool", content: "", tool_call_id: "t3" },
        { role: "assistant", content: "b exports b; c is empty." },
        {
          role: "user",
          content: [
            { type: "text", text: "thanks" },
            { type: "text", text: "one more" },
          ],
        },
      ],
      {},
      { promptCaching: true },
    );
    expectValidConverse(messages);
    expect(JSON.stringify(messages)).toBe(JSON.stringify(GOLDEN));
  });
});
