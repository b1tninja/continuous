/**
 * RFC 9309 conformance: the RFC's own examples (§2.2.1 Figures 2 and 3,
 * §2.2.2 Figure 4, §2.2.3 Figure 6, §5.1, §5.2) and the normative
 * statements the parser and matcher implement, as tables.
 */
import { describe, expect, it } from "vitest";

import {
  decidingRule,
  normalizePattern,
  parseRobotsTxt,
  pathToMatch,
  patternMatches,
  selectGroup,
} from "./index";

/** The verdict for a path under a product token, from the file alone. */
function judge(
  file: string,
  token: string,
  path: string,
): { allowed: boolean; rule?: string } {
  const robots = parseRobotsTxt(file);
  const selection = selectGroup(robots, token);
  if (!selection) return { allowed: true };
  const rule = decidingRule(
    selection.rules,
    pathToMatch(new URL(path, "https://www.example.com")),
  );
  if (!rule) return { allowed: true };
  return { allowed: rule.kind === "allow", rule: `${rule.kind}: ${rule.raw}` };
}

// RFC 9309§5.1¶3, verbatim
const SIMPLE_EXAMPLE = `User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot

EOF
`;

describe("RFC 9309§5.1 simple example", () => {
  it.each([
    // "*": the group for every agent with no group of its own
    ["otherbot", "/publications/paper.html", true, "allow: /publications/"],
    ["otherbot", "/example/", false, "disallow: /example/"],
    ["otherbot", "/example/page.html", false, "disallow: /example/"],
    // "The "*" character designates any character, including the otherwise-required forward slash"
    ["otherbot", "/images/a/b/logo.gif", false, "disallow: *.gif$"],
    ["otherbot", "/logo.gif?size=2", true, undefined],
    ["otherbot", "/logo.gifs", true, undefined],
    // The longer allow beats the shorter disallow
    ["otherbot", "/publications/fig.gif", true, "allow: /publications/"],
    ["otherbot", "/", true, undefined],
    // foobot: only two URL path prefixes
    ["foobot", "/example/page.html", true, "allow: /example/page.html"],
    ["foobot", "/example/allowed.gif", true, "allow: /example/allowed.gif"],
    ["foobot", "/example/other.html", false, "disallow: /"],
    ["foobot", "/", false, "disallow: /"],
    ["foobot", "/publications/", false, "disallow: /"],
    // barbot and bazbot share one group
    ["barbot", "/example/page.html", false, "disallow: /example/page.html"],
    ["bazbot", "/example/page.html", false, "disallow: /example/page.html"],
    ["bazbot", "/example/page.html5", false, "disallow: /example/page.html"],
    ["barbot", "/example/", true, undefined],
    ["barbot", "/logo.gif", true, undefined],
    // quxbot: an empty group at the end, unrestricted (it does not fall back to "*")
    ["quxbot", "/example/", true, undefined],
    ["quxbot", "/logo.gif", true, undefined],
    // RFC 9309§2.2.1¶4: case-insensitive token matching
    ["FooBot", "/example/other.html", false, "disallow: /"],
    ["BAZBOT", "/example/page.html", false, "disallow: /example/page.html"],
  ])("%s %s -> allowed %s", (token, path, allowed, rule) => {
    expect(judge(SIMPLE_EXAMPLE, token, path)).toEqual(
      rule ? { allowed, rule } : { allowed },
    );
  });

  it("parses every group of the example", () => {
    const robots = parseRobotsTxt(SIMPLE_EXAMPLE);
    expect(robots.groups.map((g) => g.userAgents)).toEqual([
      ["*"],
      ["foobot"],
      ["barbot", "bazbot"],
      ["quxbot"],
    ]);
    expect(robots.groups[3].rules).toEqual([]);
  });
});

describe("RFC 9309§5.2 longest match", () => {
  // RFC 9309§5.2¶2, verbatim
  const file = `User-Agent: foobot
Allow: /example/page/
Disallow: /example/page/disallowed.gif
`;
  it.each([
    // The RFC's sentence names the URI ".../disallow.gif"; erratum 7124
    // (reported, not verified) says it means ".../disallowed.gif"
    [
      "/example/page/disallowed.gif",
      false,
      "disallow: /example/page/disallowed.gif",
    ],
    // Read literally, "disallow.gif" matches only the allow
    ["/example/page/disallow.gif", true, "allow: /example/page/"],
    ["/example/page/", true, "allow: /example/page/"],
    ["/example/", true, undefined],
  ])("%s -> allowed %s", (path, allowed, rule) => {
    expect(judge(file, "foobot", path)).toEqual(
      rule ? { allowed, rule } : { allowed },
    );
  });
});

