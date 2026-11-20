import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import {
  builtinAfterApplying,
  builtinForLevels,
  builtinToSave,
  isIdgafPreset,
  presetLabelOf,
} from "./presetChecks";

describe("builtinForLevels", () => {
  it("gives each preset its own checks", () => {
    for (const name of Object.keys(
      POLICY_PRESETS,
    ) as (keyof typeof POLICY_PRESETS)[]) {
      expect(builtinForLevels(POLICY_PRESETS[name].levels)).toEqual(
        builtinForPreset(name),
      );
    }
  });

  it("gives nothing for levels that are not a preset", () => {
    expect(
      builtinForLevels({ ...DEFAULT_POLICY_LEVELS, tools: "permissive" }),
    ).toBeUndefined();
  });
});

describe("builtinAfterApplying", () => {
  const mine = { "ask-large-change": false } as const;

  it("takes the preset's checks, replacing the person's", () => {
    expect(
      builtinAfterApplying(POLICY_PRESETS.idgaf.levels, { ...mine }),
    ).toEqual(builtinForPreset("idgaf"));
    expect(
      builtinAfterApplying(POLICY_PRESETS.careful.levels, { ...mine }),
    ).toEqual({});
  });

  it("keeps the person's checks for levels that are not a preset", () => {
    // Not any preset: Tool use and Plan edits differ from every one of them
    const custom = {
      ...DEFAULT_POLICY_LEVELS,
      tools: "permissive" as const,
      plan: "manual" as const,
    };
    expect(builtinAfterApplying(custom, { ...mine })).toEqual(mine);
    expect(builtinAfterApplying(custom, undefined)).toBeUndefined();
  });
});

describe("isIdgafPreset and presetLabelOf", () => {
  it("knows the IDGAF preset", () => {
    expect(isIdgafPreset(POLICY_PRESETS.idgaf.levels)).toBe(true);
    expect(isIdgafPreset(POLICY_PRESETS.careful.levels)).toBe(false);
    expect(presetLabelOf(POLICY_PRESETS.handsOff.levels)).toBe("Hands off");
    expect(presetLabelOf({ ...DEFAULT_POLICY_LEVELS, tools: "idgaf" })).toBe(
      "",
    );
  });
});

describe("builtinToSave: IDGAF's checks are never written", () => {
  const before = { "ask-large-change": false } as const;

  it("writes the current switches while some check is on", () => {
    expect(builtinToSave({ "protect-secrets": false }, { ...before })).toEqual({
      "protect-secrets": false,
    });
    expect(builtinToSave(undefined, { ...before })).toBeUndefined();
    expect(builtinToSave({}, { ...before })).toEqual({});
  });

  it("writes what the file had while no check is on, so IDGAF is session-only", () => {
    expect(builtinToSave(builtinForPreset("idgaf"), { ...before })).toEqual(
      before,
    );
    expect(builtinToSave(builtinForPreset("idgaf"), undefined)).toBeUndefined();
  });
});
