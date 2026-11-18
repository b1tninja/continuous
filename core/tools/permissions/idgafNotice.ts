import {
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  type PolicyArea,
  type PolicyLevels,
  parsePolicyLevel,
} from "./policy";

/**
 * The words a session says when IDGAF is in force (plans/decisions-2026-11-15.md,
 * D-001, D-002 and B21), shared by the IDE and `cn` so the two say the same
 * thing. They are notices only: nothing here asks or refuses.
 */

/** The areas where a rule or a lock would otherwise stop a tool call. */
const RULE_AREAS: readonly PolicyArea[] = ["context", "tools", "edits"];

/** The areas at IDGAF, in the order of POLICY_AREAS. */
export function idgafAreasOf(levels: Partial<PolicyLevels>): PolicyArea[] {
  return POLICY_AREAS.filter(
    (a: PolicyArea) => parsePolicyLevel(levels[a]) === "idgaf",
  );
}

/**
 * What still holds and what does not. IDGAF never refuses or asks (2.16.2):
 * your rules, locked rules and protected files are recorded, not applied. A
 * tool you switched off is not offered at all, so it stays off.
 */
export const IDGAF_RULES_SENTENCE =
  "your rules, locked rules and protected files stop nothing; each call runs and the audit trail records what would have stopped it. Tools you switched off stay off.";

/** At IDGAF on Plan edits or Questions only: no rule is involved. */
export const IDGAF_NOBODY_ASKED_SENTENCE =
  "the agent answers its own questions and plans go on without you.";

/**
 * The one line a session starts with while an area is at IDGAF, said once.
 * IDGAF is never saved, so it is always for this session only; `source` is
 * what turned it on ("--auto", "--policy idgaf") when that is known.
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
  return `${which} for this session only${by}: ${rules ? IDGAF_RULES_SENTENCE : IDGAF_NOBODY_ASKED_SENTENCE}`;
}
