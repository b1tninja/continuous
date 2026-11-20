import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import {
  HEADS_UP_SECONDS,
  parseTimerSettings,
  propose,
  type PolicyFact,
  type TimerContext,
} from "./decisionTimer";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  policyUpdateProblem,
} from "./settingsFile";

const ALLOW: PolicyFact = {
  policy: "allowedWithoutPermission",
  source: "allow-rule",
};
const ASK: PolicyFact = {
  policy: "allowedWithPermission",
  source: "tool-setting",
};

const base: TimerContext = {
  attended: true,
  level: "cautious",
  settings: {},
  now: 0,
};

describe("the heads-up windows are separate from the ask windows", () => {
  it("an ask window alone never delays an allowed call", () => {
    const ctx = { ...base, settings: { cautious: 15 as const } };
    expect(propose(ALLOW, ctx)).toBeUndefined();
    expect(propose(ASK, ctx)?.proposed).toBe("refuse");
  });

  it("a heads-up window alone never puts a timer on an ask", () => {
    const ctx = { ...base, headsUp: { cautious: 5 as const } };
    expect(propose(ASK, ctx)).toBeUndefined();
    expect(propose(ALLOW, ctx)).toMatchObject({
      proposed: "allow",
      seconds: 5,
    });
  });

  it("each uses its own window when both are set", () => {
    const ctx = {
      ...base,
      settings: { cautious: 30 as const },
      headsUp: { cautious: 5 as const },
    };
    expect(propose(ASK, ctx)?.seconds).toBe(30);
    expect(propose(ALLOW, ctx)?.seconds).toBe(5);
  });

  it("the heads-up windows are 5 and 10 seconds", () => {
    expect([...HEADS_UP_SECONDS]).toEqual([0, 5, 10]);
  });

  it("parses only the heads-up windows when asked to", () => {
    expect(
      parseTimerSettings({ cautious: 5, manual: 10 }, HEADS_UP_SECONDS),
    ).toEqual({
      cautious: 5,
      manual: 10,
    });
    expect(
      parseTimerSettings({ cautious: 15, manual: 30 }, HEADS_UP_SECONDS),
    ).toEqual({});
  });
});

describe("levels.headsUp in permissions.yaml", () => {
  const read = (text: string) => parsePolicyFile(text);
  const written = (
    text: string | undefined,
    update: Parameters<typeof applyPolicyUpdate>[1],
  ) => YAML.parse(applyPolicyUpdate(text, update));

  it("is read as a window per level", () => {
    const r = read(
      "levels:\n  headsUp:\n    permissive: 5\n    cautious: 10\n",
    );
    expect(r.settings.headsUp).toEqual({ permissive: 5, cautious: 10 });
    expect(r.settings.timer).toBeUndefined();
  });

  it("is kept apart from levels.timer", () => {
    const r = read(
      "levels:\n  timer:\n    cautious: 30\n  headsUp:\n    cautious: 5\n",
    );
    expect(r.settings.timer).toEqual({ cautious: 30 });
    expect(r.settings.headsUp).toEqual({ cautious: 5 });
  });

  it("drops a window that is not offered for a heads-up, with a notice when none is left", () => {
    const r = read("levels:\n  headsUp:\n    cautious: 30\n    manual: 15\n");
    expect(r.settings.headsUp).toBeUndefined();
    expect(r.notices.join(" ")).toContain("levels.headsUp");
  });

  it("keeps the valid windows and ignores the rest", () => {
    const r = read("levels:\n  headsUp:\n    cautious: 5\n    manual: 15\n");
    expect(r.settings.headsUp).toEqual({ cautious: 5 });
  });

  it("never reads a window for IDGAF", () => {
    expect(
      read("levels:\n  headsUp:\n    idgaf: 5\n    manual: 5\n").settings
        .headsUp,
    ).toEqual({
      manual: 5,
    });
  });

  it("writes inside levels and keeps the timer and the levels", () => {
    const start = applyPolicyUpdate(undefined, {
      levels: {
        context: "cautious",
        tools: "cautious",
        edits: "cautious",
        plan: "cautious",
        questions: "cautious",
      },
      timer: { cautious: 15 },
    });
    const out = written(start, { headsUp: { permissive: 10 } });
    expect(out.levels.headsUp).toEqual({ permissive: 10 });
    expect(out.levels.timer).toEqual({ cautious: 15 });
    expect(out.levels.tools).toBe("cautious");
  });

  it("changing the timer keeps the heads-up", () => {
    const start = applyPolicyUpdate(undefined, { headsUp: { cautious: 5 } });
    const out = written(start, { timer: { cautious: 30 } });
    expect(out.levels.headsUp).toEqual({ cautious: 5 });
    expect(out.levels.timer).toEqual({ cautious: 30 });
  });

  it("null and an empty object remove it, and leave no empty levels map", () => {
    const start = applyPolicyUpdate(undefined, { headsUp: { cautious: 5 } });
    expect(written(start, { headsUp: null }).levels).toBeUndefined();
    expect(written(start, { headsUp: {} }).levels).toBeUndefined();
  });

  it("refuses a window that is not offered, IDGAF and an unknown level", () => {
    expect(
      policyUpdateProblem({ headsUp: { cautious: 30 } as never }),
    ).toContain("5 or 10");
    expect(policyUpdateProblem({ headsUp: { idgaf: 5 } as never })).toContain(
      "idgaf",
    );
    expect(policyUpdateProblem({ headsUp: { bogus: 5 } as never })).toContain(
      "bogus",
    );
    expect(
      policyUpdateProblem({ headsUp: { manual: 5, permissive: 10 } }),
    ).toBeUndefined();
    expect(policyUpdateProblem({ headsUp: null })).toBeUndefined();
  });
});
