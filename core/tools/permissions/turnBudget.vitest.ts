import { describe, expect, it } from "vitest";
import {
  ALLOW_PROPOSAL_MAX_SECONDS,
  propose,
  type PolicyFact,
  type TimerContext,
} from "./decisionTimer";
import {
  createTurnBudget,
  isWindow,
  SMALLEST_WINDOW,
  TURN_BUDGET_SECONDS,
} from "./turnBudget";

const ALLOW: PolicyFact = {
  policy: "allowedWithoutPermission",
  source: "allow-rule",
};
const ASK: PolicyFact = {
  policy: "allowedWithPermission",
  source: "tool-setting",
};
const ctx = (seconds: 5 | 10 | 15 | 30): TimerContext => ({
  attended: true,
  level: "cautious",
  settings: { cautious: seconds },
  headsUp: { cautious: Math.min(seconds, 10) as never },
  now: 0,
});

describe("a proposal to run an allowed call is capped", () => {
  it("holds an allow for at most 10 s even if a larger window reaches it", () => {
    expect(ALLOW_PROPOSAL_MAX_SECONDS).toBe(10);
    // parseTimerSettings never lets one through; this is the second guard
    for (const wide of [15, 30, 600]) {
      const c = { ...ctx(30), headsUp: { cautious: wide as never } };
      expect(propose(ALLOW, c)?.seconds, String(wide)).toBe(10);
    }
    expect(propose(ALLOW, ctx(10))?.seconds).toBe(10);
  });

  it("keeps a shorter window as it is", () => {
    expect(propose(ALLOW, ctx(5))?.seconds).toBe(5);
  });

  it("does not cap an ask: it waits for the person anyway, and the window only ends the wait", () => {
    expect(propose(ASK, ctx(30))?.seconds).toBe(30);
    expect(propose(ASK, ctx(15))?.seconds).toBe(15);
  });
});

describe("the turn budget", () => {
  it("is 60 s for the 5 minute cache and 300 s for the 1 hour cache", () => {
    expect(TURN_BUDGET_SECONDS["5m"]).toBe(60);
    expect(TURN_BUDGET_SECONDS["1h"]).toBe(300);
  });

  it("grants the whole window while the budget lasts", () => {
    const b = createTurnBudget(60);
    expect(b.grant(30)).toBe(30);
    expect(b.remaining()).toBe(60);
  });

  it("grants what is left when that is at least the smallest window", () => {
    const b = createTurnBudget(60);
    b.spend(45);
    expect(b.grant(30)).toBe(15);
    b.spend(11);
    expect(b.remaining()).toBe(4);
  });

  it("grants nothing, so the ask waits as it does today, when less than 5 s is left", () => {
    const b = createTurnBudget(60);
    b.spend(56);
    expect(b.remaining()).toBe(4);
    expect(b.grant(30)).toBe(0);
    expect(SMALLEST_WINDOW).toBe(5);
  });

  it("grants exactly 5 s when exactly 5 s are left", () => {
    const b = createTurnBudget(60);
    b.spend(55);
    expect(b.grant(30)).toBe(5);
  });

  it("four asks of 30 s in one turn use two windows and then wait", () => {
    const b = createTurnBudget(60);
    const granted: number[] = [];
    for (let i = 0; i < 4; i++) {
      const g = b.grant(30);
      granted.push(g);
      b.spend(g); // each ran out unanswered
    }
    expect(granted).toEqual([30, 30, 0, 0]);
    expect(granted.reduce((a, c) => a + c, 0)).toBeLessThanOrEqual(60);
  });

  it("an answered ask spends only the time it held", () => {
    const b = createTurnBudget(60);
    b.spend(3);
    expect(b.remaining()).toBe(57);
    expect(b.grant(30)).toBe(30);
  });

  it("never goes below zero, and ignores a spend that is not positive", () => {
    const b = createTurnBudget(10);
    b.spend(500);
    expect(b.remaining()).toBe(0);
    const c = createTurnBudget(10);
    c.spend(-5);
    c.spend(0);
    c.spend(Number.NaN);
    expect(c.remaining()).toBe(10);
  });

  it("grants nothing for a request that is not a positive number of seconds", () => {
    const b = createTurnBudget(60);
    for (const wanted of [0, -1, Number.NaN]) {
      expect(b.grant(wanted), String(wanted)).toBe(0);
    }
  });

  it("a new request starts a new turn with the full budget", () => {
    const b = createTurnBudget(60);
    b.spend(60);
    expect(b.grant(10)).toBe(0);
    b.reset();
    expect(b.remaining()).toBe(60);
    expect(b.grant(10)).toBe(10);
  });

  it("a negative limit is an empty budget", () => {
    const b = createTurnBudget(-5);
    expect(b.remaining()).toBe(0);
    expect(b.grant(5)).toBe(0);
  });

  it("a granted remainder is a whole number of seconds", () => {
    const b = createTurnBudget(60);
    b.spend(52.5);
    expect(b.grant(30)).toBe(7);
  });
});

describe("isWindow", () => {
  it("is true for the windows a person can choose and nothing else", () => {
    for (const s of [5, 10, 15, 30]) expect(isWindow(s), String(s)).toBe(true);
    for (const s of [0, 1, 7, 45, 60, -5])
      expect(isWindow(s), String(s)).toBe(false);
  });
});
