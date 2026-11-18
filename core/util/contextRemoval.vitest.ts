import { describe, expect, it } from "vitest";
import type {
  AssistantChatMessage,
  ChatHistoryItem,
  ChatMessage,
  ToolResultChatMessage,
} from "..";
import { computeContextBreakdown } from "../llm/contextBreakdown";
import {
  AGEING_METADATA_KEY,
  isMaskedToolResult,
  maskOldToolResults,
} from "./contextAgeing";
import {
  hasRemovals,
  IMAGE_REMOVED_STUB,
  maskRemovedToolResults,
  removedContextItemStub,
  removedToolResultLabels,
  removedToolResultStub,
  restoreRemovedToolResults,
  withRemovedParts,
} from "./contextRemoval";

const call = (id: string, name = "read_file") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

const messages: ChatMessage[] = [
  { role: "system", content: "You are a helper." },
  { role: "user", content: "Look at the files" },
  {
    role: "assistant",
    content: "",
    toolCalls: [call("a"), call("b"), call("c", "task_list")],
  },
  { role: "tool", toolCallId: "a", content: "A".repeat(48_000) },
  { role: "tool", toolCallId: "b", content: "short" },
  { role: "tool", toolCallId: "c", content: "task list" },
  { role: "assistant", content: "Done." },
];

const labels = new Map([
  ["a", "Read src/a.ts"],
  ["c", "task_list"],
]);

