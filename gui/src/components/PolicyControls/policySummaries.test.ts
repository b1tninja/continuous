import { describe, expect, it } from "vitest";
import {
  builtinRulesSummary,
  decisionTimerSummary,
  plansAndQuestionsSummary,
  skipConfirmState,
  whoDecidesCounts,
} from "./policySummaries";

describe("the one-line state of each folded permission group", () => {
  it("built-in rules: all on and not set, then set, then which are off", () => {
    expect(builtinRulesSummary({})).toEqual({ text: "Not set: 11 of 11 on" });
    expect(
      builtinRulesSummary({ builtin: { "protect-secrets": true } }),
    ).toEqual({ text: "Set by you: 11 of 11 on" });
    expect(
      builtinRulesSummary({
        builtin: { "protect-secrets": false, "ask-large-change": false },
      }),
    ).toEqual({
      text: "Set by you: 9 of 11 on. Off: Ask before touching credentials; Ask before a large change",
      warning: true,
    });
  });

  it("plans and questions: the built-in values, then the person's", () => {
    expect(plansAndQuestionsSummary({}).text).toBe(
      "Not set: 5 new to-dos; you decide 4 of 6 kinds",
    );
    expect(
      plansAndQuestionsSummary({
        maxNewPlanItems: 1,
        questions: { youDecide: ["scope"], agentDecides: ["detail"] },
      }).text,
    ).toBe("Set by you: 1 new to-do; you decide 1 of 6 kinds");
    // The file load fills `questions` with undefined lists: still not set
    expect(
      plansAndQuestionsSummary({
        questions: { youDecide: undefined, agentDecides: undefined },
      }).text,
    ).toBe("Not set: 5 new to-dos; you decide 4 of 6 kinds");
  });

  it("who decides: counts every kind once", () => {
    expect(whoDecidesCounts({})).toEqual({
      you: 4,
      agent: 1,
      level: 1,
      set: false,
    });
    expect(
      whoDecidesCounts({ questions: { youDecide: [], agentDecides: [] } }),
    ).toEqual({ you: 0, agent: 0, level: 6, set: true });
  });

  it("decision timer: off when no window is set, else every window", () => {
    expect(decisionTimerSummary({}).text).toBe(
      "Not set: off. A decision takes effect at once",
    );
    // Every window turned off again leaves an empty object in the store
    expect(decisionTimerSummary({ timer: {}, headsUp: {} }).text).toBe(
      "Not set: off. A decision takes effect at once",
    );
    expect(
      decisionTimerSummary({
        timer: { manual: 30, cautious: 10 },
        headsUp: { permissive: 5 },
      }).text,
    ).toBe(
      "Set by you: asks wait Manual 30 s, Cautious 10 s; allowed calls wait Permissive 5 s",
    );
  });

  it("the confirmation skip is not set until it is on", () => {
    expect(skipConfirmState({})).toBe(
      "Not set: off, so the dialog still appears.",
    );
    expect(skipConfirmState({ skipPermissionConfirm: false })).toContain(
      "Not set",
    );
    expect(skipConfirmState({ skipPermissionConfirm: true })).toContain(
      "Set by you: on.",
    );
  });
});
