/**
 * A `robots.txt` parser (RFC 9309). Pure: it takes the file's bytes and
 * returns its groups; fetching and caching are in `cache.ts`, matching in
 * `match.ts`. The file is a site's untrusted content (RFC 9309§3¶3), so the
 * parser never throws on what it reads and stops at a byte limit.
 *
 * RFC 9309 (Proposed Standard, 2022-09, current):
 * https://www.rfc-editor.org/rfc/rfc9309.html. Quotes below are cited by
 * section and paragraph (`RFC 9309§2.2.2¶2`) and were read from the RFC
 * Editor's text. It has no verified errata; of the four reported, 7124 and
 * 7128 correct examples (the tests note them), 7995 says a pattern may start
 * with `*` (accepted here, as RFC 9309§5.1 itself does), and 8895 proposes
 * comma-separated user-agent lists (not implemented: reported, not verified).
 */

import { normalizePattern } from "./match";

/**
 * RFC 9309§2.5¶1: "Crawlers SHOULD impose a parsing limit to protect their
 * systems; see Section 3. The parsing limit MUST be at least 500 kibibytes
 * [KiB]." 512 KiB, the figure the web fetch plan settles on (RB-1), which is
 * also Google's.
 */
export const ROBOTS_PARSE_LIMIT_BYTES = 512 * 1024;

export interface RobotsRule {
  kind: "allow" | "disallow";
  /** The path pattern as written in the file */
  raw: string;
  /** The pattern after percent-encoding normalisation (match.ts) */
  pattern: string;
  /** 1-based line number in the file */
  line: number;
}

