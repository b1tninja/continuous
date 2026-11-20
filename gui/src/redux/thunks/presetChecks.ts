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
 * The switches to write to the file. While no check is on (the IDGAF preset),
 * the file keeps what it had: that state lasts for the session only.
 * `saved` is what the switches were before IDGAF was picked.
 */
export function builtinToSave(
  current: Builtin | undefined,
  saved: Builtin | undefined,
): Builtin | undefined {
  return noChecksOn(current) ? saved : current;
}

/** The preset name in plain words for a message; empty when the levels are not a preset. */
export function presetLabelOf(levels: PolicyLevels): string {
  const name = presetOf(levels);
  return name ? POLICY_PRESETS[name].label : "";
}
