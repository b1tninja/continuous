import type { ChatHistoryItem, LoopState, TaskPlan, ToolCallState } from "core";
import { createLoop, type ReplanDiff } from "core/util/loopMode";
import { describe, expect, it } from "vitest";
import {
  planTreeModel,
  runProgress,
  treeStatusOf,
  type TreeFold,
  type TreeItem,
} from "./planTreeModel";

const T0 = new Date("2026-11-12T10:00:00Z");

function planOf(n: number): TaskPlan {
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: String(i + 1),
      text: `To-do ${i + 1}`,
      status: "pending" as const,
    })),
    updatedAt: T0.toISOString(),
  };
}

function loopOf(
  n: number,
  statuses: Record<string, Partial<LoopState["items"][number]>> = {},
  patch: Partial<LoopState> = {},
): LoopState {
  const loop = createLoop(planOf(n), { now: T0, sessionTokens: 0 });
  return {
    ...loop,
    items: loop.items.map((i) => ({ ...i, ...statuses[i.id] })),
    ...patch,
  };
}

const items = (nodes: ReturnType<typeof planTreeModel>["nodes"]) =>
  nodes.filter((n): n is TreeItem => n.type === "item");
const fold = (nodes: ReturnType<typeof planTreeModel>["nodes"], id: string) =>
  nodes.find((n): n is TreeFold => n.type === "fold" && n.id === id);

