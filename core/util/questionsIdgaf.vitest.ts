import { describe, expect, test } from "vitest";

import type { LoopPolicy, LoopState, TaskPlan } from "../index.js";

import { NO_ONE_AVAILABLE, answerWithoutAsking } from "./autoAnswer.js";
import { autoAnswerDecisions } from "./autoAnswerPlan.js";
import { overBudgetReport } from "./itemBudget.js";
import { applyLimitPolicy } from "./itemBudgetPolicy.js";
import {
  approvalHeldResult,
  createLoop,
  finishItemRun,
  holdQuestion,
  holdQuestionResult,
  setLoopPolicy,
  startItemRun,
} from "./loopMode.js";

const T0 = new Date("2026-11-12T10:00:00Z");
const PLAN = {
  items: [
    { id: "1", text: "A", status: "pending" as const },
    { id: "2", text: "B", status: "pending" as const },
  ],
  updatedAt: T0.toISOString(),
} as TaskPlan;

function loopAt(policy: Partial<LoopPolicy>): LoopState {
  const base = createLoop(PLAN, {
    now: T0,
    sessionTokens: 0,
    policy: { plan: "cautious", questions: "cautious", ...policy },
  });
  return startItemRun(base, "1", 0, T0, { sessionTokens: 0 });
}

const ask = (
  loop: LoopState,
  input: Partial<Parameters<typeof holdQuestion>[1]> = {},
) =>
  holdQuestion(
    loop,
    {
      itemId: "1",
      question: "Which database?",
      kind: "blocking",
      type: "irreversible",
      ...input,
    },
    T0,
  );

const open = (loop: LoopState) => loop.questions.filter((q) => !q.answerId);

describe("Questions IDGAF: a question is answered, never held", () => {
  test.each(["blocking", "assumption"] as const)(
    "%s: the labelled option wins, label stripped, by the system",
    (kind) => {
      const result = ask(loopAt({ questions: "idgaf" }), {
        kind,
        assumption: "sqlite",
        options: ["sqlite", "Postgres (recommended)", "mysql"],
      });
      if (!result.ok) throw new Error(result.error);
      expect(result.question).toMatchObject({
        decidedAlone: true,
        autoAnswer: {
          text: "Postgres",
          by: "system",
          source: "Questions: IDGAF",
        },
      });
      expect(result.loop.autoDecisions?.at(-1)).toMatchObject({
        kind: "question",
        by: "system",
        source: "Questions: IDGAF",
        text: "Auto-answered: Which database? -> Postgres",
      });
      expect(holdQuestionResult(result.question, false)).toContain(
        "Answered automatically (Questions: IDGAF): Postgres",
      );
    },
  );

  test("else the first option, else the best-judgment line", () => {
    const first = ask(loopAt({ questions: "idgaf" }), {
      options: ["alpha", "beta"],
    });
    expect(first.ok && first.question.autoAnswer?.text).toBe("alpha");
    const none = ask(loopAt({ questions: "idgaf" }), {});
    expect(none.ok && none.question.autoAnswer?.text).toBe(NO_ONE_AVAILABLE);
  });

  test("a plan decision takes its pick when no option is labelled", () => {
    expect(
      autoAnswerDecisions([
        { question: "q", options: ["a", "b"], pick: "b" },
        { question: "r", options: ["x (recommended)", "y"], pick: "y" },
      ]),
    ).toEqual([
      { question: "q", answer: "b" },
      { question: "r", answer: "x" },
    ]);
    expect(
      answerWithoutAsking({
        question: "q",
        options: ["a", "b"],
        pick: "b",
        source: "Questions: IDGAF",
      }),
    ).toMatchObject({
      text: "b",
      line: "Auto-answered: q -> b",
      source: "Questions: IDGAF",
    });
  });

  test("the person's own you-decide list does not apply at IDGAF", () => {
    const loop = loopAt({ questions: "idgaf" });
    const result = ask(
      {
        ...loop,
        policy: { ...loop.policy!, questions: "idgaf" },
      } as LoopState,
      { type: "irreversible" },
    );
    expect(result.ok && result.question.decidedAlone).toBe(true);
    expect(result.ok && open(result.loop)).toHaveLength(0);
  });

  test("Manual and Cautious still hold a question that is the person's", () => {
    for (const questions of ["manual", "cautious"] as const) {
      const r = ask(loopAt({ questions }), { type: "irreversible" });
      expect(r.ok && r.question.decidedAlone).toBeFalsy();
      expect(r.ok && r.question.answerId).toBeUndefined();
    }
  });
});

