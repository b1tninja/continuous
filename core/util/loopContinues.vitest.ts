import { describe, expect, test } from "vitest";

import type { LoopPolicy, LoopState, TaskPlan } from "../index.js";

import { autoAnswerFor, NO_ONE_AVAILABLE } from "./autoAnswer.js";
import {
  acceptReplan,
  createLoop,
  decideNext,
  endReplan,
  holdQuestion,
  holdQuestionResult,
  startItemRun,
  startReplan,
} from "./loopMode.js";

const T0 = new Date("2026-11-08T10:00:00Z");
const ctx = { now: T0, sessionTokens: 0 };

function planOf(...items: { id: string; text: string; check?: string }[]) {
  return {
    items: items.map((item) => ({ status: "pending" as const, ...item })),
    updatedAt: T0.toISOString(),
  } as TaskPlan;
}

const PLAN = planOf(
  { id: "1", text: "A", check: "node a" },
  { id: "2", text: "B", check: "node b" },
);
// The re-plan replaces the check of item 1, which ended stuck without running it
const REPLANNED = planOf(
  { id: "1", text: "A", check: "node --check a" },
  { id: "2", text: "B", check: "node b" },
  { id: "3", text: "C" },
);

/** A loop in a re-plan after item 1 ended stuck */
function replanning(policy: Partial<LoopPolicy>): LoopState {
  const base = createLoop(PLAN, {
    now: T0,
    sessionTokens: 0,
    policy: { plan: "cautious", questions: "cautious", ...policy },
  });
  const stuck: LoopState = {
    ...base,
    items: base.items.map((i) =>
      i.id === "1" ? { ...i, status: "failed" as const } : i,
    ),
  };
  return startReplan(stuck, 0, T0, { plan: PLAN });
}

describe("Plan edits: a re-plan goes on without a card when the person opted out", () => {
  for (const level of ["automatic", "permissive", "idgaf"] as const) {
    test(`${level}: accepted, noted, and the next round starts`, () => {
      const ended = endReplan(replanning({ plan: level }), REPLANNED);
      expect(ended.accept).toBe(true);
      const note = ended.loop.autoDecisions?.at(-1);
      expect(note).toMatchObject({ kind: "plan", by: "system" });
      expect(note?.source).toBe(
        `Plan edits: ${level === "idgaf" ? "IDGAF" : level[0].toUpperCase() + level.slice(1)}`,
      );
      expect(note?.text).toBe(
        "Plan updated: 2 kept, 1 added, 0 dropped; check of item 1 replaced",
      );
      const next = acceptReplan(ended.loop, REPLANNED, ctx);
      expect(next.status).toBe("running");
      expect(decideNext(next, REPLANNED, ctx).kind).toBe("run");
    });
  }

  for (const level of ["manual", "cautious"] as const) {
    test(`${level}: the plan card still waits`, () => {
      const ended = endReplan(replanning({ plan: level }), REPLANNED);
      expect(ended.accept).toBe(false);
      expect(ended.loop.status).toBe("awaiting_plan");
      expect(ended.loop.replanReason).toContain("ended stuck");
      expect(ended.loop.autoDecisions).toBeUndefined();
    });
  }

  test("Permissive still holds a re-plan that adds more than its cap", () => {
    const many = planOf(
      { id: "1", text: "A" },
      { id: "2", text: "B" },
      ...["x", "y", "z", "u", "v", "w"].map((t, i) => ({
        id: String(i + 3),
        text: t,
      })),
    );
    const ended = endReplan(
      replanning({ plan: "permissive", maxNewPlanItems: 2 }),
      many,
    );
    expect(ended.accept).toBe(false);
  });
});

describe("Questions: a permissive level answers by itself", () => {
  const running = (policy: Partial<LoopPolicy>) =>
    startItemRun(
      createLoop(PLAN, {
        now: T0,
        sessionTokens: 0,
        policy: { plan: "cautious", questions: "cautious", ...policy },
      }),
      "1",
      0,
      T0,
    );
  const ask = (loop: LoopState, extra: Record<string, unknown> = {}) => {
    const held = holdQuestion(
      loop,
      {
        itemId: "1",
        question: "Drop the old table?",
        kind: "blocking",
        type: "irreversible",
        ...extra,
      },
      T0,
    );
    if (!held.ok) throw new Error(held.error);
    return held;
  };

  for (const level of ["automatic", "permissive", "idgaf"] as const) {
    test(`${level}: the recommended option is chosen, by system, even for irreversible`, () => {
      const held = ask(running({ questions: level }), {
        options: ["Keep it", "Drop it (recommended)", "Archive it"],
      });
      expect(held.question.answerId).toBe("self");
      expect(held.question.autoAnswer).toMatchObject({
        text: "Drop it",
        by: "system",
      });
      expect(held.question.autoAnswer?.source).toBe(
        `Questions: ${level === "idgaf" ? "IDGAF" : level[0].toUpperCase() + level.slice(1)}`,
      );
      expect(held.loop.autoDecisions?.at(-1)).toMatchObject({
        kind: "question",
        by: "system",
        text: "Auto-answered: Drop the old table? -> Drop it",
      });
      expect(holdQuestionResult(held.question, false)).toContain("Drop it");
    });
  }

  test("without a label the first option is chosen", () => {
    const held = ask(running({ questions: "permissive" }), {
      options: ["Keep it", "Drop it"],
    });
    expect(held.question.autoAnswer?.text).toBe("Keep it");
  });

  test("without options the agent is told to use its best judgment", () => {
    const held = ask(running({ questions: "permissive" }));
    expect(held.question.autoAnswer?.text).toBe(NO_ONE_AVAILABLE);
    expect(holdQuestionResult(held.question, false)).toContain(
      "No one is available to answer; use your best judgment and state the assumption",
    );
  });

  for (const level of ["manual", "cautious"] as const) {
    test(`${level}: an irreversible question still waits for the person`, () => {
      const held = ask(running({ questions: level }), {
        options: ["Keep it", "Drop it (recommended)"],
      });
      expect(held.question.answerId).toBeUndefined();
      expect(held.question.autoAnswer).toBeUndefined();
      expect(held.loop.autoDecisions).toBeUndefined();
    });
  }

  test("a type on your own you-decide list still asks at Permissive", () => {
    const held = ask(
      running({ questions: "permissive", youDecide: ["irreversible"] }),
      { options: ["Keep it", "Drop it"] },
    );
    expect(held.question.answerId).toBeUndefined();
  });

  test("a call the engine held for approval is never answered; at IDGAF nobody is asked, so it is refused", () => {
    const held = ask(running({ questions: "permissive" }), {
      kind: "approval",
    });
    expect(held.question.answerId).toBeUndefined();
    expect(held.question.autoAnswer).toBeUndefined();
    const refused = ask(running({ questions: "idgaf" }), { kind: "approval" });
    expect(refused.question.autoAnswer?.text).toMatch(/^Refused/);
  });
});

describe("autoAnswerFor", () => {
  test("the label is not part of the answer", () => {
    expect(autoAnswerFor(["a", " b (Recommended) "])).toEqual({
      text: "b",
      basis: "recommended",
    });
  });
  test("a plan decision's pick stands in for the label", () => {
    expect(autoAnswerFor(["a", "b"], "b").text).toBe("b");
  });
});
