/**
 * Windows over a fetched page too long for one tool result: the window size
 * from the model's context, the page split into lines and pages, and reading
 * by page, section, offset or `grep`
 * (plans/research/web-fetch-large-pages-and-policy.md, sections 4.1 and 4.4).
 *
 * Pure: no I/O, no clock. The same text, window and counter give the same
 * pages, outline and read results, byte for byte, so each result is cache
 * friendly. The fetch tool (WB39) stores a `WebPage` and answers
 * `read_web_content` from it.
 *
 * The output shapes follow read_command_output
 * (core/tools/implementations/commandOutputTools.ts): numbered lines, a
 * case-insensitive pattern, at most 200 matches, `[no line matches]`.
 */

import { countTokens } from "../../llm/countTokens";

import {
  buildOutline,
  cutChars,
  formatCount,
  Heading,
  headingAt,
  findSection,
  jsonTopLevelKeys,
  Outline,
  PageRange,
  parseHeadings,
  TokenCounter,
} from "./outline";

export { formatCount } from "./outline";
export type { Heading, Outline, PageRange, TokenCounter } from "./outline";

/** The first window is 5% of the context window, clamped to these. */
export const MIN_WINDOW_TOKENS = 1_500;
export const MAX_WINDOW_TOKENS = 6_000;
export const WINDOW_SHARE = 0.05;
/** A page up to this many windows is returned whole. */
export const WHOLE_PAGE_SLACK = 1.25;
/** Longer lines (minified text) are cut into virtual lines of this length. */
export const MAX_LINE_CHARS = 2_000;
/** As read_command_output. */
export const MAX_GREP_MATCHES = 200;
export const MAX_GREP_CONTEXT = 10;
/** Lines an `offset` read returns at most, as read_command_output. */
export const MAX_READ_LINES = 1_000;

/**
 * The first window's size in tokens: `configured` (`web.limits.windowTokens`)
 * when set, else 5% of the context window clamped to 1,500 to 6,000. An
 * unknown context window gives the smallest window.
 */
export function windowTokensFor(
  contextLength: number | undefined,
  configured?: number,
): number {
  if (
    configured !== undefined &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return Math.max(1, Math.floor(configured));
  }
  const context =
    contextLength !== undefined && Number.isFinite(contextLength)
      ? contextLength
      : 0;
  return Math.min(
    MAX_WINDOW_TOKENS,
    Math.max(MIN_WINDOW_TOKENS, Math.floor(context * WINDOW_SHARE)),
  );
}

/** The largest page returned whole for a window. */
export function wholePageLimit(windowTokens: number): number {
  return Math.floor(windowTokens * WHOLE_PAGE_SLACK);
}

/** The product's counter for a model (`countTokens`, an estimate for tokenizers we do not ship). */
export function tokenCounterFor(modelName: string): TokenCounter {
  return (text) => (text ? countTokens(text, modelName) : 0);
}

export interface SplitLines {
  lines: string[];
  /** True for the second and later virtual lines of a long line. */
  continuation: boolean[];
}

/**
 * Lines of converted text. `\r\n`, `\r` and `\n` all end a line, a final line
 * break adds no empty line, and a line longer than 2,000 characters is cut
 * into virtual lines (never inside a surrogate pair), so line numbers mean
 * the same thing for minified text.
 */
export function splitLines(
  text: string,
  maxLineChars: number = MAX_LINE_CHARS,
): SplitLines {
  const lines: string[] = [];
  const continuation: boolean[] = [];
  if (!text) return { lines, continuation };
  const raw = text.split(/\r\n|\r|\n/);
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  for (const line of raw) {
    let start = 0;
    let first = true;
    do {
      let end = Math.min(line.length, start + maxLineChars);
      const code = line.charCodeAt(end - 1);
      if (end < line.length && code >= 0xd800 && code <= 0xdbff) end--;
      lines.push(line.slice(start, end));
      continuation.push(!first);
      first = false;
      start = end;
    } while (start < line.length);
  }
  return { lines, continuation };
}

export interface WebPage {
  lines: readonly string[];
  continuation: readonly boolean[];
  /** Estimated tokens of each line, for boundaries and section sizes. */
  lineTokens: readonly number[];
  /** Tokens of the whole text. */
  totalTokens: number;
  windowTokens: number;
  /** Small enough (1.25 windows) to return in one result. */
  whole: boolean;
  pages: readonly PageRange[];
  headings: readonly Heading[];
  outline: Outline;
}

/**
 * Splits converted text into lines and pages and builds its outline. Pages
 * are consecutive windows cut at line boundaries; their number is fixed
 * here. A page within 1.25 windows is one page.
 */
