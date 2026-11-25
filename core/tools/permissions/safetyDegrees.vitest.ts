import { describe, expect, it } from "vitest";
import {
  BUILTIN_RULES,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  presetOf,
  PRESET_FREE_RULES,
  type BuiltinRuleId,
} from "./policy";
import {
  builtinForDegree,
  builtinForPreset,
  CHECKS_ON,
  HARD_PROTECTIONS,
  noChecksOn,
  safetyLabel,
  safetyOfPreset,
  safetyStateOf,
  type SafetyDegree,
} from "./safetyDegrees";

// The checks a preset sets; the rules the person owns are left to them
const ids = BUILTIN_RULES.filter((r) => !PRESET_FREE_RULES.has(r.id)).map(
  (r) => r.id,
);
const DEGREES: SafetyDegree[] = ["all", "some", "few", "none"];

describe("the degrees", () => {
  it("only name checks that exist, with no repeats", () => {
    for (const d of DEGREES) {
      expect(new Set(CHECKS_ON[d]).size).toBe(CHECKS_ON[d].length);
      for (const id of CHECKS_ON[d]) expect(ids).toContain(id);
    }
  });

  it("each has strictly fewer checks than the one before", () => {
    const sizes = DEGREES.map((d) => CHECKS_ON[d].length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(new Set(sizes).size).toBe(sizes.length);
    expect(CHECKS_ON.all).toHaveLength(ids.length);
    expect(CHECKS_ON.none).toHaveLength(0);
  });

  it("each is inside the one before, so a looser preset never turns a check on", () => {
    for (let i = 1; i < DEGREES.length; i++) {
      for (const id of CHECKS_ON[DEGREES[i]]) {
        expect(CHECKS_ON[DEGREES[i - 1]]).toContain(id);
      }
    }
  });

  it("the hard protections stay on until the last degree", () => {
    for (const d of ["all", "some", "few"] as const) {
      for (const id of HARD_PROTECTIONS) expect(CHECKS_ON[d]).toContain(id);
    }
  });
});

describe("presets", () => {
  it("every preset has a degree, and IDGAF leaves none on", () => {
    for (const p of POLICY_PRESET_ORDER)
      expect(safetyOfPreset(p)).toBeDefined();
    expect(safetyOfPreset("idgaf")).toBe("none");
    expect(safetyOfPreset("careful")).toBe("all");
    expect(noChecksOn(builtinForPreset("idgaf"))).toBe(true);
  });

  it("a looser preset never has more checks on than a stricter one", () => {
    const order = [
      "careful",
      "acceptEdits",
      "reviewer",
      "handsOff",
      "idgaf",
    ] as const;
    const counts = order.map((p) => CHECKS_ON[safetyOfPreset(p)].length);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe("builtinForDegree: the stored form", () => {
  it("is empty for all on, since absent means on", () => {
    expect(builtinForDegree("all")).toEqual({});
  });
  it("lists every check for none on, all false", () => {
    const none = builtinForDegree("none");
    expect(Object.keys(none).sort()).toEqual([...ids].sort());
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });
  it("lists exactly the checks that are not on", () => {
    for (const d of DEGREES) {
      const off = Object.keys(builtinForDegree(d));
      const on = ids.filter((id) => !off.includes(id));
      expect([...on].sort()).toEqual([...CHECKS_ON[d]].sort());
    }
  });
});

describe("safetyStateOf and safetyLabel", () => {
  it("round-trips every degree", () => {
    for (const d of DEGREES) {
      expect(safetyStateOf(builtinForDegree(d)).degree).toBe(d);
    }
  });
  it("reads an undefined map as all on", () => {
    expect(safetyStateOf(undefined)).toMatchObject({
      degree: "all",
      on: ids.length,
      total: ids.length,
    });
  });
  it("calls a set that matches no degree custom, with the count", () => {
    const custom = { "ask-large-change": false } as Partial<
      Record<BuiltinRuleId, boolean>
    >;
    expect(safetyStateOf(custom).degree).toBe("custom");
    expect(safetyLabel(custom)).toBe(`${ids.length - 1} of ${ids.length} on`);
  });
  it("words each degree", () => {
    expect(safetyLabel(undefined)).toBe("All on");
    expect(safetyLabel(builtinForDegree("some"))).toBe("Some on");
    expect(safetyLabel(builtinForDegree("few"))).toBe("A few on");
    expect(safetyLabel(builtinForDegree("none"))).toBe("None on");
  });
});

describe("noChecksOn", () => {
  it("is true only when every check is off", () => {
    expect(noChecksOn(builtinForDegree("none"))).toBe(true);
    expect(noChecksOn(builtinForDegree("few"))).toBe(false);
    expect(noChecksOn(undefined)).toBe(false);
    expect(noChecksOn({})).toBe(false);
  });
});

describe("the switches are the state, whatever the levels are", () => {
  it("Hands off keeps its checks and IDGAF has none on", () => {
    expect(noChecksOn(builtinForPreset("handsOff"))).toBe(false);
    expect(noChecksOn(builtinForPreset("idgaf"))).toBe(true);
  });

  it("the levels of IDGAF are the IDGAF preset only while no check is on", () => {
    const levels = POLICY_PRESETS.idgaf.levels;
    expect(presetOf(levels, builtinForPreset("idgaf"))).toBe("idgaf");
    // With nothing to go on but the levels, they are IDGAF's
    expect(presetOf(levels)).toBe("idgaf");
  });

  it("one switch turned back on makes it Custom, not IDGAF", () => {
    const one = { ...builtinForPreset("idgaf"), "protect-secrets": true };
    expect(noChecksOn(one)).toBe(false);
    expect(presetOf(POLICY_PRESETS.idgaf.levels, one)).toBeUndefined();
    expect(safetyStateOf(one).on).toBe(1);
  });

  it("other presets do not care which switches are on: the person may set them", () => {
    const some = { ...builtinForPreset("careful"), "ask-large-change": false };
    expect(presetOf(POLICY_PRESETS.careful.levels, some)).toBe("careful");
    expect(presetOf(POLICY_PRESETS.handsOff.levels, some)).toBe("handsOff");
  });

  it("every check the engine reads is covered by a preset, so none can be left on by accident", () => {
    const off = builtinForPreset("idgaf");
    for (const id of ids) expect(off[id], id).toBe(false);
  });

  it("the checks added for what used to be level overrides are all in the list", () => {
    for (const id of [
      "apply-rules",
      "protect-policy-files",
      "hold-plan-mode",
      "ask-odd-paths",
      "refuse-unsafe-urls",
      "approve-mcp-tools",
    ] as const) {
      expect(ids, id).toContain(id);
      expect(builtinForPreset("idgaf")[id], id).toBe(false);
      expect(CHECKS_ON.all, id).toContain(id);
    }
  });

  it("ask-runtime-writes is the person's own choice: no preset sets it", () => {
    expect(ids).not.toContain("ask-runtime-writes");
    expect(builtinForPreset("idgaf")).not.toHaveProperty("ask-runtime-writes");
    expect(builtinForPreset("careful")).not.toHaveProperty(
      "ask-runtime-writes",
    );
  });
});
