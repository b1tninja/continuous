/**
 * The outline of a fetched page: its Markdown headings with line numbers and
 * token sizes, the top-level keys of a JSON body, or failing both its page
 * list (plans/research/web-fetch-large-pages-and-policy.md, section 4.2).
 *
 * Pure and deterministic: the same lines and token counts give the same
 * outline, byte for byte, so a result built from it caches well.
 */

import { sanitizeFetchedText } from "../fetchedText";

/** Heading levels the outline is built from: `#` to `####`. */
export const OUTLINE_MAX_LEVEL = 4;
/** Entries an outline shows at most. */
export const OUTLINE_MAX_ENTRIES = 60;
/** About how many tokens an outline may cost. */
export const OUTLINE_MAX_TOKENS = 600;
/** Heading text is cut to this many characters (code points). */
export const HEADING_MAX_CHARS = 80;

export type TokenCounter = (text: string) => number;

export interface Heading {
  /** 1-based, over every `#` to `####` heading, so `§4` stays §4 when deeper levels are not shown. */
  n: number;
  level: number;
  /** Cleaned and cut to 80 characters. */
  text: string;
  /** The heading's anchor id, GitHub style (`rate-limits`, then `rate-limits-1`). */
  slug: string;
  /** 1-based line of the heading. */
  line: number;
  /** Last line of the section: before the next heading of the same or a higher level. */
  endLine: number;
  /** Estimated tokens from the heading to `endLine`. */
  tokens: number;
}

export interface PageRange {
  /** 1-based. */
  page: number;
  startLine: number;
  /** Inclusive. */
  endLine: number;
  tokens: number;
}

export interface JsonKey {
  key: string;
  line: number;
  endLine: number;
  tokens: number;
}

export interface Outline {
  kind: "headings" | "json" | "pages";
  /** One line each, in page order. */
  entries: string[];
  /** Heading levels left out to fit (`[4]` for `####`). */
  droppedLevels: number[];
  /** Entries left out after the levels were dropped. */
  omitted: number;
  /** Entries and notes, one per line. */
  text: string;
}

/** `1530` as `1,530`, the same whatever locale data the runtime has. */
export function formatCount(n: number): string {
  const digits = String(Math.trunc(Math.abs(n)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${grouped}` : grouped;
}

/** At most `max` code points, never half of a surrogate pair. */
export function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Heading text as the outline shows it: sanitised, links as their text, one line, 80 characters. */
export function cleanHeadingText(raw: string): string {
  const text = sanitizeFetchedText(raw)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return cutChars(text, HEADING_MAX_CHARS).trim();
}

/** The GitHub-style anchor of a heading: lowercase, letters, digits, `-` and `_`, spaces as `-`. */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/**
 * The `#` to `####` headings of Markdown lines, outside fenced code. A line
 * marked as a continuation (the rest of a long line cut into virtual lines)
 * is never a heading.
 */
export function parseHeadings(
  lines: readonly string[],
  lineTokens: readonly number[],
  continuation: readonly boolean[] = [],
): Heading[] {
  const found: Omit<Heading, "endLine" | "tokens">[] = [];
  const slugs = new Map<string, number>();
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (continuation[i]) continue;
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1];
      if (!fence) {
        fence = { char: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.char &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence) continue;
    const m = ATX.exec(line);
    if (!m || m[1].length > OUTLINE_MAX_LEVEL) continue;
    const text = cleanHeadingText(m[2] ?? "");
    if (!text) continue;
    const base = headingSlug(text);
    const seen = slugs.get(base);
    slugs.set(base, (seen ?? -1) + 1);
    found.push({
      n: found.length + 1,
      level: m[1].length,
      text,
      slug: seen === undefined ? base : `${base}-${seen + 1}`,
      line: i + 1,
    });
  }

  const prefix = prefixSums(lineTokens);
  return found.map((h, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < found.length; j++) {
      if (found[j].level <= h.level) {
        endLine = found[j].line - 1;
        break;
      }
    }
    return { ...h, endLine, tokens: prefix[endLine] - prefix[h.line - 1] };
  });
}

/** `sums[i]` is the tokens of lines 1..i. */
export function prefixSums(lineTokens: readonly number[]): number[] {
  const sums = [0];
  for (const t of lineTokens) sums.push(sums[sums.length - 1] + t);
  return sums;
}

/** The innermost heading a 1-based line is under, or undefined before the first. */
export function headingAt(
  headings: readonly Heading[],
  line: number,
): Heading | undefined {
  let lo = 0;
  let hi = headings.length - 1;
  let at: Heading | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].line <= line) {
      at = headings[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return at;
}

/**
 * The heading a `section` argument means: its number (`4` or `§4`), its
 * anchor id (`rate-limits` or `#rate-limits`), or its text, matched without
 * case, exact first, then as a prefix. The first heading in page order wins
 * a tie.
 */
export function findSection(
  headings: readonly Heading[],
  ref: string | number,
): Heading | undefined {
  const raw = String(ref).trim();
  const number = /^§?\s*(\d+)$/.exec(raw);
  if (number) {
    const n = Number(number[1]);
    const byNumber = headings.find((h) => h.n === n);
    if (byNumber) return byNumber;
  }
  const wanted = cleanHeadingText(raw.replace(/^§\s*/, "")).toLowerCase();
  if (!wanted) return undefined;
  const anchor = raw.replace(/^#/, "").toLowerCase();
  return (
    headings.find((h) => h.text.toLowerCase() === wanted) ??
    headings.find((h) => h.slug === anchor) ??
    headings.find((h) => h.text.toLowerCase().startsWith(wanted))
  );
}

/**
 * The top-level keys of pretty-printed JSON (`JSON.stringify(x, null, 2)`),
 * with their lines. Empty when the text is not a JSON object laid out that way.
 */
export function jsonTopLevelKeys(
  lines: readonly string[],
  lineTokens: readonly number[],
): JsonKey[] {
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  if (lines[first]?.trim() !== "{") return [];
  let indent: string | undefined;
  const keys: Omit<JsonKey, "endLine" | "tokens">[] = [];
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const lead = /^[ \t]*/.exec(line)![0];
    if (indent === undefined) {
      if (!lead) return [];
      indent = lead;
    }
    if (lead !== indent || line[lead.length] !== '"') continue;
    const m = /^"((?:[^"\\]|\\.)*)"\s*:/.exec(line.slice(lead.length));
    if (!m) continue;
    let key: string;
    try {
      key = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      continue;
    }
    keys.push({ key, line: i + 1 });
  }
  const prefix = prefixSums(lineTokens);
  return keys.map((k, idx) => {
    const endLine =
      idx + 1 < keys.length ? keys[idx + 1].line - 1 : lines.length;
    return { ...k, endLine, tokens: prefix[endLine] - prefix[k.line - 1] };
  });
}

