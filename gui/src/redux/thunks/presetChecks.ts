/**
 * What picking a preset does to the settings beside the levels, and what is
 * written to permissions.yaml. Pure, so the rules are tested without a store.
 *
 * A preset sets every knob: the five levels and the safety checks (the
 * `builtin` switches). IDGAF is session-only, like its levels: the checks it
 * turns off are never written to the file, so the next editor session starts
 * at the checks the person had before.
 */
import {
  POLICY_PRESETS,
  presetOf,
  type BuiltinRuleId,
  type PolicyLevels,
  type PolicyPresetName,
} from "core/tools/permissions/policy";
import {
  builtinForPreset,
  noChecksOn,
} from "core/tools/permissions/safetyDegrees";

export type Builtin = Partial<Record<BuiltinRuleId, boolean>>;

/** The switches that go with these levels when they are exactly a preset's; undefined otherwise. */
export function builtinForLevels(levels: PolicyLevels): Builtin | undefined {
  const name: PolicyPresetName | undefined = presetOf(levels);
  return name ? builtinForPreset(name) : undefined;
}

/**
 * The switches after applying `levels`: a preset's own set, or what the person
 * had when the levels are not a preset (a recalled custom set, say).
 */
export function builtinAfterApplying(
  levels: PolicyLevels,
  current: Builtin | undefined,
): Builtin | undefined {
  return builtinForLevels(levels) ?? current;
}

/** True when the levels are the IDGAF preset. */
export function isIdgafPreset(levels: PolicyLevels): boolean {
  return presetOf(levels) === "idgaf";
}

/**
 * The switches to write to the file. While the IDGAF preset is in force,
 * `saved` holds what the switches were before it was picked, and that is what
 * the file keeps: IDGAF lasts for the session only. Otherwise the current ones.
 */
export function builtinToSave(
  current: Builtin | undefined,
  saved: Builtin | undefined,
): Builtin | undefined {
  return saved !== undefined ? saved : current;
}

export interface CheckState {
  builtin: Builtin | undefined;
  /** What the file has while the IDGAF preset is in force; undefined otherwise */
  savedBuiltin: Builtin | undefined;
}

/**
 * The switches and the stash after applying `levels`. A preset sets its own
 * checks; entering the IDGAF preset stashes what the switches were (what the
 * file has), leaving it drops the stash; levels that are no preset change
 * nothing.
 */
export function afterApplying(
  levels: PolicyLevels,
  now: CheckState,
): CheckState {
  const preset = presetOf(levels);
  if (!preset) return now;
  if (preset === "idgaf") {
    return {
      builtin: builtinForPreset("idgaf"),
      // already inside the IDGAF preset: keep the original stash
      savedBuiltin: now.savedBuiltin ?? now.builtin ?? {},
    };
  }
  return { builtin: builtinForPreset(preset), savedBuiltin: undefined };
}

/**
 * The state after the file is read. Levels restored as the IDGAF preset (a
 * webview reload in the middle of a run) bring its checks back off, with the
 * file's switches stashed.
 */
export function afterLoading(
  levels: PolicyLevels,
  fromFile: Builtin | undefined,
): CheckState {
  return isIdgafPreset(levels)
    ? { builtin: builtinForPreset("idgaf"), savedBuiltin: fromFile ?? {} }
    : { builtin: fromFile ?? {}, savedBuiltin: undefined };
}

/** The preset name in plain words for a message; empty when the levels are not a preset. */
export function presetLabelOf(levels: PolicyLevels): string {
  const name = presetOf(levels);
  return name ? POLICY_PRESETS[name].label : "";
}
