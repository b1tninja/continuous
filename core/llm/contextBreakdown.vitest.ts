import { describe, expect, it } from "vitest";
import type { ChatHistoryItem } from "..";
import {
  computeContextBreakdown,
  describeToolCall,
  IMAGE_TOKENS,
  reservedTokensFor,
} from "./contextBreakdown";
import { getTokenCountingBufferSafety } from "./countTokens";
import { makeSegment } from "./promptSegments";

const chars = (n: number, c = "x") => c.repeat(n);

// What describeChatRequest returns for a request: tools, the system message
// split into its parts, and the history as one segment (ignored here).
const segments = [
  makeSegment({
    id: "tools.builtin@agent",
    source: "builtin",
    stability: "static",
    region: "tools",
    text: chars(8000),
  }),
  makeSegment({
    id: "tools.mcp",
    source: "mcp",
    stability: "session",
    region: "tools",
    text: chars(2000),
  }),
  makeSegment({
    id: "turn.agent@full",
    source: "mode",
    stability: "static",
    region: "system",
    text: chars(4000),
  }),
  makeSegment({
    id: "rules.session:style",
    source: "rules",
    stability: "session",
    region: "system",
    text: chars(1200),
  }),
  makeSegment({
    id: "history",
    source: "history",
    stability: "turn",
    region: "history",
    text: chars(999_999),
  }),
];

const history: ChatHistoryItem[] = [
  // Before the summary: not in the request
  {
    message: { role: "user", content: chars(40_000) },
    contextItems: [],
  },
  {
    message: { role: "assistant", content: "Done." },
    contextItems: [],
    conversationSummary: chars(2000),
  },
  {
    message: {
      role: "user",
      content: [
        { type: "text", text: chars(400) },
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
      ],
    },
    contextItems: [
      {
        id: { providerTitle: "file", itemId: "1" },
        name: "README.md",
        description: "README.md",
        content: chars(3999),
      },
    ],
  },
  {
    message: { role: "thinking", content: chars(800) },
    contextItems: [],
  },
  {
    message: {
      role: "assistant",
      content: chars(200),
      toolCalls: [
        {
          id: "c1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filepath: "src/x.ts" }),
          },
        },
        {
          id: "c2",
          type: "function",
          function: {
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "npm test" }),
          },
        },
      ],
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "c1",
        toolCall: {
          id: "c1",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filepath: "src/x.ts" }),
          },
        },
        status: "done",
        parsedArgs: { filepath: "src/x.ts" },
        output: [
          { name: "x.ts", description: "src/x.ts", content: chars(48_000) },
        ],
      },
      {
        toolCallId: "c2",
        toolCall: {
          id: "c2",
          type: "function",
          function: {
            name: "run_terminal_command",
            arguments: JSON.stringify({ command: "npm test" }),
          },
        },
        status: "done",
        parsedArgs: { command: "npm test" },
        output: [
          { name: "Terminal", description: "npm test", content: chars(8000) },
        ],
      },
    ],
  },
  // A tool message in the history is rebuilt from the states above, so it is not counted twice
  {
    message: { role: "tool", content: chars(48_000), toolCallId: "c1" },
    contextItems: [],
  },
] as ChatHistoryItem[];

const tokensOf = (b: ReturnType<typeof computeContextBreakdown>, key: string) =>
  b.categories.find((c) => c.key === key)?.tokens ?? 0;

