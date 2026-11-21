import { describe, expect, it } from "vitest";
import * as YAML from "yaml";

import { applyPolicyUpdate, parsePolicyFile } from "./settingsFile";

/**
 * Three settings written by the same function: the decision timer
 * (`levels.timer`), the heads-up (`levels.headsUp`) and
 * `skipPermissionConfirm`. Saving one must never drop another, whatever order
 * they are written in, and each must be read back as written.
 */
const LEVELS = {
  context: "cautious",
  tools: "cautious",
  edits: "cautious",
  plan: "cautious",
  questions: "cautious",
} as const;

const doc = (text: string | undefined) => YAML.parse(text ?? "") ?? {};

/** What the app reads back: the file may spell the value "on", not true. */
const skip = (text: string | undefined) =>
  parsePolicyFile(text ?? "").settings.skipPermissionConfirm;

describe("the timer, the heads-up and skipPermissionConfirm together", () => {
  it("all three are kept when written one after another", () => {
    let t = applyPolicyUpdate(undefined, { levels: LEVELS });
    t = applyPolicyUpdate(t, { timer: { cautious: 15 } });
    t = applyPolicyUpdate(t, { headsUp: { permissive: 5 } });
    t = applyPolicyUpdate(t, { skipPermissionConfirm: true });
    const d = doc(t);
    expect(d.levels.timer).toEqual({ cautious: 15 });
    expect(d.levels.headsUp).toEqual({ permissive: 5 });
    expect(skip(t)).toBe(true);
    expect(d.levels.tools).toBe("cautious");
  });

  it("the order does not matter", () => {
    const orders = [
      ["skip", "timer", "headsUp"],
      ["headsUp", "skip", "timer"],
      ["timer", "headsUp", "skip"],
    ] as const;
    for (const order of orders) {
      let t = applyPolicyUpdate(undefined, { levels: LEVELS });
      for (const which of order) {
        t = applyPolicyUpdate(
          t,
          which === "skip"
            ? { skipPermissionConfirm: true }
            : which === "timer"
              ? { timer: { manual: 10 } }
              : { headsUp: { manual: 5 } },
        );
      }
      const d = doc(t);
      expect(d.levels.timer, order.join()).toEqual({ manual: 10 });
      expect(d.levels.headsUp, order.join()).toEqual({ manual: 5 });
      expect(skip(t), order.join()).toBe(true);
    }
  });

  it("changing the levels keeps both windows and the skip setting", () => {
    let t = applyPolicyUpdate(undefined, {
      levels: LEVELS,
      timer: { cautious: 30 },
      headsUp: { cautious: 10 },
      skipPermissionConfirm: true,
    });
    t = applyPolicyUpdate(t, { levels: { ...LEVELS, tools: "permissive" } });
    const d = doc(t);
    expect(d.levels.tools).toBe("permissive");
    expect(d.levels.timer).toEqual({ cautious: 30 });
    expect(d.levels.headsUp).toEqual({ cautious: 10 });
    expect(skip(t)).toBe(true);
  });

  it("removing the skip setting leaves both windows", () => {
    let t = applyPolicyUpdate(undefined, {
      levels: LEVELS,
      timer: { cautious: 30 },
      headsUp: { cautious: 10 },
      skipPermissionConfirm: true,
    });
    t = applyPolicyUpdate(t, { skipPermissionConfirm: null });
    const d = doc(t);
    expect("skipPermissionConfirm" in d).toBe(false);
    expect(skip(t)).toBeUndefined();
    expect(d.levels.timer).toEqual({ cautious: 30 });
    expect(d.levels.headsUp).toEqual({ cautious: 10 });
  });

  it("removing both windows leaves the skip setting and the levels", () => {
    let t = applyPolicyUpdate(undefined, {
      levels: LEVELS,
      timer: { cautious: 30 },
      headsUp: { cautious: 10 },
      skipPermissionConfirm: true,
    });
    t = applyPolicyUpdate(t, { timer: null, headsUp: null });
    const d = doc(t);
    expect(d.levels.timer).toBeUndefined();
    expect(d.levels.headsUp).toBeUndefined();
    expect(d.levels.tools).toBe("cautious");
    expect(skip(t)).toBe(true);
  });

  it("reads all three back from one file", () => {
    const r = parsePolicyFile(
      "skipPermissionConfirm: on\nlevels:\n  tools: cautious\n  timer:\n    cautious: 15\n  headsUp:\n    permissive: 5\n",
    );
    expect(r.settings.skipPermissionConfirm).toBe(true);
    expect(r.settings.timer).toEqual({ cautious: 15 });
    expect(r.settings.headsUp).toEqual({ permissive: 5 });
    expect(r.notices).toEqual([]);
  });

  it("an update that mentions none of them leaves all three", () => {
    let t = applyPolicyUpdate(undefined, {
      levels: LEVELS,
      timer: { cautious: 30 },
      headsUp: { cautious: 10 },
      skipPermissionConfirm: true,
    });
    t = applyPolicyUpdate(t, { maxNewPlanItems: 3 });
    const d = doc(t);
    expect(d.levels.timer).toEqual({ cautious: 30 });
    expect(d.levels.headsUp).toEqual({ cautious: 10 });
    expect(skip(t)).toBe(true);
  });
});