describe("RFC 9309§2.2.1 group selection", () => {
  it("combines groups that match the same token (Figure 2)", () => {
    const file = `user-agent: ExampleBot
disallow: /foo
disallow: /bar

user-agent: ExampleBot
disallow: /baz
`;
    const selection = selectGroup(parseRobotsTxt(file), "ExampleBot");
    expect(selection?.rules.map((r) => r.raw)).toEqual([
      "/foo",
      "/bar",
      "/baz",
    ]);
    expect(judge(file, "examplebot", "/baz/x").allowed).toBe(false);
  });

  it("falls back to the * group when no group matches (Figure 3)", () => {
    const file = `user-agent: *
disallow: /foo
disallow: /bar

user-agent: BazBot
disallow: /baz
`;
    const selection = selectGroup(parseRobotsTxt(file), "ExampleBot");
    expect(selection?.matchedBy).toEqual(["*"]);
    expect(selection?.rules.map((r) => r.raw)).toEqual(["/foo", "/bar"]);
    expect(judge(file, "ExampleBot", "/baz").allowed).toBe(true);
  });

  it.each([
    ["no * group", "user-agent: BazBot\ndisallow: /\n"],
    ["no groups at all", "disallow: /\n# nothing else\n"],
    ["an empty file", ""],
  ])("applies no rules with %s (§2.2.1¶8)", (_label, file) => {
    expect(selectGroup(parseRobotsTxt(file), "ExampleBot")).toBeUndefined();
    expect(judge(file, "ExampleBot", "/anything").allowed).toBe(true);
  });

  it("reads the product token out of a user-agent value with a version", () => {
    // Figure 1: the product token is a substring of the User-Agent header
    const file = "User-agent: ExampleBot/0.1\nDisallow: /private\n";
    expect(judge(file, "ExampleBot", "/private").allowed).toBe(false);
  });

  it("does not match a token by prefix", () => {
    const file = "User-agent: ExampleBotNews\nDisallow: /\n";
    expect(judge(file, "ExampleBot", "/").allowed).toBe(true);
  });

  it("starts a new group at a user-agent line after a rule (§2.1¶2)", () => {
    const file = `User-agent: a
Disallow: /a
User-agent: b
Disallow: /b
`;
    expect(judge(file, "a", "/b").allowed).toBe(true);
    expect(judge(file, "b", "/a").allowed).toBe(true);
    expect(judge(file, "b", "/b").allowed).toBe(false);
  });

  it("keeps collecting user-agent lines across empty lines (§2.2 ABNF)", () => {
    const file = "User-agent: a\n\nUser-agent: b\nDisallow: /x\n";
    expect(judge(file, "a", "/x").allowed).toBe(false);
    expect(judge(file, "b", "/x").allowed).toBe(false);
  });
});

describe("RFC 9309§2.2.2 allow and disallow", () => {
  it.each([
    // "The most specific match is the match that has the most octets"
    ["allow: /a\ndisallow: /a/b", "/a/b/c", false],
    ["disallow: /a\nallow: /a/b", "/a/b/c", true],
    // "If an "allow" rule and a "disallow" rule are equivalent, then the "allow" rule SHOULD be used."
    ["disallow: /page\nallow: /page", "/page", true],
    ["allow: /page\ndisallow: /page", "/page", true],
    ["disallow: /*.php\nallow: /x.php", "/x.php", true],
    // "The matching SHOULD be case sensitive."
    ["disallow: /Private", "/private", true],
    ["disallow: /Private", "/Private/x", false],
    // "The matching MUST start with the first octet of the path."
    ["disallow: /b", "/a/b", true],
    // "If no match is found [...] the URI is allowed."
    ["disallow: /x", "/y", true],
    // An empty pattern names no path: "Disallow:" disallows nothing
    ["disallow:", "/", true],
    ["disallow: \nallow:", "/x", true],
    // The query is part of what is matched
    ["disallow: /search?q=", "/search?q=cats", false],
    ["disallow: /search?q=", "/search", true],
  ])("%j on %s -> allowed %s", (rules, path, allowed) => {
    expect(judge(`user-agent: *\n${rules}\n`, "bot", path).allowed).toBe(
      allowed,
    );
  });

  it("ignores rules before the first user-agent line (§2.2.2¶7)", () => {
    const file = "Disallow: /\nUser-agent: *\nDisallow: /private\n";
    expect(judge(file, "bot", "/public").allowed).toBe(true);
    expect(judge(file, "bot", "/private").allowed).toBe(false);
  });

  it("names the rule that decided, with its line", () => {
    const robots = parseRobotsTxt("user-agent: *\n\ndisallow: /a # why\n");
    const rule = decidingRule(selectGroup(robots, "bot")!.rules, "/a/b");
    expect(rule).toMatchObject({ kind: "disallow", raw: "/a", line: 3 });
  });
});

