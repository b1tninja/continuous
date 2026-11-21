import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import { noChecksOn } from "core/tools/permissions/safetyDegrees";
import {
  afterApplying,
  afterLoading,
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

  it("writes the current switches when nothing is stashed", () => {
    expect(builtinToSave({ "protect-secrets": false }, undefined)).toEqual({
      "protect-secrets": false,
    });
    expect(builtinToSave(undefined, undefined)).toBeUndefined();
    expect(builtinToSave({}, undefined)).toEqual({});
  });

  it("writes the stash while the IDGAF preset is in force, whatever the switches are", () => {
    expect(builtinToSave(builtinForPreset("idgaf"), { ...before })).toEqual(
      before,
    );
    // even after the person turned one check back on in the session
    expect(
      builtinToSave(
        { ...builtinForPreset("idgaf"), "protect-secrets": true },
        {
          ...before,
        },
      ),
    ).toEqual(before);
    // an empty stash is a real value: the file had every check on
    expect(builtinToSave(builtinForPreset("idgaf"), {})).toEqual({});
  });
});

describe("afterApplying", () => {
  const file = { "ask-large-change": false } as const;

  it("a preset sets its checks and drops any stash", () => {
    const s = afterApplying(POLICY_PRESETS.handsOff.levels, {
      builtin: { ...file },
      savedBuiltin: { ...file },
    });
    expect(s.builtin).toEqual(builtinForPreset("handsOff"));
    expect(s.savedBuiltin).toBeUndefined();
  });

  it("entering IDGAF stashes what the file has and turns every check off", () => {
    const s = afterApplying(POLICY_PRESETS.idgaf.levels, {
      builtin: { ...file },
      savedBuiltin: undefined,
    });
    expect(noChecksOn(s.builtin)).toBe(true);
    expect(s.savedBuiltin).toEqual(file);
  });

  it("applying IDGAF again keeps the first stash, not the all-off set", () => {
    const first = afterApplying(POLICY_PRESETS.idgaf.levels, {
      builtin: { ...file },
      savedBuiltin: undefined,
    });
    const again = afterApplying(POLICY_PRESETS.idgaf.levels, first);
    expect(again.savedBuiltin).toEqual(file);
  });

  it("no checks stashed means an empty stash, which still marks the session", () => {
    const s = afterApplying(POLICY_PRESETS.idgaf.levels, {
      builtin: undefined,
      savedBuiltin: undefined,
    });
    expect(s.savedBuiltin).toEqual({});
  });

  it("levels that are no preset change nothing", () => {
    const now = { builtin: { ...file }, savedBuiltin: undefined };
    const custom = {
      ...DEFAULT_POLICY_LEVELS,
      tools: "permissive" as const,
      plan: "manual" as const,
    };
    expect(afterApplying(custom, now)).toBe(now);
  });

  it("leaving IDGAF for Careful restores all on and drops the stash", () => {
    const inIdgaf = afterApplying(POLICY_PRESETS.idgaf.levels, {
      builtin: { ...file },
      savedBuiltin: undefined,
    });
    const out = afterApplying(POLICY_PRESETS.careful.levels, inIdgaf);
    expect(out.builtin).toEqual({});
    expect(out.savedBuiltin).toBeUndefined();
  });
});

describe("afterLoading", () => {
  const file = { "ask-large-change": false } as const;

  it("ordinary levels read the file's switches", () => {
    expect(afterLoading(POLICY_PRESETS.careful.levels, { ...file })).toEqual({
      builtin: file,
      savedBuiltin: undefined,
    });
    expect(
      afterLoading(POLICY_PRESETS.careful.levels, undefined).builtin,
    ).toEqual({});
  });

  it("levels restored as the IDGAF preset bring its checks back off", () => {
    const s = afterLoading(POLICY_PRESETS.idgaf.levels, { ...file });
    expect(noChecksOn(s.builtin)).toBe(true);
    expect(s.savedBuiltin).toEqual(file);
  });

  it("a restored area or two at IDGAF is not the preset", () => {
    const some = { ...POLICY_PRESETS.careful.levels, tools: "idgaf" as const };
    expect(afterLoading(some, { ...file }).builtin).toEqual(file);
  });
});
