import { describe, expect, it } from "vitest";
import {
  countdownLabel,
  modelNote,
  parseTimerSettings,
  propose,
  remainingMs,
  remainingSeconds,
  resolve,
  TIMER_SECONDS,
  type PolicyFact,
  type Proposal,
  type TimerContext,
} from "./decisionTimer";

const ALLOW: PolicyFact = {
  policy: "allowedWithoutPermission",
  source: "allow-rule",
};
const ASK: PolicyFact = {
  policy: "allowedWithPermission",
  source: "tool-setting",
};
const REFUSE: PolicyFact = { policy: "disabled", source: "deny-rule" };

const ctx = (over: Partial<TimerContext> = {}): TimerContext => ({
  attended: true,
  level: "cautious",
  settings: { cautious: 10, permissive: 5 },
  headsUp: { cautious: 10, permissive: 5 },
  now: 1_000,
  ...over,
});

describe("TIMER_SECONDS", () => {
  it("is off, then 5, 10, 15 and 30 seconds, and never longer", () => {
    expect([...TIMER_SECONDS]).toEqual([0, 5, 10, 15, 30]);
    expect(Math.max(...TIMER_SECONDS)).toBeLessThan(60);
  });
});

describe("parseTimerSettings", () => {
  it("reads a window per level", () => {
    expect(
      parseTimerSettings({ manual: 5, cautious: "15", permissive: 30 }),
    ).toEqual({ manual: 5, cautious: 15, permissive: 30 });
  });

  it("treats a window that is not offered as off", () => {
    expect(
      parseTimerSettings({
        cautious: 7,
        manual: -5,
        permissive: 60,
        automatic: 600,
      }),
    ).toEqual({});
    expect(parseTimerSettings({ cautious: "soon", manual: null })).toEqual({});
  });

  it("treats 0 as off and leaves it out", () => {
    expect(parseTimerSettings({ cautious: 0 })).toEqual({});
  });

  it("never sets a window for IDGAF", () => {
    expect(parseTimerSettings({ idgaf: 10, cautious: 5 })).toEqual({
      cautious: 5,
    });
  });

  it("ignores an unknown level and a value that is not an object", () => {
    expect(parseTimerSettings({ yolo: 10, nonsense: 5 })).toEqual({});
    for (const v of [undefined, null, "10", 10, [10], true]) {
      expect(parseTimerSettings(v), String(v)).toEqual({});
    }
  });
});

describe("propose", () => {
  it("proposes to run an allow, for the window set at the level", () => {
    const p = propose(ALLOW, ctx());
    expect(p).toMatchObject({
      proposed: "allow",
      seconds: 10,
      startedAt: 1_000,
    });
    expect(p?.decision).toBe(ALLOW);
  });

  it("proposes to refuse an ask, as the policy does when nobody can answer", () => {
    expect(propose(ASK, ctx())?.proposed).toBe("refuse");
  });

  it("uses the window of the level in force", () => {
    expect(propose(ALLOW, ctx({ level: "permissive" }))?.seconds).toBe(5);
  });

  it("has no proposal where the level has no window", () => {
    expect(propose(ALLOW, ctx({ level: "manual" }))).toBeUndefined();
    expect(propose(ALLOW, ctx({ headsUp: {} }))).toBeUndefined();
    expect(propose(ALLOW, ctx({ headsUp: undefined }))).toBeUndefined();
  });

  it("has no proposal at IDGAF, whatever is set", () => {
    expect(
      propose(ALLOW, ctx({ level: "idgaf", headsUp: { idgaf: 10 } as never })),
    ).toBeUndefined();
  });

  it("has no proposal when nobody is there to see it", () => {
    expect(propose(ALLOW, ctx({ attended: false }))).toBeUndefined();
    expect(propose(ASK, ctx({ attended: false }))).toBeUndefined();
  });

  it("has no proposal for a refusal: it is final", () => {
    expect(propose(REFUSE, ctx())).toBeUndefined();
    for (const source of [
      "floor",
      "safety-floor",
      "secret-egress",
      "deny-rule",
    ]) {
      expect(
        propose({ policy: "disabled", source }, ctx()),
        source,
      ).toBeUndefined();
    }
  });

  it("has no proposal for an ask that a rule or a guard raised", () => {
    for (const source of [
      "ask-rule",
      "protected-path",
      "floor",
      "tainted-session",
      "shell-hint",
      undefined,
    ]) {
      expect(
        propose({ policy: "allowedWithPermission", source }, ctx()),
        String(source),
      ).toBeUndefined();
    }
    expect(
      propose(
        {
          policy: "allowedWithPermission",
          source: "tool-setting",
          protection: "secret",
        },
        ctx(),
      ),
    ).toBeUndefined();
  });

  it("proposes for an ask from the level the person chose", () => {
    for (const source of ["manual", "cautious", "tool-setting"]) {
      expect(
        propose({ policy: "allowedWithPermission", source }, ctx()),
      ).toBeDefined();
    }
  });

  it("an allow that a protection decided still gets a proposal to run it", () => {
    expect(
      propose(
        { policy: "allowedWithoutPermission", source: "permissive" },
        ctx(),
      )?.proposed,
    ).toBe("allow");
  });
});

