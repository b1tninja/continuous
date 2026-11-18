import type { ChatHistoryItem } from "core";
import { computeContextBreakdown } from "core/llm/contextBreakdown";
import { describe, expect, it } from "vitest";
import type { ChatHistoryItemWithMessageId } from "../redux/slices/sessionSlice";
import {
  applyContextRemovals,
  clearContextRemovalUndo,
  newSession,
  sessionSlice,
  undoContextRemovals,
} from "../redux/slices/sessionSlice";
import { formatRereadCost } from "./cacheNotices";
import {
  currentBreakdown,
  editCacheLoss,
  groupState,
  historyTokens,
  inRemovedTurn,
  initialSelection,
  keepTotals,
  listRemovable,
  marksFor,
  removedTurnCount,
  setGroupKept,
  setKept,
  withMarks,
} from "./selectiveCompaction";

const ctx = (name: string, chars: number) => ({
  id: { providerTitle: "file", itemId: name },
  name,
  description: name,
  content: "c".repeat(chars),
});

const toolCall = (id: string, name: string, args: object) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

const assistantWithTool = (
  msgId: string,
  id: string,
  name: string,
  args: object,
  chars: number,
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
      output: [{ name: id, description: id, content: "o".repeat(chars) }],
    },
  ],
});

/** Three turns: two old ones that can go, and the latest, which stays. */
const history: ChatHistoryItemWithMessageId[] = [
  {
    message: { id: "u1", role: "user", content: "Read the config parser" },
    contextItems: [ctx("README.md", 7999)],
  },
  assistantWithTool(
    "a1",
    "read",
    "read_file",
    { filepath: "src/config/parseConfig.ts" },
    48_000,
  ),
  {
    message: {
      id: "u2",
      role: "user",
      content: [
        { type: "text", text: "Run the tests" },
        { type: "imageUrl", imageUrl: { url: "data:image/png;base64,AAAA" } },
      ],
    },
    contextItems: [],
  },
  assistantWithTool(
    "a2",
    "term",
    "run_terminal_command",
    { command: "npm test" },
    8400,
  ),
  { message: { id: "u3", role: "user", content: "Thanks" }, contextItems: [] },
  {
    message: { id: "a3", role: "assistant", content: "Done." },
    contextItems: [],
  },
];

const model = listRemovable(history);
const keys = Object.fromEntries(
  [...model.items, ...model.turns].map((i) => [i.label, i.key]),
);

describe("listRemovable", () => {
  it("offers results, terminal output, context and images, largest first", () => {
    expect(
      model.items.map((i) => [i.group, i.label, i.tokens, i.removed]),
    ).toEqual([
      ["toolResults", "Read src/config/parseConfig.ts", 12_000, false],
      ["terminal", "run_terminal_command npm test", 2100, false],
      ["context", "README.md", 2000, false],
      ["images", "Image in turn 2", 1024, false],
    ]);
  });

  it("offers the old turns, never the latest", () => {
    expect(
      model.turns.map((t) => [t.label, t.historyIndex, t.turnEnd]),
    ).toEqual([
      ["Turn 1: Read the config parser", 0, 1],
      ["Turn 2: Run the tests", 2, 3],
    ]);
    expect(model.turns[0].tokens).toBe(historyTokens(history.slice(0, 2)));
  });

  it("starts after a conversation summary", () => {
    const summarised = history.map((h, i) =>
      i === 1 ? { ...h, conversationSummary: "summary" } : h,
    );
    const m = listRemovable(summarised);
    expect(m.start).toBe(2);
    expect(m.turns.map((t) => t.historyIndex)).toEqual([2]);
    expect(m.items.map((i) => i.label)).not.toContain(
      "Read src/config/parseConfig.ts",
    );
  });

  it("marks what is removed now, and leaves out the inside of a removed turn", () => {
    const marked = withMarks(history, {
      marks: {
        u1: { turn: true },
        a1: { turn: true },
        a2: { toolResults: ["term"] },
      },
    });
    const m = listRemovable(marked);
    expect(m.turns[0].removed).toBe(true);
    expect(m.items.map((i) => i.label)).toEqual([
      "run_terminal_command npm test",
      "Image in turn 2",
    ]);
    expect(m.items[0].removed).toBe(true);
    expect(initialSelection(m)).toEqual(
      new Set([m.turns[0].key, m.items[0].key]),
    );
  });
});

