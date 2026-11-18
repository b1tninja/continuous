import { ChatMessage } from "../../index.js";
import Bedrock from "./Bedrock.js";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
    middlewareStack: { add: jest.fn() },
  })),
  ConverseStreamCommand: jest.fn(),
  ConverseCommand: jest.fn(),
  InvokeModelCommand: jest.fn(),
}));

jest.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: jest.fn().mockImplementation(() => async () => ({
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  })),
}));

const CLAUDE = "anthropic.claude-sonnet-4-6";
const NOVA = "us.amazon.nova-2-lite-v1:0";

function bedrock(model = CLAUDE): any {
  const b: any = new Bedrock({
    apiKey: "test-key",
    model,
    region: "us-east-1",
  });
  b.capabilities = { tools: true };
  return b;
}

const tools = [
  {
    type: "function" as const,
    function: { name: "read_file", description: "Read", parameters: {} },
  },
];

function convert(messages: ChatMessage[], model = CLAUDE, options: any = {}) {
  return bedrock(model)._generateConverseInput(messages, {
    model,
    tools,
    ...options,
  }).messages;
}

/**
 * What Converse asks of the messages: a user message first, roles that
 * alternate, content in every message and no blank text, and every
 * toolResult answering a toolUse in the message just before it.
 */
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
  type: "function" as const,
  function: { name: "read_file", arguments: '{"path":"a.ts"}' },
});

/** A finished first exchange, so the empty turn is never the first one. */
const earlier: ChatMessage[] = [
  { role: "system", content: "You are an agent." },
  { role: "user", content: "read a.ts" },
  { role: "assistant", content: "", toolCalls: [call("t1")] },
  { role: "tool", content: "export {}", toolCallId: "t1" },
  { role: "assistant", content: "It exports nothing." },
];

describe("Bedrock turns that convert to no content", () => {
  it("sends an assistant reply stopped before any text as nothing, joining the user turns", () => {
    // Stop or an error after the reply began leaves an empty assistant message
    for (const content of ["", "   \n"]) {
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

  it("keeps a Claude reply that was only reasoning", () => {
    const messages = convert([
      ...earlier,
      { role: "user", content: "think" },
      { role: "thinking", content: "hmm", signature: "sig" },
      { role: "assistant", content: "" },
      { role: "user", content: "well?" },
    ]);
    expectValidConverse(messages);
    expect(messages[5].content).toEqual([
      {
        reasoningContent: { reasoningText: { text: "hmm", signature: "sig" } },
      },
    ]);
  });

  it("joins the turns around redacted reasoning a non-Claude model can't take back", () => {
    const messages = convert(
      [
        ...earlier,
        { role: "user", content: "think" },
        { role: "thinking", content: "", redactedThinking: "[REDACTED]." },
        { role: "assistant", content: "" },
        { role: "user", content: "well?" },
      ],
      NOVA,
    );
    expectValidConverse(messages);
    expect(messages.at(-1).content.map((b: any) => b.text)).toEqual([
      "think",
      "well?",
    ]);
  });

  it("joins the turns around a reply whose only tool call has no id or name", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const messages = convert([
      ...earlier,
      { role: "user", content: "read b.ts" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ type: "function", function: { arguments: "{" } } as any],
      },
      { role: "tool", content: "cancelled", toolCallId: undefined as any },
      { role: "user", content: "never mind" },
    ]);
    warn.mockRestore();
    expectValidConverse(messages);
    // The result of the call that was left out goes as text, as before
    expect(messages.at(-1).content.map((b: any) => b.text)).toEqual([
      "read b.ts",
      "Tool call output for Tool Call ID undefined:\n\ncancelled",
      "never mind",
    ]);
  });

  it("joins the assistant turns around a user message that rendered empty", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    // Empty context items, or only an image Converse can't take (skipped)
    const bmp = {
      type: "imageUrl",
      imageUrl: { url: "data:image/bmp;base64,Qk0=" },
    };
    for (const content of [
      "  ",
      [] as any[],
      [{ type: "text", text: "" }],
      [bmp],
    ]) {
      const messages = convert([
        ...earlier,
        { role: "user", content } as ChatMessage,
        { role: "assistant", content: "Anything else?" },
        { role: "user", content: "no" },
      ]);
      expectValidConverse(messages);
      expect(messages[3].role).toBe("assistant");
      expect(messages[3].content.map((b: any) => b.text)).toEqual([
        "It exports nothing.",
        "Anything else?",
      ]);
    }
    warn.mockRestore();
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
      CLAUDE,
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

describe("Bedrock request for a history that is already valid", () => {
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
          toolCalls: [call("t2"), call("t3")],
        },
        { role: "tool", content: "export const b = 1;", toolCallId: "t2" },
        { role: "tool", content: "", toolCallId: "t3" },
        { role: "assistant", content: "b exports b; c is empty." },
        {
          role: "user",
          content: [
            { type: "text", text: "thanks" },
            { type: "text", text: "one more" },
          ],
        },
      ],
      CLAUDE,
      { promptCaching: true },
    );
    expectValidConverse(messages);
    expect(JSON.stringify(messages)).toBe(JSON.stringify(GOLDEN));
  });
});