describe("Questions IDGAF: an approval is not held", () => {
  const approval = {
    toolName: "run_terminal_command",
    summary: "rm -rf build",
    grantKey: "k",
  };

  test("refused by the system, nothing left open, the model is told", () => {
    const r = ask(loopAt({ questions: "idgaf" }), {
      kind: "approval",
      question: "Allow this call? rm -rf build",
      approval,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.question.decidedAlone).toBe(true);
    expect(r.question.answerId).toBeDefined();
    expect(open(r.loop)).toHaveLength(0);
    expect(r.loop.autoDecisions?.at(-1)).toMatchObject({
      by: "system",
      source: "Questions: IDGAF",
    });
    expect(approvalHeldResult(r.question)).toContain("nobody was asked");
    expect(approvalHeldResult(r.question)).not.toContain("inbox");
  });

  test("below IDGAF it is held for the person as before", () => {
    for (const questions of ["manual", "cautious", "permissive"] as const) {
      const r = ask(loopAt({ questions }), {
        kind: "approval",
        question: "Allow this call? rm -rf build",
        approval,
      });
      expect(r.ok && r.question.answerId, questions).toBeUndefined();
      expect(r.ok && r.question.decidedAlone, questions).toBeFalsy();
    }
  });
});

describe("Questions IDGAF: what was already held is answered", () => {
  test("moving a loop to IDGAF answers the inbox, and refuses an approval", () => {
    const q1 = ask(loopAt({ questions: "cautious" }), {
      question: "Which one?",
      options: ["red (recommended)", "blue"],
    });
    if (!q1.ok) throw new Error(q1.error);
    const q2 = ask(q1.loop, {
      kind: "approval",
      question: "Allow this call? npm publish",
      approval: {
        toolName: "run_terminal_command",
        summary: "x",
        grantKey: "g",
      },
    });
    if (!q2.ok) throw new Error(q2.error);
    expect(open(q2.loop)).toHaveLength(2);

    const moved = setLoopPolicy(q2.loop, {
      plan: "cautious",
      questions: "idgaf",
    });
    expect(open(moved)).toHaveLength(0);
    const lines = (moved.autoDecisions ?? []).map((d) => d.text);
    expect(lines).toContain("Auto-answered: Which one? -> red");
    expect(lines.some((l) => l.includes("npm publish"))).toBe(true);
    expect(moved.autoDecisions?.every((d) => d.by === "system")).toBe(true);
  });

  test("moving to Permissive leaves the inbox alone", () => {
    const q = ask(loopAt({ questions: "cautious" }), {});
    if (!q.ok) throw new Error(q.error);
    const moved = setLoopPolicy(q.loop, {
      plan: "cautious",
      questions: "permissive",
    });
    expect(open(moved)).toHaveLength(1);
  });
});

describe("Questions IDGAF: an item over its limit is not asked about", () => {
  const breach = { which: "tokens" as const, used: 11_000, limit: 10_000 };
  function overBudget(policy: Partial<LoopPolicy>): LoopState {
    let loop: LoopState = {
      ...loopAt(policy),
      limitPolicy: "suggest",
      reserve: { tokens: 50_000 },
    };
    loop = {
      ...loop,
      current: {
        ...loop.current!,
        overBudget: breach,
        report: overBudgetReport(breach),
      },
    };
    return finishItemRun(loop, loop.current!.report, {
      sessionTokens: 11_000,
      now: new Date(T0.getTime() + 60_000),
    });
  }
  const item = { id: "1", budget: { tokens: 10_000 } };

  test("Suggest asks below IDGAF", () => {
    expect(
      applyLimitPolicy(overBudget({ questions: "cautious" }), item, {
        now: T0,
      })?.kind,
    ).toBe("ask");
  });

  test("Suggest is decided by the review rule at IDGAF", () => {
    const decision = applyLimitPolicy(
      overBudget({ questions: "idgaf" }),
      item,
      {
        now: T0,
      },
    );
    expect(decision?.kind).not.toBe("ask");
    expect(open(decision!.loop)).toHaveLength(0);
  });
});
