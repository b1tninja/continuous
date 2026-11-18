import type { LoopState, TaskPlan } from "core";
import { createLoop, enterWait } from "core/util/loopMode";
import { loopUsage } from "core/util/loopUsage";
import { describe, expect, it } from "vitest";
import { loopStripModel } from "./loopStrip";

const PLAN = {
  items: [
    { id: "1", text: "Reproduce the failure", status: "done" },
    { id: "2", text: "Merge the defaults", status: "in_progress" },
    { id: "3", text: "Run the suite", status: "pending" },
  ],
  updatedAt: "2026-11-10T10:00:00Z",
} as TaskPlan;

function model(loop: LoopState, now = new Date()) {
  return loopStripModel(loop, PLAN, loopUsage(loop, { sessionTokens: 0, now }));
}

function fresh(): LoopState {
  const now = new Date("2026-11-10T10:00:00Z");
  return createLoop(PLAN, { now, sessionTokens: 0, autonomy: "auto" });
}

describe("loopStripModel", () => {
  it("counts the items and names the round and budgets", () => {
    const loop = fresh();
    const m = model(loop, new Date("2026-11-10T10:30:00Z"));
    expect(m.total).toBe(3);
    expect(m.round).toBe(1);
    expect(m.maxRounds).toBe(loop.budget.maxRounds);
    expect(m.time).toMatch(/left$/);
    expect(m.tokens).toMatch(/left$/);
  });

  it("says Running with what runs now", () => {
    const loop = {
      ...fresh(),
      status: "running",
      current: {
        kind: "item",
        itemId: "2",
        historyIndex: 0,
        startedAt: "2026-11-10T10:01:00Z",
      },
    } as LoopState;
    const m = model(loop);
    expect(m.state).toBe("running");
    expect(m.word).toBe("Running");
    expect(m.now).toBe("Merge the defaults");
  });

  it("says what a wait is for", () => {
    const waiting = enterWait(fresh(), new Date());
    expect(model(waiting).word).toBe("Waiting for your answer");
    expect(model({ ...waiting, status: "awaiting_plan" }).word).toBe(
      "Plan waiting for you",
    );
  });

  it("names the failed item while its repair runs", () => {
    const base = fresh();
    const loop = {
      ...base,
      status: "replanning",
      items: base.items.map((i) =>
        i.id === "2" ? { ...i, status: "failed" } : i,
      ),
      current: {
        kind: "replan",
        itemId: "2",
        historyIndex: 0,
        startedAt: "2026-11-10T10:01:00Z",
      },
    } as LoopState;
    const m = model(loop);
    expect(m.state).toBe("failed");
    expect(m.word).toBe("Item 2 failed");
    expect(m.now).toBe("repairing item 2 (Merge the defaults)");
  });

  it("says Done when finished, Paused when the loop was left, else Stopped", () => {
    const stopped = { ...fresh(), status: "stopped" } as LoopState;
    expect(model({ ...stopped, stopReason: "done" }).word).toBe("Done");
    expect(model({ ...stopped, stopReason: "left_loop" }).word).toBe("Paused");
    expect(model({ ...stopped, stopReason: "stopped" }).word).toBe("Stopped");
  });

  it("has nothing running when nothing runs", () => {
    expect(model(fresh()).now).toBeUndefined();
  });
});
