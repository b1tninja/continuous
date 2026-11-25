import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  type BuiltinRuleId,
  type PolicyArea,
  type PolicyLevels,
} from "./policy";
import { noChecksOn } from "./safetyDegrees";

/**
 * The words a session says when IDGAF is in force (plans/decisions-2026-11-15.md,
 * D-001, D-002 and B21), shared by the IDE and `cn` so the two say the same
 * thing. They are notices only: nothing here asks or refuses.
 */

/** The areas where a rule or a lock would otherwise stop a tool call. */
const RULE_AREAS: readonly PolicyArea[] = ["context", "tools", "edits"];

/**
 * The areas the IDGAF preset is in force for, in the order of POLICY_AREAS: all
 * of them while no safety check is on, none otherwise. IDGAF is not a level;
 * it is Permissive with every switch off, so the switches say whether it is on.
 */
export function idgafAreasOf(
  _levels: Partial<PolicyLevels>,
  builtin: Partial<Record<BuiltinRuleId, boolean>> | undefined,
): PolicyArea[] {
  return noChecksOn(builtin) ? [...POLICY_AREAS] : [];
}

/**
 * What still holds and what does not. With no check on, your rules, locked
 * rules and protected files stop nothing. A tool you switched off is not
 * offered at all, so it stays off.
 */
export const IDGAF_RULES_SENTENCE =
  "no safety check is on, so rules, protected files and locks stop nothing. Tools you switched off stay off. Turn a check back on in Settings.";

/** At IDGAF on Plan edits or Questions only: no rule is involved. */
export const IDGAF_NOBODY_ASKED_SENTENCE =
  "the agent answers its own questions and plans go on without you.";

/**
 * The one line a session starts with while an area is at IDGAF, said once.
 * `source` is what turned it on ("--auto", "--policy idgaf") when that is known.
 */
export function idgafStartLine(args: {
  areas: readonly PolicyArea[];
  source?: string;
}): string {
  const all = args.areas.length === POLICY_AREAS.length;
  const which = all
    ? "IDGAF is on"
    : `IDGAF is on for ${args.areas.map((a) => POLICY_AREA_LABELS[a]).join(", ")}`;
  const by = args.source ? ` (${args.source})` : "";
  const rules = args.areas.some((a) => RULE_AREAS.includes(a));
  return `${which}${by}: ${rules ? IDGAF_RULES_SENTENCE : IDGAF_NOBODY_ASKED_SENTENCE}`;
}
