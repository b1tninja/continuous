import { describe, expect, test } from "vitest";

import type { LoopPolicy, LoopState, TaskPlan } from "../index.js";

import {
  autonomyForPolicy,
  createLoop,
  finishItemReport,
  finishItemRun,
  holdQuestion,
  itemTurnLimitReport,
  repeatedCallReport,
  loopItemRepairPrompt,
  loopReplanPrompt,
  loopAutonomy,
  loopDecidesAlone,
  loopQuestionDecider,
  replanDecision,
  repairDecision,
  replanDiff,
  setLoopPolicy,
  startItemRun,
} from "./loopMode.js";

const T0 = new Date("2026-11-08T10:00:00Z");

const plan = (...texts: string[]): TaskPlan => ({
  items: texts.map((text, i) => ({
    id: String(i + 1),
    text,
    status: "pending" as const,
  })),
  updatedAt: T0.toISOString(),
});

const loopWith = (policy: Partial<LoopPolicy>): LoopState =>
  startItemRun(
    createLoop(plan("A", "B"), {
      now: T0,
      sessionTokens: 0,
      policy: { plan: "cautious", questions: "cautious", ...policy },
    }),
    "1",
    0,
    T0,
  );

describe("a loop that follows policy levels", () => {
  test("its limits and strategy come from the levels", () => {
    expect(autonomyForPolicy({ plan: "manual", questions: "manual" })).toBe(
      "supervised",
    );
    expect(autonomyForPolicy({ plan: "cautious", questions: "cautious" })).toBe(
      "auto",
    );
    expect(
      autonomyForPolicy({ plan: "permissive", questions: "cautious" }),
    ).toBe("unattended");
    expect(autonomyForPolicy({ plan: "manual", questions: "delegate" })).toBe(
      "idgaf",
    );
    expect(loopWith({ plan: "permissive" }).autonomy).toBe("unattended");
  });

  test("a question waits until it is answered: no timer unless nobody can answer", () => {
    expect(loopAutonomy(loopWith({ plan: "permissive" })).waitTimeoutMs).toBe(
      0,
    );
    expect(
      loopAutonomy(loopWith({ questions: "delegate" })).waitTimeoutMs,
    ).toBe(1000);
  });

  test("changing the policy keeps the limits and the strategy", () => {
    const loop = loopWith({});
    const changed = setLoopPolicy(loop, {
      plan: "permissive",
      questions: "cautious",
    });
    expect(changed.policy?.plan).toBe("permissive");
    expect(changed.budget).toEqual(loop.budget);
    expect(changed.strategy).toBe(loop.strategy);
  });
});

