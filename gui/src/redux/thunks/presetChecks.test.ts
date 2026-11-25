import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESET_ORDER,
  POLICY_PRESETS,
  presetOf,
} from "core/tools/permissions/policy";
import {
  builtinForPreset,
  noChecksOn,
} from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import { presetLabelOf, settingsOfPreset } from "./presetChecks";

describe("settingsOfPreset", () => {
  it("gives each preset its own levels and its own switches", () => {
    for (const name of POLICY_PRESET_ORDER) {
      const s = settingsOfPreset(name);
      expect(s.levels, name).toEqual(POLICY_PRESETS[name].levels);
      expect(s.builtin, name).toEqual(builtinForPreset(name));
    }
  });

  it("hands back copies, so a caller cannot change the preset", () => {
    const a = settingsOfPreset("careful");
    a.levels.tools = "permissive";
    a.builtin["protect-secrets"] = false;
    expect(POLICY_PRESETS.careful.levels.tools).not.toBe("permissive");
    expect(settingsOfPreset("careful").builtin["protect-secrets"]).not.toBe(
      false,
    );
  });

  it("IDGAF is Permissive with no check on: nothing else about it is special", () => {
    const s = settingsOfPreset("idgaf");
    expect(noChecksOn(s.builtin)).toBe(true);
    for (const area of ["context", "tools", "edits", "plan"] as const) {
      expect(s.levels[area], area).toBe("permissive");
    }
    // Questions is a delegated decision, not a safety check: the preset leaves it
    expect(s.levels.questions).toBe(DEFAULT_POLICY_LEVELS.questions);
  });

  it("every other preset leaves a check on", () => {
    for (const name of POLICY_PRESET_ORDER.filter((n) => n !== "idgaf")) {
      expect(noChecksOn(settingsOfPreset(name).builtin), name).toBe(false);
    }
  });

  it("round-trips: the preset it came from is the preset it reads as", () => {
    for (const name of POLICY_PRESET_ORDER) {
      const s = settingsOfPreset(name);
      expect(presetOf(s.levels, s.builtin), name).toBe(name);
    }
  });
});

describe("presetLabelOf", () => {
  it("names the preset the levels are", () => {
    expect(presetLabelOf(POLICY_PRESETS.handsOff.levels)).toBe("Hands off");
    expect(presetLabelOf(POLICY_PRESETS.careful.levels)).toBe("Careful");
  });

  it("is empty for levels that are no preset", () => {
    expect(
      presetLabelOf({
        ...DEFAULT_POLICY_LEVELS,
        tools: "permissive",
        plan: "manual",
      }),
    ).toBe("");
  });

  it("says IDGAF only while no check is on", () => {
    const levels = POLICY_PRESETS.idgaf.levels;
    expect(presetLabelOf(levels, builtinForPreset("idgaf"))).toBe("IDGAF");
    expect(
      presetLabelOf(levels, {
        ...builtinForPreset("idgaf"),
        "protect-secrets": true,
      }),
    ).toBe("");
  });
});
