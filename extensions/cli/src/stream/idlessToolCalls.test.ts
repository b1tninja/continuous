import type { ChatHistoryItem } from "core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolCall } from "../tools/types.js";

import { handleToolCalls } from "./handleToolCalls.js";
import { resetRepeatGuard } from "./repeatGuard.js";
import {
  executeStreamedToolCalls,
  preprocessStreamedToolCalls,
  processToolCallDelta,
} from "./streamChatResponse.helpers.js";

vi.mock("./streamChatResponse.helpers.js", async (original) => ({
  ...(await original<object>()),
  preprocessStreamedToolCalls: vi.fn(),
  executeStreamedToolCalls: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  services: {
    chatHistory: {
      isReady: vi.fn().mockReturnValue(false),
      addAssistantMessage: vi.fn(),
      addToolResult: vi.fn(),
    },
  },
}));

/** The calls a stream of deltas assembles into. */
function assemble(deltas: unknown[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  const indexToId = new Map<number, string>();
  for (const delta of deltas) processToolCallDelta(delta, calls, indexToId);
  return [...calls.values()];
}

describe("a streamed tool call with an index and no id (upstream 13225)", () => {
  beforeEach(() => resetRepeatGuard());

  it("becomes one call with an id of its own", () => {
    const calls = assemble([
      { index: 0, function: { name: "Read", arguments: "" } },
      { index: 0, function: { arguments: '{"filepath":' } },
      { index: 0, id: "", function: { arguments: '"a.ts"}' } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toMatch(/^call_[0-9a-f]{32}$/);
    expect(calls[0].name).toBe("Read");
    expect(calls[0].arguments).toEqual({ filepath: "a.ts" });
  });

  it("keeps two id-less calls apart by their index", () => {
    const calls = assemble([
      { index: 0, function: { name: "Read", arguments: '{"filepath":' } },
      { index: 1, function: { name: "List", arguments: '{"dirpath":' } },
      { index: 0, function: { arguments: '"a.ts"}' } },
      { index: 1, function: { arguments: '"src"}' } },
    ]);
    expect(calls.map((c) => [c.name, c.arguments])).toEqual([
      ["Read", { filepath: "a.ts" }],
      ["List", { dirpath: "src" }],
    ]);
    expect(calls[0].id).not.toBe(calls[1].id);
  });

  it("still uses the id the provider sent", () => {
    const calls = assemble([
      { index: 0, id: "call_abc", function: { name: "Read", arguments: "{" } },
      { index: 0, function: { arguments: "}" } },
    ]);
    expect(calls.map((c) => c.id)).toEqual(["call_abc"]);
  });

  it("runs and is paired with its result", async () => {
    const calls = assemble([
      {
        index: 0,
        function: { name: "Read", arguments: '{"filepath":"a.ts"}' },
      },
    ]);
    vi.mocked(preprocessStreamedToolCalls).mockImplementation(
      async (_headless, toRun) =>
        ({ preprocessedCalls: toRun, errorChatEntries: [] }) as never,
    );
    vi.mocked(executeStreamedToolCalls).mockImplementation(
      async (ran) =>
        ({
          hasRejection: false,
          chatHistoryEntries: ran.map((call) => ({
            role: "tool",
            tool_call_id: call.id,
            content: "the file's contents",
            status: "done",
          })),
        }) as never,
    );

    const history: ChatHistoryItem[] = [];
    await handleToolCalls({
      toolCalls: calls,
      chatHistory: history,
      content: "",
      callbacks: undefined,
      isHeadless: true,
    });

    expect(vi.mocked(executeStreamedToolCalls).mock.calls[0][0]).toHaveLength(
      1,
    );
    const state = history[0].toolCallStates?.[0];
    expect(state?.toolCallId).toBe(calls[0].id);
    expect((history[0].message as any).toolCalls[0].id).toBe(calls[0].id);
    expect(state).toMatchObject({
      status: "done",
      output: [{ content: "the file's contents" }],
    });
  });
});
