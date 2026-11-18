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