export interface RobotsGroup {
  /** Product tokens of the group's user-agent lines, lowercased; "*" for any */
  userAgents: string[];
  rules: RobotsRule[];
  /**
   * `Crawl-delay` in seconds, the last valid one in the group. Not part of
   * the protocol: RFC 9309§2.2.4¶1 lets a crawler read other records.
   */
  crawlDelaySeconds?: number;
  /** AIPREF `Content-Usage` values inside the group, recorded only */
  contentUsage: string[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  /** `Sitemap` values (RFC 9309§2.2.4¶1 names it as an example) */
  sitemaps: string[];
  /**
   * AIPREF `Content-Usage` values outside any group. The rule comes from
   * draft-ietf-aipref-attach (not an RFC yet), so it is recorded and changes
   * no verdict (plans/research/web-fetch-deep-dive.md RB-9).
   */
  contentUsage: string[];
  /** The file was longer than the limit; only its first part was read */
  truncated: boolean;
  /** Bytes the parser read */
  bytesParsed: number;
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

/**
 * The product token a user-agent value names. RFC 9309§2.2.1¶1: "The product
 * token MUST contain only uppercase and lowercase letters ("a-z" and "A-Z"),
 * underscores ("_"), and hyphens ("-")." A value such as `ExampleBot/1.0` is
 * read as its leading token (`ExampleBot`), the lenient reading RFC
 * 9309§2.2.4¶1 allows ("Crawlers MAY be lenient when interpreting other
 * records"); a value with no such token is ignored.
 */
function productTokenOf(value: string): string | undefined {
  if (value.startsWith("*")) return "*";
  const token = /^[A-Za-z_-]+/.exec(value)?.[0];
  return token ? token.toLowerCase() : undefined;
}

/** The record key, lowercased, with the spellings commonly seen in the wild. */
function keyOf(raw: string): string {
  const key = raw.trim().toLowerCase();
  // RFC 9309§2.2.4¶1: "crawlers may accept common misspellings of the record"
  if (key === "useragent" || key === "user agent") return "user-agent";
  if (key === "dissallow" || key === "disalow") return "disallow";
  if (key === "site-map") return "sitemap";
  return key;
}

/** The bytes the parser reads: at most the limit, ending on a whole line. */
function limitBytes(
  body: string | Uint8Array,
  limit: number,
): { bytes: Uint8Array; truncated: boolean } {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  if (bytes.length <= limit) return { bytes, truncated: false };
  // Cut at the last line break inside the limit: a rule cut in half would be
  // a rule nobody wrote (`Disallow: /private` read as `Disallow: /pri`)
  let end = limit;
  while (end > 0 && bytes[end - 1] !== 0x0a && bytes[end - 1] !== 0x0d) end--;
  return { bytes: bytes.subarray(0, end), truncated: true };
}

/**
 * Parse a `robots.txt` file.
 *
 * RFC 9309§2.3.1.5¶1: "Crawlers MUST try to parse each line of the
 * robots.txt file. Crawlers MUST use the parseable rules." A line that does
 * not parse is skipped and the rest is read.
 */
export function parseRobotsTxt(
  body: string | Uint8Array,
  limit: number = ROBOTS_PARSE_LIMIT_BYTES,
): ParsedRobots {
  const { bytes, truncated } = limitBytes(body, Math.max(0, limit));
  // RFC 9309§2.3¶1: the file "MUST be UTF-8 encoded"; a BOM is dropped
  let text = decoder.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const parsed: ParsedRobots = {
    groups: [],
    sitemaps: [],
    contentUsage: [],
    truncated,
    bytesParsed: bytes.length,
  };
  let current: RobotsGroup | undefined;
  // True while user-agent lines are still being collected for `current`:
  // RFC 9309§2.2 `group = startgroupline *(startgroupline / emptyline)
  // *(rule / emptyline)`, so a user-agent line after a rule starts a new
  // group (RFC 9309§2.1¶2: "The group is terminated by a user-agent line or
  // end of file").
  let collectingAgents = false;

  // RFC 9309§2.2: NL = %x0D / %x0A / %x0D.0A
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    // RFC 9309§2.2.3¶1: "#" designates a line comment
    const hash = lines[i].indexOf("#");
    const content = (hash === -1 ? lines[i] : lines[i].slice(0, hash)).trim();
    if (!content) continue;
    const colon = content.indexOf(":");
    if (colon === -1) continue;
    const key = keyOf(content.slice(0, colon));
    const value = content.slice(colon + 1).trim();

    if (key === "user-agent") {
      const token = productTokenOf(value);
      if (!token) continue;
      if (!current || !collectingAgents) {
        current = { userAgents: [], rules: [], contentUsage: [] };
        parsed.groups.push(current);
        collectingAgents = true;
      }
      current.userAgents.push(token);
      continue;
    }

    if (key === "allow" || key === "disallow") {
      // RFC 9309§2.2.2¶7: "The crawler SHOULD ignore "disallow" and "allow"
      // rules that are not in any group (for example, any rule that precedes
      // the first user-agent line)."
      collectingAgents = false;
      if (!current) continue;
      // An empty pattern (RFC 9309§2.2 `empty-pattern = *WS`) names no path,
      // so it matches nothing: `Disallow:` alone disallows nothing.
      if (!value) continue;
      current.rules.push({
        kind: key,
        raw: value,
        pattern: normalizePattern(value),
        line: i + 1,
      });
      continue;
    }

    // Other records (RFC 9309§2.2.4). Their parsing "MUST NOT interfere with
    // the parsing of explicitly defined records in Section 2. For example, a
    // "Sitemaps" record MUST NOT terminate a group." (RFC 9309§2.2.4¶2)
    if (key === "sitemap") {
      if (value) parsed.sitemaps.push(value);
      continue;
    }
    // `Crawl-delay` and `Content-Usage` belong to a group, so they sit where
    // the ABNF puts rules (RFC 9309§2.2: "parser implementors: define
    // additional lines you need") and, like a rule, end the run of
    // user-agent lines: `User-agent: a`, `Crawl-delay: 5`, `User-agent: b`
    // is two groups.
    if (key === "crawl-delay") {
      if (current) collectingAgents = false;
      const seconds = Number(value);
      if (current && Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelaySeconds = seconds;
      }
      continue;
    }
    if (key === "content-usage") {
      if (!value) continue;
      if (current) collectingAgents = false;
      if (current) current.contentUsage.push(value);
      else parsed.contentUsage.push(value);
      continue;
    }
    // Unknown records are skipped and do not end a group
  }
  return parsed;
}
