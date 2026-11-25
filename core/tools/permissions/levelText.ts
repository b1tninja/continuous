/**
 * Level spellings, with no other imports. The GUI reads these while the rest
 * of the policy module is still loading, so they live here.
 */

/**
 * Who decides what the rules leave open: you every time, you unless a rule
 * covers it, the agent, or a reviewer model (Automatic is about review). A
 * fifth, `delegate`, is for Questions only: the agent makes every decision for
 * you. That is decision making, not review, so it is not Automatic. IDGAF is
 * a preset (Permissive plus every safety switch off), not a level; nothing
 * reads a level or a preset name to decide what is checked, each check has its
 * own switch.
 */
export type PolicyLevel =
  "manual" | "cautious" | "permissive" | "automatic" | "delegate";

/**
 * In the order a list shows them: you decide, you decide unless a rule covers
 * it, the agent decides, a reviewer decides, and (Questions only) the agent
 * decides everything. Automatic is not further along the same road as
 * Permissive: it is review, a different decider, so it has the same rank as
 * Permissive and neither counts as loosening the other (levelRank).
 */
export const POLICY_LEVELS: readonly PolicyLevel[] = [
  "manual",
  "cautious",
  "permissive",
  "automatic",
  "delegate",
];

const LEVEL_RANK: Readonly<Record<PolicyLevel, number>> = {
  manual: 0,
  cautious: 1,
  permissive: 2,
  automatic: 2,
  // Questions only: the agent decides everything, so the fewest reach you
  delegate: 3,
};

/**
 * How little a level asks of the person, for "is this change looser?". Equal
 * for Permissive and Automatic: moving between them hands decisions to a
 * different decider, it does not let more through. -1 for text that is not a level.
 */
export function levelRank(level: string | undefined): number {
  if (level === undefined) return -1;
  // A retired spelling ranks as the level it is read as
  const word = Object.hasOwn(DEPRECATED_LEVEL_ALIASES, level)
    ? DEPRECATED_LEVEL_ALIASES[level]
    : level;
  return Object.hasOwn(LEVEL_RANK, word) ? LEVEL_RANK[word as PolicyLevel] : -1;
}

/**
 * Spellings that are read as a level and never written. 2.14.x called the top
 * level `yolo` and later versions `idgaf`; both meant "the agent decides and
 * checks are off", which is Permissive with the switches a preset sets.
 */
export const DEPRECATED_LEVEL_ALIASES: Readonly<Record<string, PolicyLevel>> = {
  yolo: "permissive",
  idgaf: "permissive",
};

/** A level from stored or typed text: any case; `yolo` and `idgaf` read as `permissive`. */
export function parsePolicyLevel(value: unknown): PolicyLevel | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  const level = DEPRECATED_LEVEL_ALIASES[word] ?? word;
  return POLICY_LEVELS.includes(level as PolicyLevel)
    ? (level as PolicyLevel)
    : undefined;
}

/** True when the text names the retired top level (`yolo` or `idgaf`, any case). */
export function isRetiredTopLevel(value: unknown): boolean {
  return typeof value === "string" && isDeprecatedLevelSpelling(value);
}

/**
 * What a switched-on check would have done with a call: asked about it or
 * refused it, and why. One sentence for a decision's reason and a heads-up.
 */
export function wouldHaveSentence(lower: {
  policy: string;
  reason?: string;
}): string {
  const was = lower.policy === "disabled" ? "refused" : "asked";
  return `This call would have been ${was}${lower.reason ? `: ${lower.reason}` : "."}`;
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