describe("Plan edits decides a re-plan", () => {
  const before = ["A", "B"];

  test("Manual: every re-plan waits", () => {
    const d = replanDecision(
      loopWith({ plan: "manual" }),
      before,
      plan("A", "B"),
    );
    expect(d.accept).toBe(false);
  });

  test("Cautious: the first plan waits, and a re-plan is held only by the switch", () => {
    const loop = loopWith({ plan: "cautious" });
    // adds nothing, adds a little: both are ordinary re-plans and go on
    expect(replanDecision(loop, before, plan("A", "B")).accept).toBe(true);
    expect(replanDecision(loop, before, plan("A", "B", "C")).accept).toBe(true);
    // adds more than the limit (5): held
    expect(
      replanDecision(loop, before, plan("A", "B", "1", "2", "3", "4", "5", "6"))
        .accept,
    ).toBe(false);
  });

  test("with the re-plan switch off, no re-plan waits for its size", () => {
    const many = plan("A", "B", "1", "2", "3", "4", "5", "6", "7", "8");
    for (const level of ["cautious", "permissive", "automatic"] as const) {
      const loop = loopWith({ plan: level, holdReplans: false });
      expect(replanDecision(loop, before, many).accept, level).toBe(true);
    }
  });

  test("Manual still waits for every re-plan, whatever the switch", () => {
    const loop = loopWith({ plan: "manual", holdReplans: false });
    expect(replanDecision(loop, before, plan("A", "B")).accept).toBe(false);
  });

  test("Permissive: a re-plan may add up to the limit", () => {
    const loop = loopWith({ plan: "permissive", maxNewPlanItems: 2 });
    expect(replanDecision(loop, before, plan("A", "B", "C", "D")).accept).toBe(
      true,
    );
    expect(
      replanDecision(loop, before, plan("A", "B", "C", "D", "E")).accept,
    ).toBe(false);
  });

  test("Automatic keeps Permissive's cap: no reviewer for plans exists yet (UJ10)", () => {
    expect(
      replanDecision(
        loopWith({ plan: "automatic" }),
        before,
        plan("A", "B", "1", "2", "3", "4", "5", "6"),
      ).accept,
    ).toBe(false);
    expect(
      replanDecision(
        loopWith({ plan: "automatic" }),
        before,
        plan("A", "B", "1", "2"),
      ).accept,
    ).toBe(true);
  });

  test("a repair of just the failed item goes on at every level but Manual", () => {
    const repaired = plan("A", "B, first half", "B, second half");
    for (const level of ["cautious", "permissive", "automatic"] as const) {
      expect(
        repairDecision(loopWith({ plan: level }), before, "B", repaired).accept,
      ).toBe(true);
    }
    expect(
      repairDecision(loopWith({ plan: "manual" }), before, "B", repaired)
        .accept,
    ).toBe(false);
  });
});

describe("Questions decides who answers", () => {
  const hold = (loop: LoopState, type: string) =>
    holdQuestion(
      loop,
      {
        itemId: "1",
        question: "Which?",
        kind: "assumption",
        assumption: "the first",
        type,
      },
      T0,
    );

  test("Delegate: the agent decides every question, whatever its type", () => {
    const loop = loopWith({ questions: "delegate" });
    expect(loopDecidesAlone(loop)).toBe(true);
    const held = hold(loop, "security");
    expect(held.ok && held.question.decidedAlone).toBe(true);
  });

  test("Cautious: you decide, except types the agent may decide", () => {
    const loop = loopWith({ questions: "cautious" });
    expect(loopQuestionDecider(loop, "scope")).toBe("person");
    expect(loopQuestionDecider(loop, "detail")).toBe("agent");
    expect(loopQuestionDecider(loop, undefined)).toBe("person");
    const held = hold(loop, "detail");
    expect(held.ok && held.question.decidedAlone).toBe(true);
    const asked = hold(loop, "scope");
    expect(asked.ok && asked.question.decidedAlone).toBeUndefined();
  });

  test("Permissive: the agent decides, except types you keep", () => {
    const loop = loopWith({ questions: "permissive" });
    expect(loopQuestionDecider(loop, "design")).toBe("agent");
    // the default list no longer holds a question back: only your own does
    expect(loopQuestionDecider(loop, "security")).toBe("agent");
    expect(loopQuestionDecider(loop, undefined)).toBe("agent");
    expect(
      loopQuestionDecider(
        loopWith({ questions: "permissive", youDecide: ["design"] }),
        "design",
      ),
    ).toBe("person");
  });

  test("Manual: you decide every question, even a detail", () => {
    expect(
      loopQuestionDecider(loopWith({ questions: "manual" }), "detail"),
    ).toBe("person");
  });

  test("an approval is never decided by the agent: at Delegate it is refused, not held", () => {
    const held = holdQuestion(
      loopWith({ questions: "delegate" }),
      { itemId: "1", question: "Run it?", kind: "approval" },
      T0,
    );
    expect(held.ok && held.question.decidedAlone).toBe(true);
    expect(held.ok && held.question.autoAnswer?.text).toMatch(/^Refused/);
    expect(held.ok && held.loop.questions.some((q) => !q.answerId)).toBe(false);
  });
});