describe("maskRemovedToolResults", () => {
  it("stubs only the chosen results, whatever their size or tool", () => {
    const out = maskRemovedToolResults(messages, labels);
    const tools = out.messages.filter(
      (m): m is ToolResultChatMessage => m.role === "tool",
    );
    expect(tools.map((m) => m.content)).toEqual([
      "[output removed by you: 12k tokens, Read src/a.ts]",
      "short",
      "[output removed by you: 3 tokens, task_list]",
    ]);
    expect(out.masked.map((m) => m.toolCallId)).toEqual(["a", "c"]);
    expect(out.masked[0].original).toBe("A".repeat(48_000));
    // Ageing sees the stubs as masked and leaves them alone
    expect(tools.filter(isMaskedToolResult)).toHaveLength(2);
    expect(tools[0].metadata?.[AGEING_METADATA_KEY]).toMatch(/^mask-/);
  });

  it("keeps every tool call paired with one result carrying its id", () => {
    const out = maskRemovedToolResults(messages, labels).messages;
    expect(out).toHaveLength(messages.length);
    const calls = out.flatMap((m) =>
      m.role === "assistant"
        ? ((m as AssistantChatMessage).toolCalls ?? [])
        : [],
    );
    for (const c of calls) {
      const results = out.filter(
        (m) => m.role === "tool" && m.toolCallId === c.id,
      );
      expect(results).toHaveLength(1);
    }
    // Same positions, same roles: only the content of the chosen ones moved
    expect(out.map((m) => m.role)).toEqual(messages.map((m) => m.role));
  });

  it("does not modify its input and gives the same bytes twice", () => {
    const before = JSON.stringify(messages);
    const once = maskRemovedToolResults(messages, labels).messages;
    const twice = maskRemovedToolResults(once, labels).messages;
    expect(JSON.stringify(messages)).toBe(before);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("is undone by restoreRemovedToolResults (ageing's unmask)", () => {
    const out = maskRemovedToolResults(messages, labels);
    expect(restoreRemovedToolResults(out.messages, out.masked)).toEqual(
      messages,
    );
  });

  it("returns the input untouched when nothing is chosen", () => {
    const out = maskRemovedToolResults(messages, new Map());
    expect(out.messages).toBe(messages);
    expect(out.masked).toEqual([]);
  });

  it("leaves ageing's own stub as it was when no stub option is given", () => {
    const aged = maskOldToolResults(messages, { keepRecent: 0 });
    expect((aged.messages[3] as ToolResultChatMessage).content).toContain(
      "Call recall_masked_result with handle",
    );
  });
});

describe("removedToolResultStub", () => {
  it("names the size and the call", () => {
    expect(removedToolResultStub("Read README.md", 4000)).toBe(
      "[output removed by you: 1.0k tokens, Read README.md]",
    );
    expect(removedToolResultStub(undefined, 40)).toBe(
      "[output removed by you: 10 tokens, tool result]",
    );
  });
});

const ctxItem = (name: string, content: string) => ({
  id: { providerTitle: "file", itemId: name },
  name,
  description: name,
  content,
});

describe("withRemovedParts", () => {
  const item: ChatHistoryItem = {
    message: {
      role: "user",
      content: [
        { type: "text", text: "What is in this picture?" },
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
      ],
    },
    contextItems: [
      ctxItem("README.md", "R".repeat(9000)),
      ctxItem("b.ts", "b"),
    ],
  };

  it("returns the item itself when nothing is removed", () => {
    expect(withRemovedParts(item)).toBe(item);
    expect(hasRemovals(undefined)).toBe(false);
    expect(hasRemovals({ toolResults: [] })).toBe(false);
  });

  it("stubs the chosen context items and images, keeping the rest", () => {
    const out = withRemovedParts({
      ...item,
      removedByUser: { contextItems: [0], images: [1] },
    });
    expect(out.contextItems.map((c) => c.content)).toEqual([
      "[attached README.md removed by you]",
      "b",
    ]);
    expect(out.message.content).toEqual([
      { type: "text", text: "What is in this picture?" },
      { type: "text", text: IMAGE_REMOVED_STUB },
    ]);
    // The original is untouched: it is what Undo and Put back return to
    expect(item.contextItems[0].content).toBe("R".repeat(9000));
    expect(removedContextItemStub(item.contextItems[1])).toBe(
      "[attached b.ts removed by you]",
    );
  });

  it("ignores an image mark on a part that is not an image", () => {
    const out = withRemovedParts({ ...item, removedByUser: { images: [0] } });
    expect(out.message.content).toEqual(item.message.content);
  });
});

const toolState = (id: string, body: string, name = "read_file") => ({
  toolCallId: id,
  toolCall: {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify({ filepath: `src/${id}.ts` }) },
  },
  status: "done" as const,
  parsedArgs: { filepath: `src/${id}.ts` },
  output: [{ name: id, description: id, content: body }],
});

describe("computeContextBreakdown with removals", () => {
  const history: ChatHistoryItem[] = [
    { message: { role: "user", content: "U".repeat(4000) }, contextItems: [] },
    {
      message: { role: "assistant", content: "", toolCalls: [call("a")] },
      contextItems: [],
      toolCallStates: [toolState("a", "A".repeat(40_000))],
    },
    {
      message: { role: "user", content: "next" },
      contextItems: [ctxItem("README.md", "R".repeat(8000))],
    },
    {
      message: { role: "assistant", content: "", toolCalls: [call("b")] },
      contextItems: [],
      toolCallStates: [toolState("b", "B".repeat(20_000))],
    },
  ];
  const base = computeContextBreakdown({ segments: [], history });

  it("counts a removed result as its stub and leaves it out of the largest", () => {
    const marked = history.map((h, i) =>
      i === 1 ? { ...h, removedByUser: { toolResults: ["a"] } } : h,
    );
    const out = computeContextBreakdown({ segments: [], history: marked });
    const stub = removedToolResultStub("Read src/a.ts", 40_000);
    expect(base.estimatedTokens - out.estimatedTokens).toBe(
      10_000 - Math.ceil(stub.length / 4),
    );
    expect(out.largest.map((l) => l.label)).not.toContain("Read src/a.ts");
  });

  it("does not count a removed turn at all", () => {
    const marked = history.map((h, i) =>
      i < 2 ? { ...h, removedByUser: { turn: true } } : h,
    );
    const out = computeContextBreakdown({ segments: [], history: marked });
    const turn = computeContextBreakdown({
      segments: [],
      history: history.slice(0, 2),
    }).estimatedTokens;
    expect(out.estimatedTokens).toBe(base.estimatedTokens - turn);
  });

  it("finds the labels of the removed results", () => {
    const marked = history.map((h, i) =>
      i === 3 ? { ...h, removedByUser: { toolResults: ["b"] } } : h,
    );
    expect(
      removedToolResultLabels(marked, (s) => `label ${s.toolCallId}`),
    ).toEqual(new Map([["b", "label b"]]));
  });
});