export function preparePage(
  text: string,
  options: { windowTokens: number; count: TokenCounter },
): WebPage {
  const { count } = options;
  const windowTokens = Math.max(1, Math.floor(options.windowTokens));
  const { lines, continuation } = splitLines(text);
  const lineTokens = lines.map((line) => count(line));
  const totalTokens = count(lines.join("\n"));
  const whole = totalTokens <= wholePageLimit(windowTokens);

  const ranges: Array<[number, number]> = [];
  if (whole || lines.length === 0) {
    ranges.push([1, lines.length]);
  } else {
    let start = 1;
    let used = 0;
    for (let i = 1; i <= lines.length; i++) {
      // A line break costs about a token
      const cost = lineTokens[i - 1] + (i > start ? 1 : 0);
      if (i > start && used + cost > windowTokens) {
        ranges.push([start, i - 1]);
        start = i;
        used = lineTokens[i - 1];
      } else {
        used += cost;
      }
    }
    ranges.push([start, lines.length]);
  }
  const pages: PageRange[] = ranges.map(([startLine, endLine], i) => ({
    page: i + 1,
    startLine,
    endLine,
    tokens:
      ranges.length === 1
        ? totalTokens
        : count(lines.slice(startLine - 1, endLine).join("\n")),
  }));

  const headings = parseHeadings(lines, lineTokens, continuation);
  const outline = buildOutline({
    headings,
    jsonKeys: headings.length ? [] : jsonTopLevelKeys(lines, lineTokens),
    pages,
    count,
  });
  return {
    lines,
    continuation,
    lineTokens,
    totalTokens,
    windowTokens,
    whole,
    pages,
    headings,
    outline,
  };
}

/** `1,530 lines, ~40,213 tokens in 7 pages of up to ~6,000`, or without pages when whole. */
export function describeSize(page: WebPage): string {
  const size = `${formatCount(page.lines.length)} ${page.lines.length === 1 ? "line" : "lines"}, ~${formatCount(page.totalTokens)} tokens`;
  return page.pages.length > 1
    ? `${size} in ${page.pages.length} pages of up to ~${formatCount(page.windowTokens)}`
    : size;
}

/** The page a 1-based line is on. */
export function pageOfLine(page: WebPage, line: number): number {
  const found = page.pages.find(
    (p) => line >= p.startLine && line <= p.endLine,
  );
  return found?.page ?? page.pages.length;
}

export type ReadSelector = "page" | "section" | "offset" | "grep";

export interface WebRead {
  ok: true;
  selector: Exclude<ReadSelector, "grep">;
  startLine: number;
  endLine: number;
  /** The lines, joined with `\n`. */
  text: string;
  tokens: number;
  /** The page `startLine` is on. */
  page: number;
  section?: Heading;
  /** A section or `lines` request cut at one window. */
  cut: boolean;
  /** `lines 213-430 of 1,530 · page 2 of 7 · ~6,000 tokens`. */
  range: string;
  /** `Next: page 3, or offset 431.` */
  next: string;
}

export interface WebReadError {
  ok: false;
  selector: ReadSelector;
  message: string;
}

function rangeLine(
  page: WebPage,
  startLine: number,
  endLine: number,
  tokens: number,
  section?: Heading,
): string {
  const parts = [
    `lines ${startLine}-${endLine} of ${formatCount(page.lines.length)}`,
    `page ${pageOfLine(page, startLine)} of ${page.pages.length}`,
    `~${formatCount(tokens)} tokens`,
  ];
  if (section) parts.unshift(`§${section.n} ${section.text}`);
  return parts.join(" · ");
}

function nextAfter(
  page: WebPage,
  endLine: number,
  pageNumber?: number,
): string {
  if (endLine >= page.lines.length) return "End of the page.";
  const offset = endLine + 1;
  return pageNumber !== undefined && pageNumber < page.pages.length
    ? `Next: page ${pageNumber + 1}, or offset ${offset}.`
    : `Next: offset ${offset}.`;
}

/** The last line from `startLine` that keeps the text within the window (at least one line). */
function fitWindow(page: WebPage, startLine: number, lastLine: number): number {
  let used = 0;
  for (let line = startLine; line <= lastLine; line++) {
    const cost = page.lineTokens[line - 1] + (line > startLine ? 1 : 0);
    if (line > startLine && used + cost > page.windowTokens) return line - 1;
    used += cost;
  }
  return lastLine;
}

