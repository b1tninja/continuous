import type {
  AssistantChatMessage,
  ChatHistoryItem,
  ChatMessage,
  ToolResultChatMessage,
} from "core";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";
import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { constructMessages } from "./constructMessages";

/** What "Choose what to keep" changes in the request (core/util/contextRemoval.ts). */

const toolCall = (id: string, name: string, args: object) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

const withTool = (
  msgId: string,
  id: string,
  name: string,
  args: object,
  body: string,
): ChatHistoryItemWithMessageId => ({
  message: {
    id: msgId,
    role: "assistant",
    content: "",
    toolCalls: [toolCall(id, name, args)],
  },
  contextItems: [],
  toolCallStates: [
    {
      toolCallId: id,
      toolCall: toolCall(id, name, args),
      status: "done",
      parsedArgs: args,
      output: [{ name: id, description: id, content: body }],
    },
  ],
});

const history: ChatHistoryItemWithMessageId[] = [
  {
    message: { id: "u1", role: "user", content: "first" },
    contextItems: [],
  },
  withTool("a1", "old", "read_file", { filepath: "old.ts" }, "O".repeat(900)),
  {
    message: {
      id: "u2",
      role: "user",
      content: [
        { type: "text", text: "second" },
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
      ],
    },
    contextItems: [
      {
        id: { providerTitle: "file", itemId: "r" },
        name: "README.md",
        description: "README.md",
        content: "R".repeat(5000),
      },
    ],
  },
  withTool(
    "a2",
    "read",
    "read_file",
    { filepath: "src/config/parseConfig.ts" },
    "P".repeat(48_000),
  ),
  { message: { id: "u3", role: "user", content: "third" }, contextItems: [] },
];

const build = (h: ChatHistoryItemWithMessageId[], framework?: any) =>
  constructMessages(h, "System.", [], {}, framework).messages;

const mark = (
  h: ChatHistoryItemWithMessageId[],
  marks: Record<string, ChatHistoryItem["removedByUser"]>,
) =>
  h.map((item) =>
    item.message.id && marks[item.message.id]
      ? { ...item, removedByUser: marks[item.message.id] }
      : item,
  );

/** Every tool call has exactly one result with its id, right after its call. */
function expectPaired(messages: ChatMessage[]) {
  messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    const calls = (m as AssistantChatMessage).toolCalls ?? [];
    const results = messages
      .slice(i + 1, i + 1 + calls.length)
      .map((r) => (r as ToolResultChatMessage).toolCallId);
    expect(results).toEqual(calls.map((c) => c.id));
  });
  const ids = messages.filter((m) => m.role === "tool").length;
  const calls = messages.flatMap((m) =>
    m.role === "assistant" ? ((m as AssistantChatMessage).toolCalls ?? []) : [],
  ).length;
  expect(ids).toBe(calls);
}

describe("constructMessages with removals", () => {
  it("sends the request unchanged when nothing is marked", () => {
    const plain = build(history);
    expect(build(history.map((h) => ({ ...h })))).toEqual(plain);
    expect(JSON.stringify(plain)).not.toContain("removed by you");
  });

  it("sends a removed result as a stub in the same tool message", () => {
    const plain = build(history);
    const out = build(mark(history, { a2: { toolResults: ["read"] } }));
    const result = out.find(
      (m): m is ToolResultChatMessage =>
        m.role === "tool" && m.toolCallId === "read",
    )!;
    expect(result.content).toBe(
      "[output removed by you: 12k tokens, Read src/config/parseConfig.ts]",
    );
    expectPaired(out);
    // Only that message differs
    const changed = out
      .map((m, i) => JSON.stringify(m) !== JSON.stringify(plain[i]))
      .flatMap((d, i) => (d ? [i] : []));
    expect(changed).toEqual([out.indexOf(result)]);
  });

  it("sends removed attached context and images as one line each", () => {
    const out = build(
      mark(history, { u2: { contextItems: [0], images: [1] } }),
    );
    const user = out.find(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("second"),
    )!;
    expect(user.content).toEqual([
      { type: "text", text: "[attached README.md removed by you]\n" },
      { type: "text", text: "second" },
      { type: "text", text: "[image removed by you]" },
    ]);
  });

  it("leaves out removed old turns whole, so the request starts with a user message", () => {
    const out = build(
      mark(history, { u1: { turn: true }, a1: { turn: true } }),
    );
    expect(out.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(JSON.stringify(out)).not.toContain("old.ts");
    expectPaired(out);
  });

  it("stubs a removed result for a model that takes tools as text", () => {
    const framework = new SystemMessageToolCodeblocksFramework();
    const plain = JSON.stringify(build(history, framework));
    const out = JSON.stringify(
      build(mark(history, { a2: { toolResults: ["read"] } }), framework),
    );
    expect(plain).toContain("P".repeat(1000));
    expect(out).not.toContain("P".repeat(1000));
    expect(out).toContain(
      "[output removed by you: 12k tokens, Read src/config/parseConfig.ts]",
    );
  });
});