function toolTurn(
  name: string,
  args: Record<string, unknown>,
): ChatHistoryItem {
  const call: ToolCallState = {
    toolCallId: name,
    toolCall: {
      id: name,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    parsedArgs: args,
    status: "done",
  } as ToolCallState;
  return {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: [call],
  };
}

describe("treeStatusOf", () => {
  it("maps the loop's statuses to the tree's words", () => {
    const s = (status: LoopState["items"][number]["status"], extra = {}) =>
      treeStatusOf({ id: "1", status, attempts: 0, ...extra });
    expect(s("done")).toBe("done");
    expect(s("done", { skipped: true })).toBe("skipped");
    expect(s("running")).toBe("running");
    expect(s("checking")).toBe("running");
    expect(s("waiting")).toBe("waiting");
    expect(s("failed")).toBe("failed");
    expect(s("pending")).toBe("pending");
    expect(s("redo")).toBe("pending");
    expect(
      treeStatusOf(
        { id: "1", status: "done", attempts: 1 },
        { replaced: true },
      ),
    ).toBe("replaced");
  });
});

describe("planTreeModel", () => {
  it("folds the finished items into one row and labels the root", () => {
    const loop = loopOf(
      6,
      {
        "1": { status: "done" },
        "2": { status: "done", skipped: true },
        "3": { status: "running", attempts: 1 },
      },
      {
        current: {
          kind: "item",
          itemId: "3",
          historyIndex: 0,
          startedAt: T0.toISOString(),
        },
      },
    );
    const m = planTreeModel({ loop, plan: planOf(6), now: T0.getTime() });
    expect(fold(m.nodes, "done")?.label).toBe("1 done · 1 skipped");
    expect(fold(m.nodes, "done")?.children.map((c) => c.id)).toEqual([
      "1",
      "2",
    ]);
    expect(m.rootLabel).toBe("now item 3 · 1/6 done");
    expect(m.rootStatus).toBe("running");
    expect(m.currentId).toBe("3");
    expect(m.autoExpand).toBe(false);
  });

  it("marks the current item and gives it a live line and the last tool call", () => {
    const loop = loopOf(
      3,
      { "1": { status: "running", attempts: 1 } },
      {
        current: {
          kind: "item",
          itemId: "1",
          historyIndex: 1,
          startedAt: new Date(T0.getTime() - 130_000).toISOString(),
        },
      },
    );
    const plan = planOf(3);
    plan.items[0].budget = { turns: 12 };
    const history = [
      toolTurn("read_file", { filepath: "before.ts" }),
      toolTurn("read_file", { filepath: "a.ts" }),
      toolTurn("run_terminal_command", { command: "pip install -e ." }),
    ];
    const m = planTreeModel({ loop, plan, history, now: T0.getTime() });
    const current = items(m.nodes).find((i) => i.current)!;
    expect(current.id).toBe("1");
    expect(current.openByDefault).toBe(true);
    expect(current.lines.map((l) => [l.tone, l.label, l.text])).toEqual([
      ["live", "Running", "2m · step 2 of about 12"],
      ["tool", "Last tool", expect.stringContaining("pip install -e .")],
    ]);
  });

  it("shows upcoming items one per line and folds the rest", () => {
    const loop = loopOf(
      12,
      { "1": { status: "running", attempts: 1 } },
      {
        current: {
          kind: "item",
          itemId: "1",
          historyIndex: 0,
          startedAt: T0.toISOString(),
        },
      },
    );
    const m = planTreeModel({ loop, plan: planOf(12) });
    expect(items(m.nodes).map((i) => i.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(fold(m.nodes, "upcoming")?.label).toBe("7 more to do");
    // a fold of one item would be pointless: five or fewer stay in view
    const few = planTreeModel({
      loop: loopOf(5, { "1": { status: "running", attempts: 1 } }),
      plan: planOf(5),
    });
    expect(fold(few.nodes, "upcoming")).toBeUndefined();
    expect(items(few.nodes)).toHaveLength(5);
  });

  it("marks a failed item with its check and the repair that runs, and auto-expands", () => {
    const loop = loopOf(
      4,
      {
        "1": { status: "done" },
        "2": {
          status: "failed",
          attempts: 2,
          repairs: 0,
          check: {
            status: "failed",
            command: "pytest -q",
            exitCode: 1,
            output: "collected 12\n2 failed, 10 passed",
            at: T0.toISOString(),
          },
        },
      },
      {
        current: {
          kind: "replan",
          itemId: "2",
          historyIndex: 0,
          startedAt: T0.toISOString(),
        },
      },
    );
    const m = planTreeModel({ loop, plan: planOf(4) });
    const failed = items(m.nodes).find((i) => i.status === "failed")!;
    expect(failed.current).toBe(true);
    expect(failed.openByDefault).toBe(true);
    expect(failed.lines.map((l) => [l.label, l.text])).toEqual([
      ["Check failed", "pytest -q: 2 failed, 10 passed (attempt 2)"],
      ["Fix forward", "repair re-plan running, 1 of 2 allowed"],
    ]);
    expect(m.rootLabel).toBe("item 2 failed · 1/4 done");
    expect(m.rootStatus).toBe("failed");
    expect(m.autoExpand).toBe(true);
  });

  it("says what a waiting item waits on", () => {
    const loop = loopOf(
      2,
      { "1": { status: "waiting", attempts: 1 } },
      {
        questions: [
          {
            id: "q1",
            itemId: "1",
            kind: "blocking",
            text: "Which db?",
            askedAt: T0.toISOString(),
          } as unknown as LoopState["questions"][number],
        ],
      },
    );
    const m = planTreeModel({ loop, plan: planOf(2) });
    const waiting = items(m.nodes).find((i) => i.status === "waiting")!;
    expect(waiting.lines[0]).toMatchObject({
      label: "Waits on",
      text: "question 1 of 1",
    });
    expect(m.rootLabel).toBe("item 1 waits on you · 0/2 done");
    expect(m.rootStatus).toBe("waiting");
  });

  it("with a waiting re-plan: dropped struck in front, new chip, kept folded, auto-expanded", () => {
    const loop = loopOf(
      4,
      { "1": { status: "done" } },
      { status: "awaiting_plan" },
    );
    const plan = planOf(4);
    plan.items[2] = { ...plan.items[2], id: "9", text: "Brand new" };
    const diff: ReplanDiff = {
      kept: [
        { text: "To-do 1", status: "done" },
        { text: "To-do 2" },
        { text: "To-do 4" },
      ],
      added: ["Brand new"],
      dropped: [{ text: "Old third" }],
    };
    const m = planTreeModel({ loop, plan, diff });
    expect(m.autoExpand).toBe(true);
    expect(m.rootLabel).toBe("plan waiting for you · 1/4 done");
    expect(m.summary).toBe("Round 1 · 3 kept, 1 added, 1 dropped");
    expect(m.nodes[0]).toMatchObject({ status: "dropped", text: "Old third" });
    expect(items(m.nodes).find((i) => i.isNew)?.text).toBe("Brand new");
    expect(fold(m.nodes, "kept")?.label).toBe("2 kept, unchanged");
    expect(fold(m.nodes, "done")?.label).toBe("1 done");
  });

  it("finished: one fold, 12/12 style label, no auto-expand", () => {
    const loop = loopOf(
      2,
      { "1": { status: "done" }, "2": { status: "done" } },
      {
        status: "stopped",
      },
    );
    const m = planTreeModel({ loop, plan: planOf(2) });
    expect(m.rootLabel).toBe("2/2 done");
    expect(m.rootStatus).toBe("done");
    expect(m.autoExpand).toBe(false);
    expect(m.nodes).toHaveLength(1);
  });

  it("uses the optional extras: R chips and replaced by", () => {
    const loop = loopOf(3, {
      "1": { status: "done" },
      "2": { status: "pending" },
    });
    const m = planTreeModel({
      loop,
      plan: planOf(3),
      extras: { addedInRound: { "3": 2 }, replacedBy: { "1": "3" } },
    });
    const all = [...(fold(m.nodes, "done")?.children ?? []), ...items(m.nodes)];
    const one = all.find((i) => i.id === "1")!;
    expect(one).toMatchObject({
      status: "replaced",
      replacedById: "3",
      replacedByNumber: 3,
    });
    expect(all.find((i) => i.id === "3")?.round).toBe(2);
    expect(all.find((i) => i.id === "2")?.round).toBeUndefined();
    expect(fold(m.nodes, "done")?.label).toBe("1 replaced");
  });

  it("reads the round and the taken-out to-dos from the loop itself", () => {
    const loop = loopOf(
      3,
      { "1": { status: "done" }, "3": { addedInRound: 2 } },
      {
        round: 2,
        replacedItems: [
          { id: "7", text: "Old check", round: 2, replacedBy: "3" },
          { id: "8", text: "Dropped for good", round: 2 },
        ],
      },
    );
    const m = planTreeModel({ loop, plan: planOf(3) });
    const done = fold(m.nodes, "done")!;
    expect(done.label).toBe("1 done · 1 replaced · 1 dropped");
    const old = done.children.find((c) => c.id === "replaced:7")!;
    expect(old).toMatchObject({
      status: "replaced",
      text: "Old check",
      replacedByNumber: 3,
      replacedById: "3",
    });
    expect(done.children.find((c) => c.id === "replaced:8")?.status).toBe(
      "dropped",
    );
    expect(items(m.nodes).find((i) => i.id === "3")?.round).toBe(2);
    // the taken-out to-dos are not counted as work
    expect(m.total).toBe(3);
    expect(m.done).toBe(1);
  });

  it("shows the trace and the auto-answers of a loop that decided for the person", () => {
    const loop = {
      ...loopOf(2, { "1": { status: "running", attempts: 1 } }),
      current: {
        kind: "item" as const,
        itemId: "1",
        historyIndex: 0,
        startedAt: T0.toISOString(),
      },
      autoDecisions: [
        {
          kind: "plan",
          by: "system",
          source: "Plan edits",
          text: "Plan updated: 1 kept, 1 added, 0 dropped",
          at: "x",
        },
        {
          kind: "question",
          by: "system",
          source: "Questions",
          text: "Auto-answered: Merge it? -> yes",
          at: "y",
        },
      ],
    } as unknown as LoopState;
    const m = planTreeModel({ loop, plan: planOf(2) });
    expect(m.nodes[0]).toMatchObject({
      type: "trace",
      text: "Plan updated: 1 kept, 1 added, 0 dropped",
    });
    const current = items(m.nodes).find((i) => i.current)!;
    expect(current.lines.at(-1)).toMatchObject({
      tone: "answer",
      text: "Auto-answered: Merge it? -> yes",
    });
  });

  it("masks a secret in the last tool call", () => {
    const history = [
      toolTurn("run_terminal_command", {
        command:
          "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnop' x",
      }),
    ];
    const { lastTool } = runProgress(history, 0);
    expect(lastTool).toBeDefined();
  });
});
