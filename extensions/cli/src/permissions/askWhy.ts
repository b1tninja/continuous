import type { SuggestedRule } from "core/tools/permissions/suggest.js";

/** Where an ask came from: a rule and its file, or a check and its id. */
export interface AskSource {
  /** What decided, in words. A check carries its id here, in brackets. */
  what: string;
  /** The rule as it is written */
  rule?: string;
  /** The file the rule is in, or a few words when it is not the person's file */
  file?: string;
}

/**
 * Why a call is waiting for the person, worked out where the decision is made
 * and shown by the prompt as it is.
 */
export interface AskWhy {
  /** One sentence: why this call asks */
  reason: string;
  source: AskSource;
  /**
   * The narrowest allow rule for this call, or why there is none: core's
   * `suggestAllowRule`, the function behind the IDE's "Always allow".
   */
  suggestion: SuggestedRule;
  /**
   * False when a check asked, not a missing rule: an allow rule would not stop
   * it, and the prompt says so beside the rule.
   */
  ruleStopsAsk: boolean;
}

/**
 * `abcdef…uvwxyz`: both ends kept. `tailShare` is how much of what is kept
 * comes from the end: a path is told apart by its file name, a rule by how
 * it starts.
 */
export function truncateMiddle(
  text: string,
  max: number,
  tailShare = 0.5,
): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const tail = Math.floor((max - 1) * tailShare);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}

const PATH_TAIL_SHARE = 0.75;

/**
 * The source on one line. With `max`, a long rule and a long path are cut in
 * the middle so the line fits; without it, the text is whole.
 */
export function askSourceText(
  source: AskSource,
  max: number = Infinity,
): string {
  let { rule, file } = source;
  const fixed =
    source.what.length + (rule ? 1 : 0) + (file ? " in ".length : 0);
  const room = Math.max(8, max - fixed);
  const ruleLength = rule?.length ?? 0;
  const fileLength = file?.length ?? 0;
  if (ruleLength + fileLength > room) {
    const half = Math.floor(room / 2);
    if (rule && file) {
      // The shorter one stays whole when it fits in its half
      const ruleMax =
        ruleLength <= half
          ? ruleLength
          : Math.max(half, room - Math.min(fileLength, room - half));
      rule = truncateMiddle(rule, ruleMax);
      file = truncateMiddle(file, room - rule.length, PATH_TAIL_SHARE);
    } else if (rule) {
      rule = truncateMiddle(rule, room);
    } else if (file) {
      file = truncateMiddle(file, room, PATH_TAIL_SHARE);
    }
  }
  return `${source.what}${rule ? ` ${rule}` : ""}${file ? ` in ${file}` : ""}`;
}
