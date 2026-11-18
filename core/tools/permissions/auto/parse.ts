import {
  isModelCategory,
  MODEL_CATEGORIES,
  ReviewCategory,
} from "./categories";

export type ReviewDecision = "allow" | "ask" | "deny";

export interface ReviewResult {
  decision: ReviewDecision;
  /** Why it was refused or escalated. Absent for an allow. */
  category?: ReviewCategory;
  /** One sentence, shown to the person and returned to the agent. */
  reason: string;
  /** The reply could not be read at all (counted by the evaluation). */
  unusable?: boolean;
}

const MAX_REASON = 300;

export interface ParseOptions {
  /**
   * The v3 prompt asks for `"category": "none"` on an allow, to show the
   * category check was done. An allow without it is a model that did not apply
   * the check: low confidence, so it becomes an ask. The default prompt says
   * "omit for allow", so this is off unless v3 is in use.
   */
  allowNeedsNone?: boolean;
}

function unusable(why: string): ReviewResult {
  return {
    decision: "ask",
    category: "uncertain",
    reason: `The reviewer's answer could not be used (${why}).`,
    unusable: true,
  };
}

function namesNone(category: unknown): boolean {
  return (
    typeof category === "string" && category.trim().toLowerCase() === "none"
  );
}

/**
 * Read the reviewer's reply. Anything that is not a clear, well-formed answer
 * becomes an "ask": a reply can only loosen a call by being exactly right.
 *
 * - "allow" must say "allow" and nothing else is read from it.
 * - "deny" only stands for a category whose default outcome is deny; for an
 *   "ask" category, or an unknown or missing one, it becomes an ask.
 */
export function parseReviewerReply(
  text: string,
  opts: ParseOptions = {},
): ReviewResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return unusable("no JSON object");

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return unusable("invalid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unusable("not an object");
  }
  const { decision, category, reason } = raw as Record<string, unknown>;
  const sentence =
    typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, MAX_REASON)
      : undefined;

  if (decision === "allow") {
    if (opts.allowNeedsNone && !namesNone(category)) {
      return {
        decision: "ask",
        category: "uncertain",
        reason:
          "The reviewer allowed this without saying that no category applies, so you are asked.",
      };
    }
    return { decision: "allow", reason: sentence ?? "Reviewer allowed this." };
  }
  if (decision !== "ask" && decision !== "deny") {
    return unusable("unknown decision");
  }

  if (!isModelCategory(category)) {
    return {
      decision: "ask",
      category: "uncertain",
      reason:
        sentence ??
        "The reviewer did not give a recognised reason, so you are asked.",
    };
  }
  const outcome = MODEL_CATEGORIES[category].outcome;
  const final = decision === "deny" && outcome === "deny" ? "deny" : "ask";
  return {
    decision: final,
    category,
    reason: sentence ?? MODEL_CATEGORIES[category].meaning,
  };
}