describe("the countdown", () => {
  const p = propose(
    ALLOW,
    ctx({ now: 10_000, headsUp: { cautious: 10 } }),
  ) as Proposal;

  it("counts down from the window and stops at zero", () => {
    expect(remainingMs(p, 10_000)).toBe(10_000);
    expect(remainingMs(p, 14_000)).toBe(6_000);
    expect(remainingMs(p, 20_000)).toBe(0);
    expect(remainingMs(p, 99_000)).toBe(0);
  });

  it("never goes negative, and a clock that steps back does not extend it past the window", () => {
    expect(remainingMs(p, 20_001)).toBe(0);
    expect(remainingMs(p, 5_000)).toBe(10_000);
    expect(remainingSeconds(p, 5_000)).toBe(10);
  });

  it("rounds up, so the last second reads 1 and 0 means the window ended", () => {
    expect(remainingSeconds(p, 10_000)).toBe(10);
    expect(remainingSeconds(p, 10_001)).toBe(10);
    expect(remainingSeconds(p, 19_001)).toBe(1);
    expect(remainingSeconds(p, 19_999)).toBe(1);
    expect(remainingSeconds(p, 20_000)).toBe(0);
  });

  it("labels seconds, and minutes from a minute up", () => {
    expect(countdownLabel(0)).toBe("0 s");
    expect(countdownLabel(7)).toBe("7 s");
    expect(countdownLabel(59)).toBe("59 s");
    expect(countdownLabel(60)).toBe("1:00");
    expect(countdownLabel(65)).toBe("1:05");
    expect(countdownLabel(-3)).toBe("0 s");
    expect(countdownLabel(7.9)).toBe("7 s");
  });
});

describe("resolve", () => {
  const allow = propose(ALLOW, ctx({ now: 0 })) as Proposal;
  const ask = propose(ASK, ctx({ now: 0 })) as Proposal;

  it("is pending while the window runs with no answer", () => {
    expect(resolve(allow, undefined, 5_000)).toBeUndefined();
    expect(resolve(allow, undefined, 9_999)).toBeUndefined();
  });

  it("applies the proposal when the window ends with no answer", () => {
    expect(resolve(allow, undefined, 10_000)).toEqual({
      outcome: "default-applied",
      final: "allow",
    });
    expect(resolve(ask, undefined, 10_000)).toEqual({
      outcome: "default-applied",
      final: "refuse",
    });
  });

  it("confirms when the person chooses what was proposed", () => {
    expect(resolve(allow, "allow", 1_000)).toEqual({
      outcome: "confirmed",
      final: "allow",
    });
    expect(resolve(ask, "deny", 1_000)).toEqual({
      outcome: "confirmed",
      final: "refuse",
    });
  });

  it("records an override when the person chooses the other way", () => {
    expect(resolve(allow, "deny", 1_000)).toEqual({
      outcome: "overridden",
      final: "refuse",
    });
    expect(resolve(ask, "allow", 1_000)).toEqual({
      outcome: "overridden",
      final: "allow",
    });
  });

  it("an answer after the window still counts as the person's, while it is the first", () => {
    expect(resolve(allow, "deny", 50_000)?.outcome).toBe("overridden");
  });
});

describe("modelNote", () => {
  it("says nothing for a call that runs", () => {
    expect(
      modelNote({ outcome: "default-applied", final: "allow" }, "Bash", 10),
    ).toBeUndefined();
    expect(
      modelNote({ outcome: "overridden", final: "allow" }, "Bash", 10),
    ).toBeUndefined();
  });

  it("says nobody answered, and does not call it a verdict or the person's refusal", () => {
    const note =
      modelNote({ outcome: "default-applied", final: "refuse" }, "Bash", 15) ??
      "";
    expect(note).toContain("No answer to Bash within 15 s");
    expect(note).toContain("not judged unsafe");
    expect(note).toContain("did not refuse it");
    expect(note).not.toMatch(/user skipped|try an alternative/i);
  });

  it("tells the model not to route around the prompt", () => {
    const note =
      modelNote({ outcome: "default-applied", final: "refuse" }, "Bash", 15) ??
      "";
    expect(note).toContain("do not change the approach");
  });

  it("says the person declined when they did", () => {
    for (const outcome of ["confirmed", "overridden"] as const) {
      const note =
        modelNote({ outcome, final: "refuse" }, "create_new_file", 10) ?? "";
      expect(note, outcome).toContain("The person declined create_new_file");
      expect(note).toContain("Do not retry it unchanged");
      expect(note).not.toContain("No answer");
    }
  });

  it("never offers 'try an alternative approach' in any message", () => {
    for (const outcome of [
      "default-applied",
      "overridden",
      "confirmed",
    ] as const) {
      expect(
        modelNote({ outcome, final: "refuse" }, "Bash", 5) ?? "",
      ).not.toMatch(/alternative approach|skip it and continue/i);
    }
  });
});
