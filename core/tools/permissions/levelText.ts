/**
 * Level spellings, with no other imports. The GUI reads these while the rest
 * of the policy module is still loading, so they live here.
 */

/** The top level, IDGAF, is the same on every area. */
export type PolicyLevel =
  "manual" | "cautious" | "automatic" | "permissive" | "idgaf";

export const POLICY_LEVELS: readonly PolicyLevel[] = [
  "manual",
  "cautious",
  "automatic",
  "permissive",
  "idgaf",
];

/**
 * What each level does with a call something would have asked about or
 * refused (a rule, a guard, a check, Plan mode's hold). Levels that ask can
 * have a window for their asks. The top level never asks: it runs the call
 * and the decision records what it overrode.
 */
const LEVEL_TRAITS: Readonly<
  Record<PolicyLevel, { asks: boolean; runsHeld: boolean }>
> = {
  manual: { asks: true, runsHeld: false },
  cautious: { asks: true, runsHeld: false },
  automatic: { asks: true, runsHeld: false },
  permissive: { asks: true, runsHeld: false },
  idgaf: { asks: false, runsHeld: true },
};

/** The level can leave a call waiting for the person. */
export function levelAsks(level: PolicyLevel): boolean {
  return LEVEL_TRAITS[level].asks;
}

/**
 * The level runs a call that a lower level would have asked about or refused,
 * and records what it overrode. Text that is not a level does not.
 */
export function levelRunsHeld(level: unknown): boolean {
  return (
    typeof level === "string" &&
    Object.hasOwn(LEVEL_TRAITS, level) &&
    LEVEL_TRAITS[level as PolicyLevel].runsHeld
  );
}

/**
 * What a level below the top one would have done with a call the top level
 * ran: asked about it or refused it, and why. One sentence, the same in the
 * decision's reason, the audit trail and a heads-up on the call.
 */
export function wouldHaveSentence(lower: {
  policy: string;
  reason?: string;
}): string {
  const was = lower.policy === "disabled" ? "refused" : "asked";
  return `Below IDGAF this call would have been ${was}${lower.reason ? `: ${lower.reason}` : "."}`;
}

/**
 * Spellings that are read as a level and never written. 2.14.x called the top
 * level `yolo` (and `IDGAF` on Plan edits and Questions only).
 */
export const DEPRECATED_LEVEL_ALIASES: Readonly<Record<string, PolicyLevel>> = {
  yolo: "idgaf",
};

/** A level from stored or typed text: any case, `yolo` read as `idgaf`. */
export function parsePolicyLevel(value: unknown): PolicyLevel | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  const level = DEPRECATED_LEVEL_ALIASES[word] ?? word;
  return POLICY_LEVELS.includes(level as PolicyLevel)
    ? (level as PolicyLevel)
    : undefined;
}

/** True when the text spells a level the way 2.14.x did (`yolo`, any case). */
export function isDeprecatedLevelSpelling(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Object.hasOwn(DEPRECATED_LEVEL_ALIASES, value.trim().toLowerCase())
  );
}

/**
 * Text written by 2.14.x (an audit reason, a saved notice) with the old name
 * of the top level replaced, for display. The stored text is not changed.
 */
export function modernizeLevelText(text: string): string {
  return text.replace(/\bYOLO\b/g, "IDGAF").replace(/\byolo\b/g, "idgaf");
}
