/**
 * How many of the safety checks a preset leaves on. A preset sets every knob,
 * the checks included: the five levels and the eleven switches (`builtin`).
 * Picking IDGAF therefore leaves no check on, and nothing is inferred from
 * the levels afterwards. Each check is still its own switch, so one can be
 * flipped on or off after a preset.
 */
import {
  BUILTIN_RULES,
  POLICY_PRESETS,
  PRESET_FREE_RULES,
  type BuiltinRuleId,
  type PolicyLevels,
  type PolicyPresetName,
} from "./policy";

export type SafetyDegree = "all" | "some" | "few" | "none";

/** Credentials, config that runs later, network paths, dangerous commands, run-a-download. */
export const HARD_PROTECTIONS: readonly BuiltinRuleId[] = [
  "protect-secrets",
  "protect-config",
  "protect-network-paths",
  "refuse-dangerous-commands",
  "no-fetch-and-run",
  "protect-policy-files",
  "apply-rules",
  "hold-plan-mode",
  "ask-odd-paths",
  "refuse-unsafe-urls",
  "approve-mcp-tools",
];

/** Asked about before work is lost, a dependency changes or a new host is contacted. */
const COMMON_ASKS: readonly BuiltinRuleId[] = [
  "ask-destructive-commands",
  "ask-dependency-change",
  "ask-unknown-host",
];

// The checks a preset sets. A rule no preset sets (policy.ts) is the person's
// own choice and no preset turns it on or off.
const ALL_CHECKS: readonly BuiltinRuleId[] = BUILTIN_RULES.filter(
  (r) => !PRESET_FREE_RULES.has(r.id),
).map((r) => r.id);

/** The checks each degree leaves on. */
export const CHECKS_ON: Record<SafetyDegree, readonly BuiltinRuleId[]> = {
  all: ALL_CHECKS,
  some: [...HARD_PROTECTIONS, ...COMMON_ASKS],
  few: HARD_PROTECTIONS,
  none: [],
};

export const SAFETY_DEGREE_LABELS: Record<SafetyDegree, string> = {
  all: "All on",
  some: "Some on",
  few: "A few on",
  none: "None on",
};

/** The degree each preset sets: it is part of the preset's definition. */
export function safetyOfPreset(preset: PolicyPresetName): SafetyDegree {
  return POLICY_PRESETS[preset].safety;
}

/**
 * The stored form of a degree: `builtin` holds only the checks that are off
 * (absent means on), so "all" is an empty map.
 */
export function builtinForDegree(
  degree: SafetyDegree,
): Partial<Record<BuiltinRuleId, false>> {
  const on = new Set(CHECKS_ON[degree]);
  const off: Partial<Record<BuiltinRuleId, false>> = {};
  for (const id of ALL_CHECKS) if (!on.has(id)) off[id] = false;
  return off;
}

/** The stored switches a preset sets. */
export function builtinForPreset(
  preset: PolicyPresetName,
): Partial<Record<BuiltinRuleId, false>> {
  return builtinForDegree(safetyOfPreset(preset));
}

export interface SafetyState {
  /** The degree the switches amount to, or "custom" when none matches */
  degree: SafetyDegree | "custom";
  on: number;
  total: number;
}

export function safetyStateOf(
  builtin: Partial<Record<BuiltinRuleId, boolean>> | undefined,
): SafetyState {
  const on = ALL_CHECKS.filter((id) => builtin?.[id] !== false);
  const degree =
    (Object.keys(CHECKS_ON) as SafetyDegree[]).find(
      (d) =>
        CHECKS_ON[d].length === on.length &&
        CHECKS_ON[d].every((id) => on.includes(id)),
    ) ?? "custom";
  return { degree, on: on.length, total: ALL_CHECKS.length };
}

/** "All on", "Some on", "A few on", "None on", or "4 of 11 on" for a custom set. */
export function safetyLabel(
  builtin: Partial<Record<BuiltinRuleId, boolean>> | undefined,
): string {
  const s = safetyStateOf(builtin);
  return s.degree === "custom"
    ? `${s.on} of ${s.total} on`
    : SAFETY_DEGREE_LABELS[s.degree];
}

/** True when not one safety check is on, as after the IDGAF preset. */
export function noChecksOn(
  builtin: Partial<Record<BuiltinRuleId, boolean>> | undefined,
): boolean {
  return ALL_CHECKS.every((id) => builtin?.[id] === false);
}

/**
 * What picking a preset sets: its five levels and its safety checks together,
 * so the checks are never inferred from the levels afterwards.
 */
export function approvalOfPreset(preset: PolicyPresetName): {
  levels: PolicyLevels;
  builtin: Partial<Record<BuiltinRuleId, false>>;
} {
  return {
    levels: { ...POLICY_PRESETS[preset].levels },
    builtin: builtinForPreset(preset),
  };
}