describe("the selection", () => {
  it("removes turns only from the start", () => {
    const second = setKept(model, new Set(), model.turns[1].key, false);
    expect(removedTurnCount(model, second)).toBe(2);
    // Keeping turn 1 again keeps every turn after it too
    const back = setKept(model, second, model.turns[0].key, true);
    expect(back.size).toBe(0);
    // Keeping turn 2 leaves turn 1 removed
    const first = setKept(model, second, model.turns[1].key, true);
    expect([...first]).toEqual([model.turns[0].key]);
  });

  it("treats the items of a removed turn as gone", () => {
    const sel = setKept(model, new Set(), model.turns[0].key, false);
    const read = model.items.find((i) => i.group === "toolResults")!;
    const image = model.items.find((i) => i.group === "images")!;
    expect(inRemovedTurn(model, sel, read)).toBe(true);
    expect(inRemovedTurn(model, sel, image)).toBe(false);
    expect(groupState(model, sel, "toolResults")).toBe("all");
  });

  it("has a mixed state for a group partly kept", () => {
    const two = {
      ...model,
      items: [
        ...model.items,
        { ...model.items[0], key: "tool:other", label: "Read b.ts" },
      ],
    };
    const sel = setKept(two, new Set(), "tool:other", false);
    expect(groupState(two, sel, "toolResults")).toBe("some");
    expect(
      groupState(
        two,
        setGroupKept(two, sel, "toolResults", false),
        "toolResults",
      ),
    ).toBe("none");
    expect(
      groupState(
        two,
        setGroupKept(two, sel, "toolResults", true),
        "toolResults",
      ),
    ).toBe("all");
  });
});

describe("marksFor", () => {
  it("is empty when nothing changes", () => {
    expect(marksFor(history, model, new Set())).toEqual({ marks: {} });
  });

  it("marks a removed result on its assistant item", () => {
    const sel = new Set([keys["Read src/config/parseConfig.ts"]]);
    expect(marksFor(history, model, sel)).toEqual({
      marks: { a1: { toolResults: ["read"] } },
      firstChanged: 1,
    });
  });

  it("marks context items and images on their user item", () => {
    const sel = new Set([keys["README.md"], keys["Image in turn 2"]]);
    expect(marksFor(history, model, sel)).toEqual({
      marks: { u1: { contextItems: [0] }, u2: { images: [1] } },
      firstChanged: 0,
    });
  });

  it("marks every item of a removed turn", () => {
    const sel = setKept(model, new Set(), model.turns[1].key, false);
    expect(marksFor(history, model, sel).marks).toEqual({
      u1: { turn: true },
      a1: { turn: true },
      u2: { turn: true },
      a2: { turn: true },
    });
  });

  it("clears marks for what is put back", () => {
    const marked = withMarks(history, {
      marks: { a1: { toolResults: ["read"] } },
    });
    const m = listRemovable(marked);
    expect(marksFor(marked, m, new Set())).toEqual({
      marks: { a1: null },
      firstChanged: 1,
    });
  });

  it("keeps the marks inside a removed turn when the turn comes back", () => {
    const marked = withMarks(history, {
      marks: { u1: { turn: true, contextItems: [0] }, a1: { turn: true } },
    });
    const m = listRemovable(marked);
    expect(marksFor(marked, m, new Set()).marks).toEqual({
      u1: { contextItems: [0] },
      a1: null,
    });
  });
});

describe("keepTotals", () => {
  const segments: any[] = [];
  it("gives the size after, scaled to the provider's count, and what is re-read", () => {
    const estimate = historyTokens(history);
    const now = computeContextBreakdown({
      segments,
      history,
      contextLength: 200_000,
      reportedTokens: estimate * 1.5,
    });
    const changes = marksFor(
      history,
      model,
      new Set([keys["run_terminal_command npm test"]]),
    );
    const totals = keepTotals({ history, segments, now, changes });
    const after = withMarks(history, changes);
    const removedEstimate = estimate - historyTokens(after);
    expect(totals.factor).toBeCloseTo(1.5);
    expect(totals.nowTokens).toBe(Math.round(estimate * 1.5));
    expect(totals.removedTokens).toBe(Math.round(removedEstimate * 1.5));
    expect(totals.afterTokens).toBe(totals.nowTokens - totals.removedTokens);
    expect(totals.window).toBe(200_000);
    // The terminal result is in turn 2: everything from its item on is re-read
    expect(totals.fromTurn).toBe(2);
    expect(totals.rereadTokens).toBe(
      Math.round(historyTokens(after.slice(3)) * 1.5),
    );
  });

  it("re-reads the whole conversation when the first turn goes", () => {
    const now = computeContextBreakdown({ segments, history });
    const changes = marksFor(
      history,
      model,
      setKept(model, new Set(), model.turns[0].key, false),
    );
    const totals = keepTotals({ history, segments, now, changes });
    expect(totals.factor).toBe(1);
    expect(totals.fromTurn).toBe(1);
    expect(totals.rereadTokens).toBe(historyTokens(history.slice(2)));
    expect(totals.afterTokens).toBe(historyTokens(history.slice(2)));
  });

  it("re-reads nothing when nothing changes", () => {
    const now = computeContextBreakdown({ segments, history });
    const totals = keepTotals({
      history,
      segments,
      now,
      changes: { marks: {} },
    });
    expect(totals.removedTokens).toBe(0);
    expect(totals.rereadTokens).toBe(0);
    expect(totals.fromTurn).toBeUndefined();
  });
});