function linesRead(
  page: WebPage,
  selector: WebRead["selector"],
  startLine: number,
  endLine: number,
  cut: boolean,
  count: TokenCounter,
  extra: { section?: Heading; pageNumber?: number; tokens?: number } = {},
): WebRead {
  const text = page.lines.slice(startLine - 1, endLine).join("\n");
  const tokens = extra.tokens ?? count(text);
  let next = nextAfter(page, endLine, extra.pageNumber);
  if (cut && extra.section) {
    next = `§${extra.section.n} continues: offset ${endLine + 1}.`;
  }
  return {
    ok: true,
    selector,
    startLine,
    endLine,
    text,
    tokens,
    page: pageOfLine(page, startLine),
    ...(extra.section && { section: extra.section }),
    cut,
    range: rangeLine(page, startLine, endLine, tokens, extra.section),
    next,
  };
}

function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** One page, 1-based. */
export function readPage(
  page: WebPage,
  pageNumber: unknown,
  count: TokenCounter,
): WebRead | WebReadError {
  const n = positiveInteger(pageNumber);
  const range = n === undefined ? undefined : page.pages[n - 1];
  if (!range || page.lines.length === 0) {
    return {
      ok: false,
      selector: "page",
      message: `There is no page ${String(pageNumber)}; this page has ${page.pages.length} (1 to ${page.pages.length}).`,
    };
  }
  return linesRead(page, "page", range.startLine, range.endLine, false, count, {
    pageNumber: range.page,
    tokens: range.tokens,
  });
}

/**
 * A section, from its heading to the next heading of the same or a higher
 * level. One larger than the window returns its first window and says where
 * it continues.
 */
export function readSection(
  page: WebPage,
  ref: string | number,
  count: TokenCounter,
): WebRead | WebReadError {
  const heading = findSection(page.headings, ref);
  if (!heading) {
    return {
      ok: false,
      selector: "section",
      message: page.headings.length
        ? `No section matches "${cutChars(String(ref), 80)}". Use a number from the outline (1 to ${page.headings.length}) or a heading's text.`
        : "This page has no headings; read it by page, offset or grep.",
    };
  }
  const end = fitWindow(page, heading.line, heading.endLine);
  return linesRead(
    page,
    "section",
    heading.line,
    end,
    end < heading.endLine,
    count,
    { section: heading },
  );
}

/**
 * Lines from `offset` (1-based). Without `lines`, as many as fit in the
 * window; with it, that many, still at most one window and 1,000 lines.
 */
export function readOffset(
  page: WebPage,
  offset: unknown,
  lines: unknown,
  count: TokenCounter,
): WebRead | WebReadError {
  const start = positiveInteger(offset);
  if (start === undefined || start > page.lines.length) {
    return {
      ok: false,
      selector: "offset",
      message: `Offset ${String(offset)} is not a line of this page (1 to ${formatCount(page.lines.length)}).`,
    };
  }
  const wanted = positiveInteger(lines);
  const last = Math.min(
    page.lines.length,
    start + Math.min(wanted ?? MAX_READ_LINES, MAX_READ_LINES) - 1,
  );
  const end = fitWindow(page, start, last);
  return linesRead(
    page,
    "offset",
    start,
    end,
    wanted !== undefined && end < last,
    count,
  );
}

export interface GrepOptions {
  /** Matches returned at most (default and cap 200). */
  limit?: unknown;
  /** Lines shown before and after each match (0 to 10). */
  context?: unknown;
  /** Match the pattern as plain text, not as a regular expression. */
  literal?: boolean;
}

export interface GrepResult {
  ok: true;
  selector: "grep";
  pattern: string;
  /** Matched as plain text: asked for, or not a valid regular expression. */
  literal: boolean;
  /** Set when an invalid expression was matched as text. */
  invalidPattern?: string;
  /** Matching lines in the whole page. */
  matchCount: number;
  /** Matches in `lines`. */
  shown: number;
  /** `212 [§4 Rate limits]: text` for a match, `211- text` for context, `--` between groups. */
  lines: string[];
  /** Line numbers of the matches shown. */
  matchLines: number[];
  /** Stopped at the match limit. */
  more: boolean;
  /** Stopped at one window of text before the limit. */
  cutAtWindow: boolean;
  /** `14 lines match "rate.?limit" (of 1,530)` */
  header: string;
  /** The notes and the next step, one per line. */
  footer: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n))
    return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function matchLine(page: WebPage, line: number): string {
  const h = headingAt(page.headings, line);
  const where = h ? ` [§${h.n} ${h.text}]` : "";
  return `${line}${where}: ${page.lines[line - 1]}`;
}

/** A line around a match, as `grep -n -C` prints it: `211- text`. */
function contextLine(page: WebPage, line: number): string {
  const text = page.lines[line - 1];
  return text ? `${line}- ${text}` : `${line}-`;
}

/**
 * The lines matching a case-insensitive pattern, with their numbers and the
 * section each is in. A pattern that is not a valid regular expression is
 * matched as plain text and the result says so. At most 200 matches and one
 * window of text.
 */
