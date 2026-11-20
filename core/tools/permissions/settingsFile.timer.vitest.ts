import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import {
  applyPolicyUpdate,
  parsePolicyFile,
  policyUpdateProblem,
} from "./settingsFile";

const LEVELS = {
  context: "cautious",
  tools: "cautious",
  edits: "cautious",
  plan: "cautious",
  questions: "cautious",
} as const;

const read = (text: string) => parsePolicyFile(text);
const written = (
  text: string | undefined,
  update: Parameters<typeof applyPolicyUpdate>[1],
) => YAML.parse(applyPolicyUpdate(text, update));

describe("levels.timer in permissions.yaml", () => {
  it("is read as a window per level", () => {
    const r = read(
      "levels:\n  tools: cautious\n  timer:\n    cautious: 10\n    permissive: 30\n",
    );
    expect(r.settings.timer).toEqual({ cautious: 10, permissive: 30 });
    expect(r.notices).toEqual([]);
  });

  it("is absent when the file has none", () => {
    expect(read("levels:\n  tools: cautious\n").settings.timer).toBeUndefined();
    expect(read("").settings.timer).toBeUndefined();
  });

  it("drops a window that is not offered, with a notice when nothing is left", () => {
    const r = read("levels:\n  timer:\n    cautious: 7\n    manual: soon\n");
    expect(r.settings.timer).toBeUndefined();
    expect(r.notices.join(" ")).toContain("levels.timer");
  });

  it("keeps the valid windows and ignores the rest without a notice", () => {
    const r = read("levels:\n  timer:\n    cautious: 15\n    manual: 7\n");
    expect(r.settings.timer).toEqual({ cautious: 15 });
    expect(r.notices).toEqual([]);
  });

  it("never reads a window for IDGAF", () => {
    expect(
      read("levels:\n  timer:\n    idgaf: 10\n    manual: 5\n").settings.timer,
    ).toEqual({
      manual: 5,
    });
  });

  it("an empty timer map is no timer and no notice", () => {
    const r = read("levels:\n  timer: {}\n");
    expect(r.settings.timer).toBeUndefined();
    expect(r.notices).toEqual([]);
  });

  it("does not disturb the five levels or the custom set", () => {
    const r = read(
      "levels:\n  tools: permissive\n  timer:\n    permissive: 5\n  custom:\n    levels:\n      context: manual\n      tools: manual\n      edits: manual\n      plan: manual\n      questions: manual\n",
    );
    expect(r.settings.timer).toEqual({ permissive: 5 });
    expect(r.settings.custom).toBeDefined();
  });
});

describe("writing the timer", () => {
  it("writes the windows inside levels", () => {
    const out = written(undefined, { timer: { cautious: 10, permissive: 5 } });
    expect(out.levels.timer).toEqual({ cautious: 10, permissive: 5 });
  });

  it("changing the levels keeps the timer", () => {
    const start = applyPolicyUpdate(undefined, { timer: { cautious: 30 } });
    const out = written(start, { levels: { ...LEVELS, tools: "permissive" } });
    expect(out.levels.tools).toBe("permissive");
    expect(out.levels.timer).toEqual({ cautious: 30 });
  });

  it("changing the timer keeps the levels and the custom set", () => {
    const start = applyPolicyUpdate(undefined, {
      levels: LEVELS,
      custom: { from: "careful", levels: { ...LEVELS, tools: "manual" } },
    });
    const out = written(start, { timer: { manual: 15 } });
    expect(out.levels.tools).toBe("cautious");
    expect(out.levels.custom).toBeDefined();
    expect(out.levels.timer).toEqual({ manual: 15 });
  });

  it("replaces the windows it is given as a whole", () => {
    const start = applyPolicyUpdate(undefined, {
      timer: { cautious: 10, manual: 5 },
    });
    expect(written(start, { timer: { permissive: 30 } }).levels.timer).toEqual({
      permissive: 30,
    });
  });

  it("null removes it, and an empty object removes it", () => {
    const start = applyPolicyUpdate(undefined, {
      levels: LEVELS,
      timer: { cautious: 10 },
    });
    for (const gone of [null, {}] as const) {
      const out = written(start, { timer: gone });
      expect(out.levels.timer, JSON.stringify(gone)).toBeUndefined();
      expect(out.levels.tools).toBe("cautious");
    }
  });

  it("removing the only entry leaves no empty levels map", () => {
    const start = applyPolicyUpdate(undefined, { timer: { cautious: 10 } });
    const out = written(start, { timer: null });
    expect(out.levels).toBeUndefined();
  });

  it("leaves the timer alone when the update does not mention it", () => {
    const start = applyPolicyUpdate(undefined, { timer: { cautious: 10 } });
    expect(written(start, { maxNewPlanItems: 3 }).levels.timer).toEqual({
      cautious: 10,
    });
  });

  it("writes only valid windows", () => {
    const out = written(undefined, {
      timer: { cautious: 10, idgaf: 5 } as never,
    });
    expect(out.levels.timer).toEqual({ cautious: 10 });
  });
});

describe("policyUpdateProblem for the timer", () => {
  it("accepts the offered windows", () => {
    expect(
      policyUpdateProblem({
        timer: { manual: 5, cautious: 10, automatic: 15, permissive: 30 },
      }),
    ).toBeUndefined();
    expect(policyUpdateProblem({ timer: null })).toBeUndefined();
    expect(policyUpdateProblem({ timer: {} })).toBeUndefined();
  });

  it("refuses a window that is not offered, naming the level", () => {
    const why = policyUpdateProblem({ timer: { cautious: 7 } as never });
    expect(why).toContain("cautious");
    expect(why).toContain("5, 10, 15 or 30");
  });

  it("refuses IDGAF and an unknown level", () => {
    expect(policyUpdateProblem({ timer: { idgaf: 10 } as never })).toContain(
      "idgaf",
    );
    expect(policyUpdateProblem({ timer: { bogus: 10 } as never })).toContain(
      "bogus",
    );
  });
});