describe("RFC 9309§2.2.2 percent-encoding (Figure 4)", () => {
  it.each([
    // [encoded path, path to match], the rows of Figure 4
    ["/foo/bar?baz=quz", "/foo/bar?baz=quz"],
    [
      "/foo/bar?baz=https%3A%2F%2Ffoo.bar",
      "/foo/bar?baz=https%3A%2F%2Ffoo.bar",
    ],
    ["/foo/bar/%E3%83%84", "/foo/bar/%E3%83%84"],
    ["/foo/bar/%62%61%7A", "/foo/bar/baz"],
  ])("%s is matched as %s", (encoded, expected) => {
    expect(pathToMatch(new URL(encoded, "https://example.com"))).toBe(expected);
    expect(normalizePattern(encoded)).toBe(expected);
  });

  it("encodes a non-ASCII path before comparing (§2.2.2¶3; Figure 4 row 3, U+30C4 per erratum 7128)", () => {
    expect(normalizePattern("/foo/bar/ツ")).toBe("/foo/bar/%E3%83%84");
    expect(
      judge(
        "user-agent: *\ndisallow: /foo/bar/ツ\n",
        "bot",
        "/foo/bar/%E3%83%84",
      ).allowed,
    ).toBe(false);
    expect(
      judge(
        "user-agent: *\ndisallow: /foo/bar/%E3%83%84\n",
        "bot",
        "/foo/bar/ツ",
      ).allowed,
    ).toBe(false);
  });

  it("decodes unreserved characters only, and upper-cases the rest (RFC 3986§2.3, §6.2.2.1)", () => {
    expect(normalizePattern("/%7euser/%2fx/%e3%83%84")).toBe(
      "/~user/%2Fx/%E3%83%84",
    );
    // An encoded "/" is not the same path as a literal one
    expect(
      judge("user-agent: *\ndisallow: /a/b\n", "bot", "/a%2Fb").allowed,
    ).toBe(true);
    // An encoded unreserved letter is the same path
    expect(
      judge("user-agent: *\ndisallow: /baz\n", "bot", "/%62az").allowed,
    ).toBe(false);
  });

  it("leaves a stray % as it is", () => {
    expect(normalizePattern("/100%")).toBe("/100%");
    expect(normalizePattern("/a%zz")).toBe("/a%zz");
  });
});

describe("RFC 9309§2.2.3 special characters", () => {
  it.each([
    // Figure 5
    ["allow: /this/path/exactly$", "/this/path/exactly", true],
    ["disallow: /this/path/exactly$", "/this/path/exactly", false],
    ["disallow: /this/path/exactly$", "/this/path/exactly/more", true],
    ["disallow: /this/*/exactly", "/this/a/b/exactly", false],
    ["disallow: /this/*/exactly", "/this//exactly", false],
    ["disallow: /this/*/exactly", "/this/exactly", true],
    ["disallow: /*", "/anything", false],
    ["disallow: /a*b*c$", "/a-b-c", false],
    ["disallow: /a*b*c$", "/a-b-c-d", true],
    ["disallow: /a**b", "/a/x/b", false],
    // "#" designates a line comment
    ["disallow: /a # comment in line", "/a", false],
    ["# disallow: /a", "/a", true],
    // A "$" inside the pattern is not an anchor
    ["disallow: /a$b", "/a$b", false],
    ["disallow: /a$b", "/a", true],
  ])("%j on %s -> allowed %s", (rules, path, allowed) => {
    expect(judge(`user-agent: *\n${rules}\n`, "bot", path).allowed).toBe(
      allowed,
    );
  });

  it.each([
    // Figure 6: an encoded special character matches the literal one in the URI
    ["/path/file-with-a-%2A.html", "/path/file-with-a-*.html", false],
    ["/path/foo-%24", "/path/foo-$", false],
    // and is not a wildcard or an anchor
    ["/path/file-with-a-%2A.html", "/path/file-with-a-x.html", true],
  ])("disallow %s on %s -> allowed %s", (pattern, path, allowed) => {
    expect(
      judge(`user-agent: *\ndisallow: ${pattern}\n`, "bot", path).allowed,
    ).toBe(allowed);
  });
});