export function grepPage(
  page: WebPage,
  pattern: string,
  count: TokenCounter,
  options: GrepOptions = {},
): GrepResult | WebReadError {
  if (!pattern) {
    return {
      ok: false,
      selector: "grep",
      message: "The grep pattern is empty.",
    };
  }
  let literal = options.literal === true;
  let invalidPattern: string | undefined;
  let regex: RegExp | undefined;
  if (!literal) {
    try {
      regex = new RegExp(pattern, "i");
    } catch (e) {
      literal = true;
      invalidPattern = (e as Error).message;
    }
  }
  regex ??= new RegExp(escapeRegExp(pattern), "i");

  const limit = clampInteger(
    options.limit,
    MAX_GREP_MATCHES,
    1,
    MAX_GREP_MATCHES,
  );
  const context = clampInteger(options.context, 0, 0, MAX_GREP_CONTEXT);

  const all: number[] = [];
  for (let i = 0; i < page.lines.length; i++) {
    if (regex.test(page.lines[i])) all.push(i + 1);
  }

  const selected = all.slice(0, limit);
  const isMatch = new Set(selected);
  const out: string[] = [];
  const matchLines: number[] = [];
  let used = 0;
  let lastShown = 0;
  let cutAtWindow = false;
  for (const line of selected) {
    // A match shown in the previous one's context still gets its own context after it
    const from = Math.max(1, line - context, lastShown + 1);
    const to = Math.min(page.lines.length, line + context);
    if (from > to) {
      matchLines.push(line);
      continue;
    }
    const group: string[] =
      context > 0 && lastShown && from > lastShown + 1 ? ["--"] : [];
    for (let l = from; l <= to; l++) {
      group.push(isMatch.has(l) ? matchLine(page, l) : contextLine(page, l));
    }
    const cost = count(group.join("\n")) + group.length;
    if (matchLines.length > 0 && used + cost > page.windowTokens) {
      cutAtWindow = true;
      break;
    }
    used += cost;
    out.push(...group);
    matchLines.push(line);
    lastShown = to;
  }

  const shown = matchLines.length;
  const more = !cutAtWindow && all.length > shown;
  const quoted = `"${pattern}"`;
  const header = `${formatCount(all.length)} ${all.length === 1 ? "line matches" : "lines match"} ${quoted} (of ${formatCount(page.lines.length)})`;
  const notes: string[] = [];
  if (invalidPattern !== undefined) {
    notes.push(
      `[${quoted} is not a valid regular expression, so it was matched as plain text]`,
    );
  }
  if (!all.length) notes.push("[no line matches]");
  if (more) notes.push(`[more than ${limit} matches; narrow the pattern]`);
  if (cutAtWindow) {
    notes.push(
      `[${formatCount(all.length - shown)} more matches after line ${matchLines[shown - 1]} did not fit in one result; narrow the pattern or read on with offset]`,
    );
  }
  if (shown) {
    notes.push(
      `Read a match in context with offset (e.g. offset ${Math.max(1, matchLines[0] - 7)}).`,
    );
  }
  return {
    ok: true,
    selector: "grep",
    pattern,
    literal,
    ...(invalidPattern !== undefined && { invalidPattern }),
    matchCount: all.length,
    shown,
    lines: out,
    matchLines,
    more,
    cutAtWindow,
    header,
    footer: notes.join("\n"),
  };
}

export interface ReadWebArgs {
  section?: unknown;
  page?: unknown;
  offset?: unknown;
  lines?: unknown;
  grep?: unknown;
  context?: unknown;
}

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * `read_web_content`'s selection: the first given of `section`, `page`,
 * `offset`, `grep` wins and the result names it; with none, page 2 (the
 * natural "more"), or page 1 of a one-page result.
 */
export function readWebPage(
  page: WebPage,
  args: ReadWebArgs,
  count: TokenCounter,
): { read: WebRead | GrepResult | WebReadError; ignored: ReadSelector[] } {
  const order: ReadSelector[] = ["section", "page", "offset", "grep"];
  const present = order.filter((s) => given(args[s]));
  const ignored = present.slice(1);
  switch (present[0]) {
    case "section":
      return { read: readSection(page, String(args.section), count), ignored };
    case "page":
      return { read: readPage(page, args.page, count), ignored };
    case "offset":
      return {
        read: readOffset(page, args.offset, args.lines, count),
        ignored,
      };
    case "grep":
      return {
        read: grepPage(page, String(args.grep), count, {
          limit: args.lines,
          context: args.context,
        }),
        ignored,
      };
    default:
      return {
        read: readPage(page, page.pages.length > 1 ? 2 : 1, count),
        ignored,
      };
  }
}
