/**
 * `robots.txt` matching (RFC 9309§2.2.1 to §2.2.3): which group applies to a
 * product token, and which rule in it decides a path. Pure and synchronous.
 */

import type { ParsedRobots, RobotsGroup, RobotsRule } from "./parse";

const HEX = "0123456789ABCDEF";

/**
 * RFC 3986§2.3¶2: unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~". Only
 * these are decoded from a percent-encoding.
 */
function isUnreserved(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x5f ||
    code === 0x7e
  );
}

function hexValue(c: string): number {
  return HEX.indexOf(c.toUpperCase());
}

function encodeByte(byte: number): string {
  return `%${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
}

const encoder = new TextEncoder();

/**
 * Normalise the percent-encoding of a path or a pattern so the two compare
 * octet by octet.
 *
 * RFC 9309§2.2.2¶3: "Octets in the URI and robots.txt paths outside the
 * range of the ASCII coded character set, and those in the reserved range
 * defined by [RFC3986], MUST be percent-encoded as defined by [RFC3986] prior
 * to comparison."
 *
 * RFC 9309§2.2.2¶4: "If a percent-encoded ASCII octet is encountered in the
 * URI, it MUST be unencoded prior to comparison, unless it is a reserved
 * character in the URI as defined by [RFC3986] or the character is outside
 * the unreserved character range."
 *
 * So: a non-ASCII octet (and a control or space octet, which RFC 9309§2.2
 * `UTF8-char-noctl` excludes) is encoded; `%XX` for an unreserved character
 * (RFC 3986§2.3) is decoded; any other `%XX` stays encoded with its hex in
 * upper case (RFC 3986§6.2.2.1¶1: "should be normalized to use uppercase
 * letters for the digits A-F"). A reserved character written as itself (`/`,
 * `?`, `=`) is a delimiter in the path and is kept as itself, as Figure 4 of
 * RFC 9309§2.2.2 keeps `/foo/bar?baz=quz`.
 *
 * `encode` lists characters to encode though they are printable ASCII (the
 * URI side encodes `*` and `$`).
 */
function normalizeEncoding(input: string, encode: string): string {
  let out = "";
  const bytes = encoder.encode(input);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x25 /* % */ && i + 2 < bytes.length) {
      const h = hexValue(String.fromCharCode(bytes[i + 1]));
      const l = hexValue(String.fromCharCode(bytes[i + 2]));
      if (h >= 0 && l >= 0) {
        const value = (h << 4) | l;
        out += isUnreserved(value)
          ? String.fromCharCode(value)
          : encodeByte(value);
        i += 2;
        continue;
      }
    }
    if (b <= 0x20 || b >= 0x7f) {
      out += encodeByte(b);
      continue;
    }
    const ch = String.fromCharCode(b);
    out += encode.includes(ch) ? encodeByte(b) : ch;
  }
  return out;
}

/**
 * A rule's pattern, normalised. `*` and a final `$` keep their special
 * meaning (RFC 9309§2.2.3¶1); `%2A` and `%24` stay encoded, so they match a
 * literal `*` or `$` in the URI (RFC 9309§2.2.3¶3, Figure 6). A `$` that is
 * not the last character has no special meaning and is encoded the way the
 * URI side encodes it.
 */
export function normalizePattern(raw: string): string {
  const anchored = raw.endsWith("$");
  const body = anchored ? raw.slice(0, -1) : raw;
  return normalizeEncoding(body, "$") + (anchored ? "$" : "");
}

/**
 * The part of a URL the rules match: path and query, normalised.
 *
 * RFC 9309§2.2.2¶2: "The matching MUST start with the first octet of the
 * path." The query is part of what is matched (Figure 4: `/foo/bar?baz=quz`).
 * A literal `*` or `$` in the URI is encoded so it can only match an encoded
 * pattern character (RFC 9309§2.2.3¶3: "If crawlers match special characters
 * verbatim in the URI, crawlers SHOULD use "%" encoding").
 */
export function pathToMatch(url: URL): string {
  return normalizeEncoding(`${url.pathname || "/"}${url.search}`, "*$");
}

/**
 * Whether `pattern` matches `path` from its first octet: `*` matches any run
 * of octets including `/`, a final `$` requires the end of the path, and
 * otherwise reaching the end of the pattern is a match (RFC 9309§2.2.2¶4:
 * "The match evaluates positively if and only if the end of the path from
 * the rule is reached before a difference in octets is encountered").
 *
 * A two-pointer wildcard match with backtracking to the last `*`: O(n * m)
 * at worst and no regular expression, so a hostile pattern cannot make it
 * run away.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const p = anchored ? pattern.slice(0, -1) : pattern;
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si <= path.length) {
    if (pi === p.length) {
      // Pattern consumed: a prefix match, unless anchored to the end
      if (!anchored || si === path.length) return true;
    } else if (p[pi] === "*") {
      starP = pi++;
      starS = si;
      continue;
    } else if (si < path.length && p[pi] === path[si]) {
      pi++;
      si++;
      continue;
    }
    if (starP === -1 || starS >= path.length) return false;
    pi = starP + 1;
    si = ++starS;
  }
  return false;
}

export interface GroupSelection {
  /** The product tokens of the groups chosen, or ["*"] */
  matchedBy: string[];
  /** The chosen groups' rules, combined */
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
  contentUsage: string[];
}

/**
 * RFC 9309§2.2.1¶1: a product token "MUST contain only uppercase and
 * lowercase letters ("a-z" and "A-Z"), underscores ("_"), and hyphens
 * ("-")."
 */
export function isValidProductToken(token: string): boolean {
  return /^[A-Za-z_-]+$/.test(token);
}

/**
 * The group that applies to a product token.
 *
 * RFC 9309§2.2.1¶4: "Crawlers MUST use case-insensitive matching to find the
 * group that matches the product token and then obey the rules of the group.
 * If there is more than one group matching the user-agent, the matching
 * groups' rules MUST be combined into one group".
 *
 * RFC 9309§2.2.1¶6: "If no matching group exists, crawlers MUST obey the
 * group with a user-agent line with the "*" value, if present." Several `*`
 * groups are combined the same way.
 *
 * RFC 9309§2.2.1¶8: "If no group matches the product token and there is no
 * group with a user-agent line with the "*" value, or no groups are present
 * at all, no rules apply." That is `undefined` here.
 */
export function selectGroup(
  robots: ParsedRobots,
  productToken: string,
): GroupSelection | undefined {
  const token = productToken.toLowerCase();
  let chosen: RobotsGroup[] = robots.groups.filter((g) =>
    g.userAgents.includes(token),
  );
  let matchedBy = [token];
  if (chosen.length === 0) {
    chosen = robots.groups.filter((g) => g.userAgents.includes("*"));
    matchedBy = ["*"];
  }
  if (chosen.length === 0) return undefined;
  const delays = chosen
    .map((g) => g.crawlDelaySeconds)
    .filter((d): d is number => d !== undefined);
  return {
    matchedBy,
    rules: chosen.flatMap((g) => g.rules),
    ...(delays.length ? { crawlDelaySeconds: Math.max(...delays) } : {}),
    contentUsage: chosen.flatMap((g) => g.contentUsage),
  };
}

/**
 * The rule that decides a path, or undefined when none matches.
 *
 * RFC 9309§2.2.2¶2: "The most specific match found MUST be used. The most
 * specific match is the match that has the most octets. [...] If an "allow"
 * rule and a "disallow" rule are equivalent, then the "allow" rule SHOULD be
 * used." The octets counted are the normalised pattern's (every octet of it
 * is ASCII after normalisation), which is how the RFC's own example in
 * RFC 9309§5.2 picks `/example/page/disallowed.gif` over `/example/page/`.
 */
export function decidingRule(
  rules: RobotsRule[],
  path: string,
): RobotsRule | undefined {
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length &&
        rule.kind === "allow" &&
        best.kind === "disallow")
    ) {
      best = rule;
    }
  }
  return best;
}