describe("replanDiff", () => {
  const awaiting = (): LoopState => {
    const base = createLoop(plan("One", "Two", "Three"), {
      now: T0,
      sessionTokens: 0,
    });
    return {
      ...base,
      status: "awaiting_plan",
      items: base.items.map((i, n) => ({
        ...i,
        status:
          n === 0
            ? ("done" as const)
            : n === 1
              ? ("failed" as const)
              : i.status,
      })),
      replanned: { planTexts: ["One", "Two", "Three"] },
    };
  };

  test("is undefined when no re-plan is waiting", () => {
    expect(
      replanDiff(
        createLoop(plan("A"), { now: T0, sessionTokens: 0 }),
        plan("A"),
      ),
    ).toBeUndefined();
  });

  test("a to-do the loop has keeps its state; a reworded one is dropped and added", () => {
    const diff = replanDiff(awaiting(), {
      items: [
        { id: "1", text: "One", status: "pending" },
        { id: "4", text: "Two, first half", status: "pending" },
        { id: "5", text: "Two, second half", status: "pending" },
        { id: "3", text: "Three", status: "pending" },
      ],
      updatedAt: T0.toISOString(),
    });
    expect(diff?.kept).toEqual([
      { text: "One", status: "done" },
      { text: "Three", status: "pending" },
    ]);
    expect(diff?.added).toEqual(["Two, first half", "Two, second half"]);
    expect(diff?.dropped).toEqual([{ text: "Two", status: "failed" }]);
  });

  test("a to-do the old plan had word for word is kept even under a new id", () => {
    const diff = replanDiff(awaiting(), {
      items: [
        { id: "9", text: "Two", status: "pending" },
        { id: "10", text: "Brand new", status: "pending" },
      ],
      updatedAt: T0.toISOString(),
    });
    expect(diff?.kept).toEqual([{ text: "Two", status: "failed" }]);
    expect(diff?.added).toEqual(["Brand new"]);
    expect(diff?.dropped.map((d) => d.text)).toEqual(["One", "Three"]);
  });
});

describe("a held question keeps the choices the agent offered", () => {
  const held = (options: unknown) => {
    const r = holdQuestion(
      loopWith({}),
      {
        itemId: "1",
        question: "Where does the fix land?",
        kind: "blocking",
        options,
      },
      T0,
    );
    if (!r.ok) throw new Error(r.error);
    return r.question;
  };

  test("two to four distinct choices are kept, in order", () => {
    expect(held(["Workspace copy", "Upstream", "Both"]).options).toEqual([
      "Workspace copy",
      "Upstream",
      "Both",
    ]);
  });

  test("duplicates, blanks and non-strings are dropped, and more than four are cut", () => {
    expect(held(["A", " A ", "", 7, "B", "C", "D", "E"]).options).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
  });

  test("fewer than two usable choices is a free-text question", () => {
    expect(held(["Only one"]).options).toBeUndefined();
    expect(held("not a list").options).toBeUndefined();
    expect(held(undefined).options).toBeUndefined();
  });
});

