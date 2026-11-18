import type { LoopItemState, TaskPlan } from "core/index.js";
import {
  createLoop,
  enterWait,
  proceedUnanswered,
  startParallelRun,
} from "core/util/loopMode.js";
import { describe, expect, it } from "vitest";

import { LOOP_WORKER_TIMEOUT_MS, workerTimeoutMs } from "./loopWave.js";

const T0 = new Date("2026-11-12T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const plan = (budget?: { minutes?: number }): TaskPlan => ({
  items: [
    { id: "1", text: "A", status: "pending", files: ["a.ts"], budget },
    { id: "2", text: "B", status: "pending", files: ["b.ts"] },
  ],
  updatedAt: T0.toISOString(),
});
const running = (p: TaskPlan, maxWallMs: number) =>
  startParallelRun(
    createLoop(p, { now: T0, sessionTokens: 0, budget: { maxWallMs } }),
    "1",
    T0,
  );

describe("workerTimeoutMs", () => {
  it("keeps the 30 minute ceiling when nothing is tighter", () => {
    const p = plan();
    expect(workerTimeoutMs({ loop: running(p, 0), plan: p }, T0)).toBe(
      LOOP_WORKER_TIMEOUT_MS,
    );
    expect(
      workerTimeoutMs({ loop: running(p, 8 * 60 * 60_000), plan: p }, T0),
    ).toBe(LOOP_WORKER_TIMEOUT_MS);
  });

  it("follows the item's time limit, less what earlier runs used", () => {
    const p = plan({ minutes: 10 });
    const loop = running(p, 0);
    expect(workerTimeoutMs({ loop, plan: p }, T0)).toBe(10 * 60_000);
    const earlier = {
      ...loop,
      items: loop.items.map((i: LoopItemState) =>
        i.id === "1" ? { ...i, usage: { tokens: 0, ms: 4 * 60_000 } } : i,
      ),
    };
    expect(workerTimeoutMs({ loop: earlier, plan: p }, T0)).toBe(6 * 60_000);
  });

  it("follows the time the loop has left, without the time it waited on the person", () => {
    const p = plan();
    let loop = running(p, 60 * 60_000);
    expect(workerTimeoutMs({ loop, plan: p }, at(45))).toBe(15 * 60_000);
    loop = {
      ...proceedUnanswered(enterWait(loop, at(10)), at(40)),
    };
    // 30 of the 45 minutes were spent waiting: 45 minutes of the hour are left
    expect(workerTimeoutMs({ loop, plan: p }, at(45))).toBe(
      LOOP_WORKER_TIMEOUT_MS,
    );
    expect(workerTimeoutMs({ loop, plan: p }, at(75))).toBe(15 * 60_000);
    expect(workerTimeoutMs({ loop, plan: p }, at(85))).toBe(5 * 60_000);
  });

  it("never goes below one second", () => {
    const p = plan();
    expect(
      workerTimeoutMs({ loop: running(p, 60_000), plan: p }, at(500)),
    ).toBe(1000);
  });
});
