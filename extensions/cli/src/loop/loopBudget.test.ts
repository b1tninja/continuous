import type { LoopState, TaskPlan } from "core/index.js";
import { loopTokensFromUsage } from "core/util/loopMode.js";
import {
  createLoop,
  startItemRun,
  startParallelRun,
} from "core/util/loopMode.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSession,
  getCurrentSession,
  getSessionLoop,
  trackSessionUsage,
  updateSessionLoop,
} from "../session.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
} from "../ui/__tests__/TUIChat.flowHarness.js";

import { stopLoopItemOverBudget, usageSince } from "./loopBudget.js";
import { sessionTokens } from "./loopSession.js";
import { recordWorkerUsage, resetLoopWaveDeps } from "./loopWave.js";

const NOW = new Date("2026-11-10T00:00:00Z");
const PLAN: TaskPlan = {
  items: [
    { id: "1", text: "Lexer", status: "pending", files: ["src/lexer.ts"] },
    { id: "2", text: "Parser", status: "pending", files: ["src/parser.ts"] },
  ],
  updatedAt: NOW.toISOString(),
};

function runningItem(budget: { maxTokens?: number; maxWallMs?: number } = {}) {
  const loop = startItemRun(
    createLoop(PLAN, {
      now: NOW,
      sessionTokens: 0,
      budget,
    }),
    "1",
    0,
    NOW,
  );
  updateSessionLoop(loop);
  return loop;
}

describe("loop budgets during an item", () => {
  beforeEach(async () => {
    await resetFlowState();
    resetLoopWaveDeps();
    await registerFlowServices({ llm: new ScriptedLlm([]), mode: "normal" });
    createSession([]);
  });

  afterEach(async () => {
    updateSessionLoop(undefined);
    resetLoopWaveDeps();
    await resetFlowState();
  });

  it("counts uncached input and output, not cached prompt tokens", () => {
    trackSessionUsage(0, {
      promptTokens: 1_000,
      completionTokens: 50,
      promptTokensDetails: { cachedTokens: 800 },
    });
    expect(sessionTokens()).toBe(
      loopTokensFromUsage(getCurrentSession().usage!),
    );
    expect(sessionTokens()).toBe(250);
    expect(sessionTokens()).not.toBe(1_050);
  });

  it("stops a running item once the token budget is spent, before the next request", () => {
    runningItem({ maxTokens: 100 });
    trackSessionUsage(0, {
      promptTokens: 80,
      completionTokens: 10,
      promptTokensDetails: { cachedTokens: 70 },
    });
    expect(sessionTokens()).toBe(20);
    expect(stopLoopItemOverBudget(NOW)).toBe(false);
    expect(getSessionLoop()?.status).toBe("running");

    trackSessionUsage(0, { promptTokens: 200, completionTokens: 5 });
    expect(stopLoopItemOverBudget(NOW)).toBe(true);
    expect(getSessionLoop()).toMatchObject({
      status: "stopped",
      stopReason: "tokens",
      stopBudget: { kind: "tokens", used: 225, max: expect.any(Number) },
    });
    expect(getSessionLoop()?.current).toBeUndefined();
  });

  it("stops a running item once the time budget is spent", () => {
    const loop = runningItem({ maxWallMs: 60_000 });
    expect(stopLoopItemOverBudget(NOW)).toBe(false);
    expect(stopLoopItemOverBudget(new Date(NOW.getTime() + 60_000))).toBe(true);
    expect(getSessionLoop()?.stopReason).toBe("time");
    expect(getSessionLoop()?.stopBudget).toEqual({
      kind: "time",
      used: 60_000,
      max: 60_000,
    });
    expect(loop.budget.maxWallMs).toBe(60_000);
  });

  it("does not stop between items; decideNext checks the budget there", () => {
    const loop = runningItem({ maxTokens: 10 });
    updateSessionLoop({ ...getSessionLoop()!, current: undefined });
    trackSessionUsage(0, { promptTokens: 50, completionTokens: 0 });
    expect(stopLoopItemOverBudget(NOW)).toBe(false);
    expect(getSessionLoop()?.status).toBe("running");
    expect(loop.current?.kind).toBe("item");
  });

  it("adds worker usage as it is reported, subtracting cache, and stops the wave", () => {
    // maxWallMs 0: this test is about tokens. The worker check uses the real
    // clock, and a loop started at NOW is already past the default time budget.
    let loop: LoopState = createLoop(PLAN, {
      now: new Date(),
      sessionTokens: 0,
      budget: { maxTokens: 100, maxWallMs: 0 },
    });
    loop = startParallelRun(loop, "1", NOW);
    loop = startParallelRun(loop, "2", NOW);
    updateSessionLoop(loop);

    expect(
      recordWorkerUsage("1", {
        promptTokens: 40,
        completionTokens: 10,
        promptTokensDetails: { cachedTokens: 30 },
      }),
    ).toBe(true);
    expect(sessionTokens()).toBe(20);
    expect(getSessionLoop()?.status).toBe("running");

    // The same report again adds nothing.
    recordWorkerUsage("1", {
      promptTokens: 40,
      completionTokens: 10,
      promptTokensDetails: { cachedTokens: 30 },
    });
    expect(sessionTokens()).toBe(20);

    expect(
      recordWorkerUsage("2", { promptTokens: 200, completionTokens: 0 }),
    ).toBe(false);
    expect(sessionTokens()).toBe(220);
    expect(getSessionLoop()).toMatchObject({
      status: "stopped",
      stopReason: "tokens",
    });
  });

  it("usageSince is the worker's own tokens, cache included", () => {
    expect(
      usageSince(
        {
          promptTokens: 100,
          completionTokens: 5,
          promptTokensDetails: { cachedTokens: 80, cacheWriteTokens: 10 },
        },
        {
          promptTokens: 1_100,
          completionTokens: 25,
          promptTokensDetails: { cachedTokens: 980, cacheWriteTokens: 10 },
        },
      ),
    ).toEqual({
      promptTokens: 1_000,
      completionTokens: 20,
      promptTokensDetails: { cachedTokens: 900 },
    });
    expect(
      loopTokensFromUsage(
        usageSince(
          { promptTokens: 0, completionTokens: 0 },
          {
            promptTokens: 1_000,
            completionTokens: 20,
            promptTokensDetails: { cachedTokens: 900 },
          },
        ),
      ),
    ).toBe(120);
  });
});