describe("a stuck run says what is in the way", () => {
  const stuck = (extra: Record<string, unknown>) =>
    finishItemReport({ outcome: "stuck", summary: "no runner", ...extra });

  test("a blocker and what it needs come through; needs only for a dependency", () => {
    const r = stuck({
      blocker: "dependency",
      needs: ["Install vitest", " ", 3],
    });
    expect(r.ok && r.report).toMatchObject({
      blocker: "dependency",
      needs: ["Install vitest"],
    });
    const env = stuck({ blocker: "environment", needs: ["ignored"] });
    expect(env.ok && env.report.needs).toBeUndefined();
  });

  test("at most three needs, each cut to a short length", () => {
    const r = stuck({
      blocker: "dependency",
      needs: ["a", "b", "c", "d", "x".repeat(500)],
    });
    expect(r.ok && r.report.needs).toEqual(["a", "b", "c"]);
    const long = stuck({ blocker: "dependency", needs: ["x".repeat(500)] });
    expect(long.ok && long.report.needs?.[0]).toHaveLength(200);
  });

  test("an unknown blocker is refused, naming the choices", () => {
    expect(stuck({ blocker: "mood" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("dependency"),
    });
  });

  test("only a stuck report has a blocker, and a stuck one need not", () => {
    const done = finishItemReport({ outcome: "done", blocker: "plan" });
    expect(done.ok && done.report.blocker).toBeUndefined();
    const bare = stuck({});
    expect(bare.ok && bare.report.blocker).toBeUndefined();
  });

  const failedWith = (report: Record<string, unknown>): LoopState => {
    const loop = loopWith({});
    return finishItemRun(
      { ...loop, current: { ...loop.current!, report: report as never } },
      report as never,
    );
  };

  test("the failed item keeps the blocker and what it needs", () => {
    const after = failedWith({
      outcome: "stuck",
      summary: "no runner",
      blocker: "dependency",
      needs: ["Install vitest"],
    });
    expect(after.items[0]).toMatchObject({
      status: "failed",
      blocker: "dependency",
      needs: ["Install vitest"],
    });
  });

  test("the repair prompt starts from the cause and asks for a split", () => {
    const after = failedWith({
      outcome: "stuck",
      summary: "no runner",
      blocker: "dependency",
      needs: ["Install vitest"],
    });
    const prompt = loopItemRepairPrompt({
      loop: after,
      plan: plan("A", "B"),
      itemId: "1",
    });
    expect(prompt).toContain("What it says is in the way: dependency");
    expect(prompt).toContain("It says these have to be done first:");
    expect(prompt).toContain("- Install vitest");
    expect(prompt).toContain("so split it");
  });

  test("a blocker without needs gets no split instruction", () => {
    const after = failedWith({
      outcome: "stuck",
      summary: "no creds",
      blocker: "environment",
    });
    const prompt = loopItemRepairPrompt({
      loop: after,
      plan: plan("A", "B"),
      itemId: "1",
    });
    expect(prompt).toContain("What it says is in the way: environment");
    expect(prompt).not.toContain("so split it");
  });

  test("the whole-plan re-plan lists the blocker beside the failure", () => {
    const after = failedWith({
      outcome: "stuck",
      summary: "no runner",
      blocker: "dependency",
      needs: ["Install vitest"],
    });
    const prompt = loopReplanPrompt({ loop: after, plan: plan("A", "B") });
    expect(prompt).toContain("blocked: dependency, needs");
  });

  test("a run that later finishes drops the old blocker", () => {
    const failed = failedWith({
      outcome: "stuck",
      summary: "no runner",
      blocker: "plan",
    });
    const again = startItemRun(
      {
        ...failed,
        items: failed.items.map((i) => ({ ...i, status: "pending" as const })),
      },
      "1",
      0,
      T0,
    );
    const done = finishItemRun(
      { ...again, current: { ...again.current!, report: { outcome: "done" } } },
      { outcome: "done", summary: "fixed" },
    );
    expect(done.items[0].blocker).toBeUndefined();
  });
});

describe("a run that never reports", () => {
  test("a run ended at its request limit is stuck on the plan, and a repeating run cannot observe", () => {
    expect(itemTurnLimitReport(70)).toMatchObject({
      outcome: "stuck",
      blocker: "plan",
    });
    expect(repeatedCallReport("run_terminal_command")).toMatchObject({
      outcome: "stuck",
      blocker: "observe",
    });
  });

  test("the repair prompt then asks for an item a run can finish", () => {
    const loop = loopWith({});
    const after = finishItemRun(
      {
        ...loop,
        current: { ...loop.current!, report: itemTurnLimitReport(70) },
      },
      itemTurnLimitReport(70),
    );
    expect(after.items[0]).toMatchObject({ status: "failed", blocker: "plan" });
    const prompt = loopItemRepairPrompt({
      loop: after,
      plan: plan("A", "B"),
      itemId: "1",
    });
    expect(prompt).toContain("What it says is in the way: plan");
    expect(prompt).toContain("no end to reach");
    expect(prompt).toContain("only passes once the work is done");
  });
});