describe("editCacheLoss", () => {
  const sonnet = {
    title: "Sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    underlyingProviderName: "anthropic",
  } as any;
  const now = 1_000_000_000;
  const warm = {
    escalated: false,
    lastRequestAt: now - 1000,
    lastTtl: "5m" as const,
    lastInputTokens: 100_000,
  };

  it("prices the re-read of what follows the first change", () => {
    // Sonnet 4.6: 5-minute write $3.75/MTok against a read at $0.30/MTok
    const whole = editCacheLoss(sonnet, "5m", warm, now, 100_000)!;
    expect(whole.extraUsd).toBeCloseTo(0.345, 6);
    const part = editCacheLoss(sonnet, "5m", warm, now, 40_000)!;
    expect(part.tokens).toBe(40_000);
    expect(part.extraUsd).toBeCloseTo(0.138, 6);
    expect(formatRereadCost(part)).toBe(
      "40k tokens at full price (about $0.14 more)",
    );
  });

  it("is nothing while the cache is cold or off, or for no change", () => {
    expect(
      editCacheLoss(
        sonnet,
        "5m",
        { ...warm, lastRequestAt: now - 3_600_000 },
        now,
        40_000,
      ),
    ).toBeUndefined();
    expect(editCacheLoss(sonnet, "off", warm, now, 40_000)).toBeUndefined();
    expect(editCacheLoss(sonnet, "5m", warm, now, 0)).toBeUndefined();
  });

  it("never re-reads more than the cache holds", () => {
    expect(editCacheLoss(sonnet, "5m", warm, now, 250_000)!.tokens).toBe(
      100_000,
    );
  });

  it("is time, not money, on a local server", () => {
    const local = {
      title: "Strata",
      provider: "openai",
      model: "qwen3.8-flash-next-nvfp4-nvfp4",
      apiBase: "http://127.0.0.1:8083/v1/",
      underlyingProviderName: "openai",
    } as any;
    const loss = editCacheLoss(
      local,
      undefined,
      { ...warm, promptTokensPerSecond: 1000 },
      now,
      30_000,
    )!;
    expect(loss).toMatchObject({ local: true, tokens: 30_000, seconds: 30 });
    expect(formatRereadCost(loss)).toBe(
      "30k tokens from scratch on the model server (about 30 s at its last speed)",
    );
  });
});

describe("currentBreakdown", () => {
  it("takes unsent removals off the provider's count", () => {
    const estimate = historyTokens(history);
    const changes = marksFor(
      history,
      model,
      new Set([keys["Read src/config/parseConfig.ts"]]),
    );
    const after = withMarks(history, changes);
    const previous = Object.fromEntries(
      Object.keys(changes.marks).map((k) => [k, null]),
    );
    const out = currentBreakdown({
      segments: [],
      history: after,
      previousMarks: previous,
      reportedTokens: estimate * 2,
    });
    expect(out.usedTokens).toBe(
      estimate * 2 - (estimate - historyTokens(after)) * 2,
    );
  });
});

describe("the session's undo", () => {
  const reduce = (actions: any[]) =>
    actions.reduce(
      (s, a) => sessionSlice.reducer(s, a),
      sessionSlice.reducer(
        undefined,
        newSession({
          sessionId: "s",
          title: "t",
          workspaceDirectory: "",
          history,
        } as any),
      ),
    );

  it("puts back the marks from before the first change since the last request", () => {
    const state = reduce([
      applyContextRemovals({
        marks: { a1: { toolResults: ["read"] } },
        removedTokens: 12_000,
      }),
      applyContextRemovals({
        marks: { a1: null, a2: { toolResults: ["term"] } },
        removedTokens: -10_000,
      }),
    ]);
    expect(state.history[1].removedByUser).toBeUndefined();
    expect(state.history[3].removedByUser).toEqual({ toolResults: ["term"] });
    expect(state.contextRemovalUndo).toEqual({
      previous: { a1: null, a2: null },
      removedTokens: 2000,
    });
    const undone = sessionSlice.reducer(state, undoContextRemovals());
    expect(undone.history.map((h: any) => h.removedByUser)).toEqual(
      history.map(() => undefined),
    );
    expect(undone.contextRemovalUndo).toBeUndefined();
  });

  it("is gone once a request is sent, and the marks stay", () => {
    const state = reduce([
      applyContextRemovals({
        marks: { a1: { toolResults: ["read"] } },
        removedTokens: 12_000,
      }),
      clearContextRemovalUndo(),
    ]);
    expect(state.contextRemovalUndo).toBeUndefined();
    const after = sessionSlice.reducer(state, undoContextRemovals());
    expect(after.history[1].removedByUser).toEqual({ toolResults: ["read"] });
  });

  it("does not follow the conversation into a new session", () => {
    const state = reduce([
      applyContextRemovals({ marks: { a1: { turn: true } }, removedTokens: 1 }),
      newSession(undefined),
    ]);
    expect(state.contextRemovalUndo).toBeUndefined();
  });
});
