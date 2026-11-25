/**
 * What picking a preset does to the settings beside the levels, and what is
 * written to permissions.yaml. Pure, so the rules are tested without a store.
 *
 * A preset sets every knob: the five levels and the safety checks (the
 * `builtin` switches). Nothing about IDGAF is special here: it is a preset like
 * the others, its switches are saved like theirs, and no later code asks
 * whether it is "on". The switches are the state.
 */
import {
  POLICY_PRESETS,
  presetOf,
  type BuiltinRuleId,
  type PolicyLevels,
  type PolicyPresetName,
} from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";

export type Builtin = Partial<Record<BuiltinRuleId, boolean>>;

/** The levels and switches a preset sets. */
export function settingsOfPreset(name: PolicyPresetName): {
  levels: PolicyLevels;
  builtin: Builtin;
} {
  return {
    levels: { ...POLICY_PRESETS[name].levels },
    builtin: builtinForPreset(name),
  };
}

/**
 * The switches after a set of levels is applied with no preset name (a
 * recalled custom set): what the person had, since levels alone never say
 * which switches go with them.
 */
export function builtinAfterApplyingLevels(
  current: Builtin | undefined,
): Builtin | undefined {
  return current;
}

/** The preset name in plain words for a message; empty when it is no preset. */
export function presetLabelOf(levels: PolicyLevels, builtin?: Builtin): string {
  const name = presetOf(levels, builtin);
  return name ? POLICY_PRESETS[name].label : "";
}
