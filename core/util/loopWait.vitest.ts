import { describe, expect, it } from "vitest";
import type { LoopState, TaskPlan } from "..";
import {
  acceptReplan,
  createLoop,
  decideNext,
  endReplan,
  enterWait,
  loopBudgetStop,
  loopElapsedMs,
  proceedUnanswered,
  resumeLoop,
  startReplan,
  stopLoop,
} from "./loopMode";
import { loopUsage } from "./loopUsage";

const T0 = new Date("2026-11-12T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const plan: TaskPlan = {
  items: [
    { id: "1", text: "A", status: "pending" },
    { id: "2", text: "B", status: "pending" },
  ],
  updatedAt: T0.toISOString(),
};
const loopOn = (budget = {}): LoopState =>
  createLoop(plan, { now: T0, sessionTokens: 1_000, budget });

describe("time the loop waits on the person", () => {
  it("is left out of the time budget: 40 minutes of waiting against 60 keeps 40", () => {
    let loop = loopOn({ maxWallMs: 60 * 60_000, maxTokens: 0 });
    // 10 minutes of work, then 40 waiting for an answer, then it goes on
    loop = enterWait(loop, at(10));
    expect(loopElapsedMs(loop, at(50))).toBe(10 * 60_000);
    loop = proceedUnanswered(loop, at(50));
    expect(loop.waitingSince).toBeUndefined();
    expect(loop.waitedMs).toBe(40 * 60_000);
    // At minute 70 the clock says 70, the loop has worked 30
    expect(loopElapsedMs(loop, at(70))).toBe(30 * 60_000);
    expect(loopBudgetStop(loop, { now: at(70), sessionTokens: 1_000 })).toBe(
      undefined,
    );
    const stop = loopBudgetStop(loop, { now: at(100), sessionTokens: 1_000 });
    expect(stop?.reason).toBe("time");
    expect(stop?.detail).toBe(
      "The loop ran for 60 minutes of work (100 minutes including waiting for you); its budget is 60.",
    );
  });

  it("does not count a wait that is still going on, and the usage agrees", () => {
    let loop = loopOn({ maxWallMs: 60 * 60_000, maxTokens: 0 });
    loop = enterWait(loop, at(20));
    const ctx = { now: at(200), sessionTokens: 1_000 };
    expect(loopBudgetStop(loop, ctx)).toBeUndefined();
    const usage = loopUsage(loop, ctx);
    expect(usage.time.used).toBe(20 * 60_000);
    expect(usage.time.left).toBe(40 * 60_000);
    // decideNext does not stop a loop that only waited
    expect(decideNext(loop, plan, ctx).kind).not.toBe("stop");
  });

  it("adds up several waits", () => {
    let loop = loopOn();
    loop = proceedUnanswered(enterWait(loop, at(5)), at(15));
    loop = proceedUnanswered(enterWait(loop, at(25)), at(40));
    expect(loop.waitedMs).toBe(25 * 60_000);
    expect(loopElapsedMs(loop, at(60))).toBe(35 * 60_000);
  });

  it("leaves out the time a re-plan's card waits for the person", () => {
    const base = loopOn();
    const started = startReplan(base, 0, at(0), { plan });
    const ended = endReplan(started, plan, at(5));
    expect(ended.loop.status).toBe("awaiting_plan");
    expect(loopElapsedMs(ended.loop, at(65))).toBe(5 * 60_000);
    const accepted = acceptReplan(ended.loop, plan, {
      now: at(65),
      sessionTokens: 1_000,
    });
    expect(accepted.status).toBe("running");
    expect(accepted.waitingSince).toBeUndefined();
    expect(accepted.waitedMs).toBe(60 * 60_000);
  });

  it("a resumed loop starts its clock again, with nothing waited", () => {
    let loop = proceedUnanswered(enterWait(loopOn(), at(5)), at(15));
    loop = stopLoop(loop, "stopped", "You stopped the loop.");
    const resumed = resumeLoop(loop, { now: at(30), sessionTokens: 1_000 });
    expect(resumed.waitedMs).toBeUndefined();
    expect(loopElapsedMs(resumed, at(40))).toBe(10 * 60_000);
  });

  it("a loop that never waited behaves as before", () => {
    const loop = loopOn({ maxWallMs: 60 * 60_000, maxTokens: 0 });
    expect(loop.waitedMs).toBeUndefined();
    expect(loopElapsedMs(loop, at(59))).toBe(59 * 60_000);
    const stop = loopBudgetStop(loop, { now: at(60), sessionTokens: 1_000 });
    expect(stop?.detail).toBe("The loop ran for 60 minutes; its budget is 60.");
  });

  it("loads a loop saved before waitedMs existed as having waited 0", () => {
    const {
      waitedMs: _w,
      stopBudget: _s,
      ...old
    } = loopOn({
      maxWallMs: 10 * 60_000,
    });
    const saved: LoopState = JSON.parse(JSON.stringify(old));
    expect("waitedMs" in saved).toBe(false);
    expect(loopElapsedMs(saved, at(9))).toBe(9 * 60_000);
    expect(
      loopBudgetStop(saved, { now: at(10), sessionTokens: 1_000 })?.reason,
    ).toBe("time");
  });
});

describe("stopBudget", () => {
  it("names the token budget that stopped the loop", () => {
    const loop = loopOn({ maxTokens: 500, maxWallMs: 0 });
    const stop = loopBudgetStop(loop, { now: at(1), sessionTokens: 1_600 });
    expect(stop?.budget).toEqual({ kind: "tokens", used: 600, max: 500 });
    const action = decideNext(loop, plan, { now: at(1), sessionTokens: 1_600 });
    expect(action).toMatchObject({
      kind: "stop",
      reason: "tokens",
      budget: { kind: "tokens", used: 600, max: 500 },
    });
    const stopped = stopLoop(loop, stop!.reason, stop!.detail, stop!.budget);
    expect(stopped.stopBudget).toEqual({ kind: "tokens", used: 600, max: 500 });
    expect(stopped.stopDetail).toBe(stop!.detail);
  });

  it("names the time budget, in milliseconds of work", () => {
    let loop = loopOn({ maxTokens: 0, maxWallMs: 30 * 60_000 });
    loop = proceedUnanswered(enterWait(loop, at(0)), at(60));
    const stop = loopBudgetStop(loop, { now: at(90), sessionTokens: 1_000 });
    expect(stop?.budget).toEqual({
      kind: "time",
      used: 30 * 60_000,
      max: 30 * 60_000,
    });
  });

  it("is absent for a stop that is not a budget, and cleared on resume", () => {
    const loop = loopOn({ maxTokens: 500, maxWallMs: 0 });
    const plain = stopLoop(loop, "stopped", "You stopped the loop.");
    expect(plain.stopBudget).toBeUndefined();
    const budgeted = stopLoop(loop, "tokens", "spent", {
      kind: "tokens",
      used: 600,
      max: 500,
    });
    const resumed = resumeLoop(budgeted, { now: at(2), sessionTokens: 9_000 });
    expect(resumed.stopBudget).toBeUndefined();
  });
});
