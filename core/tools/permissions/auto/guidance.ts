import { createHash } from "node:crypto";
import { HIDDEN_CHARACTERS } from "../../../util/hiddenCharacters";

/**
 * Reviewer guidance: the plain sentences a person writes in their own
 * `toolPermissions.auto.guidance` and that the reviewer reads in its trusted
 * `[[USER-GUIDANCE]]` block. That block can authorise an action, so the text
 * that reaches it is checked here, and only the person's own config may
 * supply it (a repository, an assistant or a hub block cannot: see
 * core/util/userGuidance.ts and plans/review-prompts-research.md, slice 0).
 *
 * Kept free of every provider package, so the GUI may import it.
 */

/** Longest single entry, after normalisation. */
export const MAX_GUIDANCE_ENTRY_CHARS = 2_000;
/** Longest total of all entries (block and allow together). */
export const MAX_GUIDANCE_TOTAL_CHARS = 8_000;

export interface GuidanceInput {
  block?: string[];
  allow?: string[];
}

/** Guidance that passed validation, normalised, in the order written. */
export interface EffectiveGuidance {
  block: string[];
  allow: string[];
}

export interface GuidanceAssembly {
  guidance: EffectiveGuidance;
  /** One clear sentence per refused entry; empty when all passed. */
  errors: string[];
}

export const EMPTY_GUIDANCE: EffectiveGuidance = { block: [], allow: [] };

// The hidden characters are the shared set (core/util/hiddenCharacters.ts)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/** NFKC, hidden and control characters removed, whitespace collapsed. */
export function normaliseGuidanceText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(HIDDEN_CHARACTERS, "")
    .replace(/[\r\n\t\u2028\u2029]+/g, " ")
    .replace(CONTROL, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text the reviewer's own prompt machinery reads. Each is a reason to refuse an
 * entry rather than to repair it: a person who wrote one of these meant it,
 * or pasted it from somewhere that did.
 */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
  {
    pattern: /\[\[|\]\]/,
    what: "a [[section marker]] (the reviewer prompt's trusted sections)",
  },
  {
    pattern: /<<<|>>>/,
    what: "a <<< or >>> fence (the reviewer prompt's untrusted data fences)",
  },
  {
    pattern: /\bEND\s+[0-9a-f]{8,}/i,
    what: "text shaped like a fence end with a nonce",
  },
  {
    pattern:
      /\b(?:USER-MESSAGES|USER-GUIDANCE|EARLIER-TOOL-CALLS|TOOL-CALL|ENVIRONMENT)\b/,
    what: "the name of a reviewer prompt section",
  },
  {
    pattern: /["']?\bdecision["']?\s*[:=]|["']?\bauthori[sz]ation["']?\s*:/i,
    what: "a verdict (the JSON the reviewer's reply is read from)",
  },
  {
    pattern:
      /<\/?(?:tool_call|tool_use|function_calls?|invoke|TOOLCALL|tool_calls)\b|<function=|<parameter=|<\|[a-z_]*\|>|\[TOOL_CALLS?\]|"(?:tool_calls|function_call)"\s*:|\{\s*"name"\s*:/i,
    what: "text that looks like a tool call",
  },
];

/** Why an already normalised entry may not be used, or undefined. */
export function guidanceEntryProblem(text: string): string | undefined {
  if (text === "") return "it is empty";
  if (text.length > MAX_GUIDANCE_ENTRY_CHARS) {
    return `it is ${text.length} characters, over the ${MAX_GUIDANCE_ENTRY_CHARS} limit`;
  }
  for (const { pattern, what } of FORBIDDEN) {
    if (pattern.test(text)) return `it contains ${what}`;
  }
  return undefined;
}

function preview(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function assembleList(
  kind: "block" | "allow",
  raw: readonly string[] | undefined,
  errors: string[],
): string[] {
  const out: string[] = [];
  (raw ?? []).forEach((entry, i) => {
    if (typeof entry !== "string") {
      errors.push(`guidance.${kind}[${i}] is not text.`);
      return;
    }
    const text = normaliseGuidanceText(entry);
    const problem = guidanceEntryProblem(text);
    if (problem) {
      errors.push(
        `guidance.${kind}[${i}] ("${preview(text)}") was refused: ${problem}.`,
      );
    } else out.push(text);
  });
  return out;
}

/**
 * Validate and normalise guidance from the person's own config. Entries that
 * fail are left out and named in `errors`; callers treat any error as a reason
 * not to review (fail closed), because a dropped "never do X" loosens the
 * reviewer without anyone seeing it.
 */
export function assembleGuidance(
  input: GuidanceInput | undefined,
): GuidanceAssembly {
  const errors: string[] = [];
  const block = assembleList("block", input?.block, errors);
  const allow = assembleList("allow", input?.allow, errors);
  const total = [...block, ...allow].reduce((n, t) => n + t.length, 0);
  if (total > MAX_GUIDANCE_TOTAL_CHARS) {
    errors.push(
      `The guidance is ${total} characters in all, over the ${MAX_GUIDANCE_TOTAL_CHARS} limit.`,
    );
  }
  return { guidance: { block, allow }, errors };
}

/** Whether there is nothing to show the reviewer. */
export function guidanceIsEmpty(g: EffectiveGuidance): boolean {
  return g.block.length === 0 && g.allow.length === 0;
}

/** Stable text of the effective guidance, for hashing. */
function canonical(g: EffectiveGuidance): string {
  return JSON.stringify([g.block, g.allow]);
}

/** SHA-256 hex of the effective guidance. */
export function guidanceHash(g: EffectiveGuidance): string {
  return createHash("sha256").update(canonical(g)).digest("hex");
}

/**
 * Short stable id of what the reviewer was told: the trusted instruction text,
 * the effective guidance and the profile. Written to every audit record the
 * reviewer produces; the text itself is never stored.
 */
export function promptVersionOf(
  instructionText: string,
  g: EffectiveGuidance,
  profileId = "default",
): string {
  return createHash("sha256")
    .update(profileId)
    .update("\0")
    .update(instructionText)
    .update("\0")
    .update(canonical(g))
    .digest("hex")
    .slice(0, 12);
}
