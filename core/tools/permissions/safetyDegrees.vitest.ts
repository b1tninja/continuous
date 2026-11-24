import { describe, expect, it } from "vitest";
import {
  BUILTIN_RULES,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
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
  switchesInForce,
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

describe("switchesInForce", () => {
  const fileSays = { "ask-large-change": false } as const;
  const lv = (over: Record<string, string>) =>
    ({ ...POLICY_PRESETS.careful.levels, ...over }) as never;

  it("is the file's switches for ordinary levels", () => {
    expect(switchesInForce(POLICY_PRESETS.careful.levels, fileSays)).toEqual(
      fileSays,
    );
    expect(switchesInForce(POLICY_PRESETS.handsOff.levels, undefined)).toBe(
      undefined,
    );
  });

  it("is no check on for the IDGAF preset", () => {
    const s = switchesInForce(POLICY_PRESETS.idgaf.levels, fileSays);
    expect(noChecksOn(s)).toBe(true);
  });

  it("is no check on when every tool area is at IDGAF, as --auto sets them", () => {
    const s = switchesInForce(
      lv({ context: "idgaf", tools: "idgaf", edits: "idgaf" }),
      undefined,
    );
    expect(noChecksOn(s)).toBe(true);
  });

  it("keeps the file's switches while any tool area is below IDGAF", () => {
    for (const area of ["context", "tools", "edits"]) {
      const levels = lv({
        context: "idgaf",
        tools: "idgaf",
        edits: "idgaf",
        [area]: "permissive",
      });
      expect(switchesInForce(levels, fileSays)).toEqual(fileSays);
    }
  });

  it("a check the file names as on stays on under IDGAF", () => {
    const s = switchesInForce(POLICY_PRESETS.idgaf.levels, {
      "protect-secrets": true,
      "ask-large-change": false,
    });
    expect(s?.["protect-secrets"]).toBeUndefined();
    expect(s?.["ask-large-change"]).toBe(false);
    expect(safetyStateOf(s).on).toBe(1);
  });

  it("a check merely absent from the file does not come back under IDGAF", () => {
    const s = switchesInForce(POLICY_PRESETS.idgaf.levels, {});
    expect(noChecksOn(s)).toBe(true);
  });

  it("does not let Plan edits or Questions alone turn the checks off", () => {
    expect(
      switchesInForce(lv({ plan: "idgaf", questions: "idgaf" }), fileSays),
    ).toEqual(fileSays);
  });
});