describe("computeContextBreakdown", () => {
  it("counts a file attached twice once, the second copy as its stub (as sent)", () => {
    const file = {
      id: { providerTitle: "file", itemId: "a.ts" },
      name: "a.ts",
      description: "src/a.ts",
      content: "x".repeat(3999),
      uri: { type: "file" as const, value: "file:///w/src/a.ts" },
    };
    const twice = computeContextBreakdown({
      segments: [],
      history: [
        { message: { role: "user", content: "one" }, contextItems: [file] },
        { message: { role: "assistant", content: "ok" }, contextItems: [] },
        { message: { role: "user", content: "two" }, contextItems: [file] },
      ],
      contextLength: 200_000,
    });
    // 4000 characters with the newline: 1000 tokens once, plus a short stub
    const context = tokensOf(twice, "context");
    expect(context).toBeGreaterThan(1000);
    expect(context).toBeLessThan(1030);
  });

  it("splits a fixture history into the categories the request carries", () => {
    const b = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
    });
    expect(b.scaled).toBe(false);
    expect(tokensOf(b, "tools")).toBe(2500);
    expect(tokensOf(b, "system")).toBe(1000);
    expect(tokensOf(b, "rules")).toBe(300);
    // The attached file: its content and the newline constructMessages adds
    expect(tokensOf(b, "context")).toBe(1000);
    expect(tokensOf(b, "user")).toBe(100);
    expect(tokensOf(b, "images")).toBe(IMAGE_TOKENS);
    expect(tokensOf(b, "reasoning")).toBe(200);
    expect(tokensOf(b, "assistant")).toBe(50);
    expect(tokensOf(b, "toolResults")).toBe(12_000);
    expect(tokensOf(b, "terminal")).toBe(2000);
    expect(tokensOf(b, "toolCalls")).toBeGreaterThan(0);
    // The turns before the summary are not in the request; the summary
    // itself is a system segment, absent from this fixture's segments
    expect(tokensOf(b, "summary")).toBe(0);
    const sum = b.categories.reduce((a, c) => a + c.tokens, 0);
    expect(b.usedTokens).toBe(sum);
    expect(b.estimatedTokens).toBe(sum);
  });

  it("keeps the category order and drops empty categories", () => {
    const b = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
    });
    expect(b.categories.map((c) => c.key)).toEqual([
      "system",
      "tools",
      "rules",
      "context",
      "user",
      "assistant",
      "toolCalls",
      "toolResults",
      "terminal",
      "images",
      "reasoning",
    ]);
  });

  it("lists the largest items with what they are", () => {
    const b = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
    });
    expect(b.largest[0]).toEqual({
      category: "toolResults",
      label: "Read src/x.ts",
      tokens: 12_000,
    });
    expect(b.largest[1]).toMatchObject({
      category: "terminal",
      label: "run_terminal_command npm test",
    });
    expect(b.largest[2]).toMatchObject({ category: "images" });
    expect(b.largest).toHaveLength(3);
  });

  it("computes free space, the reserve and the line where pruning starts", () => {
    const b = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
      maxTokens: 8192,
    });
    expect(b.reservedTokens).toBe(2000);
    expect(b.pruneAtTokens).toBe(198_000);
    expect(b.freeTokens).toBe(200_000 - 2000 - b.usedTokens);
    expect(b.fraction).toBeCloseTo(b.usedTokens / 200_000);
    const shares =
      b.categories.reduce((a, c) => a + c.share, 0) +
      (b.freeTokens! + b.reservedTokens!) / 200_000;
    expect(shares).toBeCloseTo(1);
  });

  it("scales the estimate to the provider's count and says the split is estimated", () => {
    const plain = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
    });
    const reported = plain.estimatedTokens * 2;
    const b = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
      reportedTokens: reported,
    });
    expect(b.scaled).toBe(true);
    expect(b.usedTokens).toBe(reported);
    expect(b.estimatedTokens).toBe(plain.estimatedTokens);
    expect(tokensOf(b, "toolResults")).toBe(24_000);
    expect(b.largest[0].tokens).toBe(24_000);
    const sum = b.categories.reduce((a, c) => a + c.tokens, 0);
    expect(Math.abs(sum - reported)).toBeLessThanOrEqual(b.categories.length);
  });

  it("does not inflate the split when the provider's count is far above the estimate", () => {
    const plain = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
    });
    const reported = plain.estimatedTokens * 5;
    const b = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
      reportedTokens: reported,
    });
    expect(b.scaled).toBe(true);
    expect(b.usedTokens).toBe(reported);
    expect(tokensOf(b, "toolResults")).toBe(12_000);
    expect(tokensOf(b, "other")).toBe(reported - plain.estimatedTokens);
    expect(b.categories.at(-1)?.label).toBe("Not itemised");
  });

  it("shares out of the used total when the window is unknown", () => {
    const b = computeContextBreakdown({ segments, history });
    expect(b.window).toBeUndefined();
    expect(b.freeTokens).toBeUndefined();
    expect(b.categories.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1);
  });

  it("counts an empty conversation as setup only", () => {
    const b = computeContextBreakdown({
      segments,
      history: [],
      contextLength: 8192,
    });
    expect(b.categories.map((c) => c.key)).toEqual([
      "system",
      "tools",
      "rules",
    ]);
    expect(b.largest).toEqual([]);
  });
});

describe("reservedTokensFor", () => {
  it.each([8192, 32_000, 200_000, 1_000_000])(
    "keeps the same reserve as core's compileChatMessages for a %i window",
    (window) => {
      expect(reservedTokensFor(window, 4096)).toBe(
        Math.round(getTokenCountingBufferSafety(window) + 1000),
      );
      expect(reservedTokensFor(window, 500)).toBe(
        Math.round(getTokenCountingBufferSafety(window) + 500),
      );
    },
  );
});

describe("describeToolCall", () => {
  it("names the tool and its main argument", () => {
    expect(describeToolCall("read_file", '{"filepath":"a/b.ts"}')).toBe(
      "Read a/b.ts",
    );
    expect(describeToolCall("grep_search", { query: "foo" })).toBe(
      "grep_search foo",
    );
    expect(describeToolCall("mcp_tool", "not json")).toBe("mcp_tool");
  });
});
