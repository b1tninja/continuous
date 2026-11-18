import { describe, expect, it } from "vitest";
import {
  applyPlanBudgets,
  budgetAuthority,
  budgetFromInput,
  setupByItemId,
  computePlanBudgets,
  NO_PLAN_BUDGET,
  plannerBudgetsApply,
  proposeBudgets,
  totalsOf,
} from "./planBudget";
import { buildTaskPlan } from "./taskPlan";

const loopBudget = { maxTokens: 1_000_000, maxWallMs: 100 * 60_000 };
const items = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];

describe("budgetAuthority", () => {
  it.each([
    ["manual", "person", false],
    ["cautious", "planner", true],
    ["automatic", "reviewer", true],
    ["permissive", "planner", true],
    ["idgaf", "planner", true],
  ] as const)("%s: %s", (level, who, applies) => {
    expect(budgetAuthority(level)).toBe(who);
    expect(plannerBudgetsApply(level)).toBe(applies);
  });
});

describe("computePlanBudgets", () => {
  it("None leaves items without a number, which is what Skip leaves", () => {
    const r = computePlanBudgets(items, loopBudget, NO_PLAN_BUDGET, {
      plannerBudgets: true,
    });
    expect(Object.values(r.budgets).every((b) => !Object.keys(b).length)).toBe(
      true,
    );
    expect(r.reserve).toEqual({});
  });

  it("Equal with a reserve divides what the reserve leaves", () => {
    const r = computePlanBudgets(
      items,
      loopBudget,
      { strategy: "equal", reserve: 0.2 },
      { plannerBudgets: true },
    );
    expect(r.reserve).toEqual({ tokens: 200_000, minutes: 20 });
    expect(r.budgets["1"]).toEqual({ tokens: 200_000, minutes: 20 });
  });

  it("Weighted follows the sizes", () => {
    const r = computePlanBudgets(
      items,
      loopBudget,
      {
        strategy: "weighted",
        reserve: 0,
        sizes: { "1": "L", "2": "S", "3": "S", "4": "S" },
      },
      { plannerBudgets: true },
    );
    expect(r.budgets["1"].tokens).toBe(571_428);
    expect(r.budgets["2"].tokens).toBe(142_857);
  });

  it("the person's number beats the planner's line, which beats the split", () => {
    const withLines = [
      { id: "1", budget: { tokens: 50_000, turns: 12 } },
      { id: "2", budget: { tokens: 60_000 } },
      { id: "3" },
    ];
    const r = computePlanBudgets(
      withLines,
      loopBudget,
      {
        strategy: "equal",
        reserve: 0,
        overrides: { "2": { tokens: 70_000 } },
      },
      { plannerBudgets: true },
    );
    expect(r.budgets["1"]).toMatchObject({ tokens: 50_000, turns: 12 });
    expect(r.budgets["2"].tokens).toBe(70_000);
    // The third gets what the explicit ones left
    expect(r.budgets["3"].tokens).toBe(880_000);
  });

  it("at Manual the planner's lines do not apply until the person does", () => {
    const withLines = [{ id: "1", budget: { tokens: 50_000, turns: 12 } }];
    const r = computePlanBudgets(withLines, loopBudget, NO_PLAN_BUDGET, {
      plannerBudgets: false,
    });
    expect(r.budgets["1"]).toEqual({});
  });

  it("caps an item at what the loop has left, and says so", () => {
    const r = computePlanBudgets(
      [{ id: "1", budget: { tokens: 5_000_000 } }],
      loopBudget,
      NO_PLAN_BUDGET,
      { plannerBudgets: true },
    );
    expect(r.budgets["1"].tokens).toBe(1_000_000);
    expect(r.capped).toEqual({ "1": ["tokens"] });
  });

  it("a loop without a limit has nothing to divide", () => {
    expect(totalsOf({ maxTokens: 0, maxWallMs: 0 })).toEqual({});
    const r = computePlanBudgets(
      items,
      { maxTokens: 0, maxWallMs: 0 },
      { strategy: "equal", reserve: 0.2 },
      { plannerBudgets: true },
    );
    expect(r.budgets["1"]).toEqual({});
  });
});

describe("applyPlanBudgets", () => {
  it("writes budgets into the items and removes empty ones", () => {
    const built = buildTaskPlan(
      [{ text: "a", budget: "5 turns" }, { text: "b" }],
      {},
    );
    if (!built.ok) throw new Error(built.error);
    const plan = applyPlanBudgets(built.plan, {
      [built.plan.items[0].id]: {},
      [built.plan.items[1].id]: { tokens: 9 },
    });
    expect(plan.items[0].budget).toBeUndefined();
    expect(plan.items[1].budget).toEqual({ tokens: 9 });
  });
});

describe("budgetFromInput and setupByItemId", () => {
  it("reads a line or an object, and nothing else", () => {
    expect(budgetFromInput("25 turns, 50K tokens")).toEqual({
      turns: 25,
      tokens: 50_000,
    });
    expect(budgetFromInput({ minutes: 20, tokens: -1 })).toEqual({
      minutes: 20,
    });
    expect(budgetFromInput("lots")).toBeUndefined();
    expect(budgetFromInput(undefined)).toBeUndefined();
  });

  it("re-keys the card's positions by the task list's ids", () => {
    const setup = setupByItemId(
      {
        strategy: "weighted",
        reserve: 0.1,
        sizes: { "1": "L", "3": "S" },
        overrides: { "2": { tokens: 5 }, "9": { tokens: 1 } },
      },
      ["a", "b", "c"],
    );
    expect(setup.sizes).toEqual({ a: "L", c: "S" });
    expect(setup.overrides).toEqual({ b: { tokens: 5 } });
  });
});

describe("proposeBudgets", () => {
  it("says so when there is no history, and proposes nothing", () => {
    const p = proposeBudgets([{ id: "1" }], []);
    expect(p.budgets).toBeUndefined();
    expect(p.note).toMatch(/no history/i);
    expect(
      proposeBudgets([{ id: "1" }], [{ tokens: 0, ms: 0 }]).budgets,
    ).toBeUndefined();
  });

  it("takes the median of finished items, with headroom, scaled by size", () => {
    const p = proposeBudgets(
      [{ id: "1" }, { id: "2", size: "L" }, { id: "3", size: "S" }],
      [
        { tokens: 10_000, ms: 60_000 },
        { tokens: 30_000, ms: 180_000 },
        { tokens: 20_000, ms: 120_000 },
      ],
    );
    // Median 20K tokens and 2 min, twice over for a medium item
    expect(p.budgets?.["1"]).toEqual({ tokens: 40_000, minutes: 4 });
    expect(p.budgets?.["2"]).toEqual({ tokens: 80_000, minutes: 8 });
    expect(p.budgets?.["3"]).toEqual({ tokens: 20_000, minutes: 2 });
    expect(p.note).toContain("3 finished items");
  });
});