export function headingEntry(h: Heading): string {
  return `§${h.n} ${h.text} (line ${h.line}, ~${formatCount(h.tokens)})`;
}

function jsonEntry(k: JsonKey): string {
  return `${JSON.stringify(cutChars(k.key, HEADING_MAX_CHARS))} (line ${k.line}, ~${formatCount(k.tokens)})`;
}

export function pageEntry(p: PageRange): string {
  return `page ${p.page}: lines ${p.startLine}-${p.endLine} (~${formatCount(p.tokens)} tokens)`;
}

function droppedNote(levels: number[]): string {
  const marks = levels.map((l) => "#".repeat(l));
  const named =
    marks.length === 1
      ? marks[0]
      : `${marks.slice(0, -1).join(", ")} and ${marks[marks.length - 1]}`;
  return `${named} headings not shown`;
}

function render(
  entries: string[],
  droppedLevels: number[],
  omitted: number,
  noun: string,
): string {
  const lines = [...entries];
  if (omitted > 0) lines.push(`${formatCount(omitted)} more ${noun} not shown`);
  if (droppedLevels.length) lines.push(droppedNote(droppedLevels));
  return lines.join("\n");
}

/** As many entries as fit both caps, and a note for the rest. */
function fitEntries(
  entries: string[],
  droppedLevels: number[],
  noun: string,
  count: TokenCounter,
): { entries: string[]; omitted: number } {
  let shown = Math.min(entries.length, OUTLINE_MAX_ENTRIES);
  while (
    shown > 0 &&
    count(
      render(
        entries.slice(0, shown),
        droppedLevels,
        entries.length - shown,
        noun,
      ),
    ) > OUTLINE_MAX_TOKENS
  ) {
    shown--;
  }
  return { entries: entries.slice(0, shown), omitted: entries.length - shown };
}

/**
 * The outline for a stored page. Headings first; deeper levels are dropped
 * until it fits 60 entries and about 600 tokens, and what is still too long
 * is cut with a count. With no headings: the top-level keys of a JSON
 * object when there are 60 or fewer, else the page list.
 */
export function buildOutline(input: {
  headings: readonly Heading[];
  jsonKeys?: readonly JsonKey[];
  pages: readonly PageRange[];
  count: TokenCounter;
}): Outline {
  const { headings, pages, count } = input;
  if (headings.length) {
    const levels = [...new Set(headings.map((h) => h.level))].sort(
      (a, b) => a - b,
    );
    for (let k = levels.length; k >= 1; k--) {
      const maxLevel = levels[k - 1];
      const droppedLevels = levels.slice(k);
      const entries = headings
        .filter((h) => h.level <= maxLevel)
        .map(headingEntry);
      const text = render(entries, droppedLevels, 0, "headings");
      const fits =
        entries.length <= OUTLINE_MAX_ENTRIES &&
        count(text) <= OUTLINE_MAX_TOKENS;
      if (fits) {
        return { kind: "headings", entries, droppedLevels, omitted: 0, text };
      }
      if (k === 1) {
        const fitted = fitEntries(entries, droppedLevels, "headings", count);
        return {
          kind: "headings",
          ...fitted,
          droppedLevels,
          text: render(
            fitted.entries,
            droppedLevels,
            fitted.omitted,
            "headings",
          ),
        };
      }
    }
  }

  const jsonKeys = input.jsonKeys ?? [];
  if (jsonKeys.length && jsonKeys.length <= OUTLINE_MAX_ENTRIES) {
    const all = jsonKeys.map(jsonEntry);
    const fitted = fitEntries(all, [], "keys", count);
    return {
      kind: "json",
      ...fitted,
      droppedLevels: [],
      text: render(fitted.entries, [], fitted.omitted, "keys"),
    };
  }

  const fitted = fitEntries(pages.map(pageEntry), [], "pages", count);
  return {
    kind: "pages",
    ...fitted,
    droppedLevels: [],
    text: render(fitted.entries, [], fitted.omitted, "pages"),
  };
}