describe("parsing", () => {
  it("accepts every line ending (§2.2 NL), a BOM, tabs and any key case", () => {
    const file = "﻿USER-AGENT:\tbot\r\nDISALLOW :\t/a\rAllow: /a/b\n";
    expect(judge(file, "bot", "/a/x").allowed).toBe(false);
    expect(judge(file, "bot", "/a/b").allowed).toBe(true);
  });

  it("keeps a group open across a Sitemap line (§2.2.4¶2)", () => {
    const file = `User-agent: a
Sitemap: https://example.com/sitemap.xml
User-agent: b
Disallow: /x
`;
    const robots = parseRobotsTxt(file);
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(judge(file, "a", "/x").allowed).toBe(false);
  });

  it("skips lines it cannot parse and uses the rest (§2.3.1.5¶1)", () => {
    const file =
      "User-agent: *\nthis is not a record\nfoo: bar\nDisallow: /x\n";
    expect(judge(file, "bot", "/x").allowed).toBe(false);
  });

  it("accepts common misspellings (§2.2.4¶1)", () => {
    const file = "Useragent: bot\nDissallow: /x\n";
    expect(judge(file, "bot", "/x").allowed).toBe(false);
  });

  it("reads Crawl-delay per group, the largest when groups combine", () => {
    const robots = parseRobotsTxt(
      "User-agent: bot\nCrawl-delay: 2\nUser-agent: bot\nCrawl-delay: 5\nUser-agent: *\nCrawl-delay: nope\n",
    );
    expect(selectGroup(robots, "bot")?.crawlDelaySeconds).toBe(5);
    expect(selectGroup(robots, "other")?.crawlDelaySeconds).toBeUndefined();
    // A Crawl-delay ends the run of user-agent lines, like a rule
    const split = parseRobotsTxt(
      "User-agent: a\nCrawl-delay: 5\nUser-agent: b\nDisallow: /x\n",
    );
    expect(split.groups.map((g) => g.userAgents)).toEqual([["a"], ["b"]]);
  });

  it("records Content-Usage at file level and per group, and it decides nothing", () => {
    const file = `Content-Usage: train-ai=n
User-agent: *
Content-Usage: /docs/ ai-use=y
Disallow: /x
`;
    const robots = parseRobotsTxt(file);
    expect(robots.contentUsage).toEqual(["train-ai=n"]);
    expect(selectGroup(robots, "bot")?.contentUsage).toEqual([
      "/docs/ ai-use=y",
    ]);
    expect(judge(file, "bot", "/docs/a").allowed).toBe(true);
  });

  it("never throws on arbitrary bytes", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let n = 0; n < 200; n++) {
      const bytes = new Uint8Array(next() % 400);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] =
          n % 2
            ? next() & 0xff
            : "ua:*/$#\n\r disallow".charCodeAt(next() % 18);
      }
      const robots = parseRobotsTxt(bytes);
      expect(() => selectGroup(robots, "bot")).not.toThrow();
    }
  });
});

describe("patternMatches against a reference", () => {
  // The reference: a regular expression built from the pattern
  const reference = (pattern: string, path: string) => {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${source}${anchored ? "$" : ""}`, "s").test(path);
  };

  it("agrees on random short patterns and paths", () => {
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    const alphabet = "/ab*";
    for (let n = 0; n < 5000; n++) {
      let pattern = "";
      for (let i = next() % 7; i > 0; i--) pattern += alphabet[next() % 4];
      if (next() % 3 === 0) pattern += "$";
      let path = "";
      for (let i = next() % 9; i > 0; i--) path += "/ab"[next() % 3];
      expect(patternMatches(pattern, path), `${pattern} on ${path}`).toBe(
        reference(pattern, path),
      );
    }
  });

  it("stays fast on a pattern built to backtrack", () => {
    const pattern = `/${"*a".repeat(200)}$`;
    const path = `/${"a".repeat(5000)}b`;
    const started = Date.now();
    expect(patternMatches(pattern, path)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
