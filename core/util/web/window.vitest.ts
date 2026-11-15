import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  describeSize,
  formatCount,
  grepPage,
  MAX_GREP_MATCHES,
  preparePage,
  readOffset,
  readPage,
  readSection,
  readWebPage,
  splitLines,
  tokenCounterFor,
  WebPage,
  wholePageLimit,
  windowTokensFor,
} from "./window";

/** About four characters a token, like the estimate; deterministic. */
const count = (text: string) => Math.ceil(text.length / 4);

/** A long docs page: chapters with sections and paragraphs, about 40k tokens. */
function docsPage(chapters = 12, sections = 6, paragraphs = 8): string {
  const out: string[] = [
    "# Guide",
    "",
    "Intro paragraph about the product.",
    "",
  ];
  for (let c = 1; c <= chapters; c++) {
    out.push(`## Chapter ${c}`, "");
    for (let s = 1; s <= sections; s++) {
      out.push(`### Section ${c}.${s}`, "");
      for (let p = 1; p <= paragraphs; p++) {
        out.push(
          `Paragraph ${c}.${s}.${p}: requests are limited to ${c * 100} a minute; see the rate limit table for details on burst handling.`,
        );
      }
      out.push("");
    }
  }
  return out.join("\n");
}

function prepared(text: string, windowTokens = 1_500): WebPage {
  return preparePage(text, { windowTokens, count });
}

describe("windowTokensFor", () => {
  it.each([
    [200_000, undefined, 6_000],
    [128_000, undefined, 6_000],
    [120_000, undefined, 6_000],
    [100_000, undefined, 5_000],
    [32_000, undefined, 1_600],
    [32_768, undefined, 1_638],
    [30_000, undefined, 1_500],
    [8_000, undefined, 1_500],
    [1_000_000, undefined, 6_000],
    [0, undefined, 1_500],
    [undefined, undefined, 1_500],
    [Number.NaN, undefined, 1_500],
    [200_000, 2_500, 2_500],
    [8_000, 9_000, 9_000],
    [200_000, 0, 6_000],
    [200_000, -5, 6_000],
    [200_000, 1_234.9, 1_234],
  ])("context %s, configured %s: %s", (context, configured, expected) => {
    expect(windowTokensFor(context, configured)).toBe(expected);
  });

  it("returns a page up to 1.25 windows whole", () => {
    expect(wholePageLimit(6_000)).toBe(7_500);
    expect(wholePageLimit(1_500)).toBe(1_875);
    // 75 lines of 99 characters: 7,499 characters, 1,875 tokens
    const justUnder = Array(75).fill("x".repeat(99)).join("\n");
    const justOver = `${justUnder}\n${"y".repeat(8)}`;
    expect(prepared(justUnder).whole).toBe(true);
    expect(prepared(justUnder).pages).toHaveLength(1);
    expect(prepared(justOver).whole).toBe(false);
    expect(prepared(justOver).pages.length).toBeGreaterThan(1);
  });
});

describe("splitLines", () => {
  it.each([
    ["", []],
    ["a", ["a"]],
    ["a\n", ["a"]],
    ["a\r\nb\r\n", ["a", "b"]],
    ["a\rb", ["a", "b"]],
    ["a\n\nb", ["a", "", "b"]],
    ["\n", [""]],
    ["a\r\n\r\nb", ["a", "", "b"]],
  ])("%j", (text, lines) => {
    expect(splitLines(text).lines).toEqual(lines);
  });

  it("cuts long lines into virtual lines of 2,000 characters", () => {
    const { lines, continuation } = splitLines(`${"m".repeat(4_500)}\nshort`);
    expect(lines.map((l) => l.length)).toEqual([2_000, 2_000, 500, 5]);
    expect(continuation).toEqual([false, true, true, false]);
  });

  it("never cuts inside a surrogate pair", () => {
    const text = `${"a".repeat(1_999)}😀${"b".repeat(10)}`;
    const { lines } = splitLines(text);
    expect(lines[0]).toBe("a".repeat(1_999));
    expect(lines[1].startsWith("😀")).toBe(true);
    expect(lines.join("")).toBe(text);
  });

  it("a heading-looking continuation is not a heading", () => {
    const page = prepared(`${"z".repeat(2_000)}# not a heading\n# Real`);
    expect(page.headings.map((h) => h.text)).toEqual(["Real"]);
  });
});

describe("preparePage", () => {
  it("pages a long page at line boundaries within the window", () => {
    const page = prepared(docsPage());
    expect(page.whole).toBe(false);
    expect(page.pages.length).toBeGreaterThan(5);
    let expectedStart = 1;
    for (const p of page.pages) {
      expect(p.startLine).toBe(expectedStart);
      expect(p.tokens).toBeLessThanOrEqual(page.windowTokens);
      expectedStart = p.endLine + 1;
    }
    expect(expectedStart - 1).toBe(page.lines.length);
  });

  it("is byte-stable for the same input", () => {
    const text = docsPage();
    const a = JSON.stringify(prepared(text));
    const b = JSON.stringify(prepared(text));
    expect(a).toBe(b);
    const ra = JSON.stringify(grepPage(prepared(text), "rate limit", count));
    const rb = JSON.stringify(grepPage(prepared(text), "rate limit", count));
    expect(ra).toBe(rb);
  });

  it("is byte-stable across runs (golden digest)", () => {
    // Changes only when the paging, outline or output shapes change on purpose
    const page = prepared(docsPage());
    const results = [
      page.pages,
      page.outline.text,
      readWebPage(page, {}, count),
      readWebPage(page, { section: "Chapter 3" }, count),
      readWebPage(page, { offset: 400, lines: 20 }, count),
      readWebPage(page, { grep: "paragraph 2\\.3\\.[12]", context: 1 }, count),
    ];
    const digest = createHash("sha256")
      .update(JSON.stringify(results))
      .digest("hex");
    expect(digest).toBe(
      "e9dac4caf42321324c855ca244ca4e18c1f88155d1b9c2d7143f9eea03daff38",
    );
  });

  it("CRLF and LF give the same page", () => {
    const lf = docsPage(3);
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(JSON.stringify(prepared(crlf))).toBe(JSON.stringify(prepared(lf)));
  });

  it("a short page is one page", () => {
    const page = prepared("# Hello\n\nWorld");
    expect(page.whole).toBe(true);
    expect(page.pages).toEqual([
      { page: 1, startLine: 1, endLine: 3, tokens: page.totalTokens },
    ]);
    expect(describeSize(page)).toBe(`3 lines, ~${page.totalTokens} tokens`);
  });

  it("an empty page has one empty page", () => {
    const page = prepared("");
    expect(page.lines).toEqual([]);
    expect(page.pages).toHaveLength(1);
    expect(readPage(page, 1, count).ok).toBe(false);
  });

  it("says the size of a paged page", () => {
    const page = prepared(docsPage());
    expect(describeSize(page)).toBe(
      `${formatCount(page.lines.length)} lines, ~${formatCount(page.totalTokens)} tokens in ${page.pages.length} pages of up to ~1,500`,
    );
  });

  it("minified text still pages (virtual lines)", () => {
    const page = prepared(`<p>${"word ".repeat(10_000)}</p>`);
    expect(page.lines.length).toBe(Math.ceil((10_000 * 5 + 7) / 2_000));
    expect(page.pages.length).toBeGreaterThan(1);
  });

  it("works with the product's token counter", () => {
    const real = tokenCounterFor("gpt-4");
    const text = docsPage(4);
    const a = preparePage(text, { windowTokens: 1_500, count: real });
    const b = preparePage(text, { windowTokens: 1_500, count: real });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.totalTokens).toBeGreaterThan(1_000);
    for (const p of a.pages) expect(p.tokens).toBeLessThanOrEqual(1_500);
    expect(real("")).toBe(0);
  });
});

describe("readPage and readOffset", () => {
  const page = prepared(docsPage());

  it("reads a page with its range and next step", () => {
    const read = readPage(page, 2, count);
    if (!read.ok) throw new Error(read.message);
    const p2 = page.pages[1];
    expect(read.startLine).toBe(p2.startLine);
    expect(read.endLine).toBe(p2.endLine);
    expect(read.range).toBe(
      `lines ${formatCount(p2.startLine)}-${formatCount(p2.endLine)} of ${formatCount(page.lines.length)} · page 2 of ${page.pages.length} · ~${formatCount(p2.tokens)} tokens`,
    );
    expect(read.next).toBe(
      `Next: page 3, or offset ${formatCount(p2.endLine + 1)}.`,
    );
  });

  it("the last page says it is the end", () => {
    const read = readPage(page, page.pages.length, count);
    expect(read.ok && read.next).toBe("End of the page.");
  });

  it.each([0, -1, 1.5, "x", 9_999, undefined])("page %s is refused", (n) => {
    const read = readPage(page, n, count);
    expect(read.ok).toBe(false);
  });

  it("accepts a page number given as a string", () => {
    expect(readPage(page, "3", count).ok).toBe(true);
  });

  it("offset without lines fills one window", () => {
    const read = readOffset(page, 10, undefined, count);
    if (!read.ok) throw new Error(read.message);
    expect(read.startLine).toBe(10);
    expect(read.tokens).toBeLessThanOrEqual(page.windowTokens);
    expect(read.cut).toBe(false);
    expect(read.next).toBe(`Next: offset ${read.endLine + 1}.`);
  });

  it("offset with lines returns that many", () => {
    const read = readOffset(page, 10, 5, count);
    expect(read.ok && [read.startLine, read.endLine, read.cut]).toEqual([
      10,
      14,
      false,
    ]);
    expect(read.ok && read.text.split("\n")).toHaveLength(5);
  });

  it("offset with too many lines is cut at one window and says so", () => {
    const read = readOffset(page, 1, 900, count);
    expect(read.ok && read.cut).toBe(true);
    expect(read.ok && read.tokens).toBeLessThanOrEqual(page.windowTokens);
  });

  it("offset past the end is refused", () => {
    const read = readOffset(page, page.lines.length + 1, undefined, count);
    expect(read.ok).toBe(false);
  });
});

describe("readSection", () => {
  const page = prepared(docsPage());

  it.each([
    ["2", "Chapter 1"],
    ["§3", "Section 1.1"],
    [3, "Section 1.1"],
    ["chapter 2", "Chapter 2"],
    ["CHAPTER 12", "Chapter 12"],
    ["section-11", "Section 1.1"],
    ["#chapter-3", "Chapter 3"],
    ["Section 4.", "Section 4.1"],
  ])("%s is %s", (ref, text) => {
    const read = readSection(page, ref, count);
    if (!read.ok) throw new Error(read.message);
    expect(read.section?.text).toBe(text);
    expect(read.text.split("\n")[0]).toMatch(new RegExp(`^#+ ${text}$`));
  });

  it("exact text beats a prefix", () => {
    const p = prepared("# Install\n\nA\n\n# Install on Windows\n\nB");
    const read = readSection(p, "install", count);
    expect(read.ok && read.section?.line).toBe(1);
    expect(read.ok && read.text).toBe("# Install\n\nA\n");
  });

  it("a section ends before the next heading of the same or higher level", () => {
    const read = readSection(page, "Section 1.1", count);
    if (!read.ok) throw new Error(read.message);
    const next = page.headings.find((h) => h.text === "Section 1.2")!;
    expect(read.endLine).toBe(next.line - 1);
    expect(read.cut).toBe(false);
    expect(read.range.startsWith("§3 Section 1.1 · lines ")).toBe(true);
  });

  it("a section larger than the window returns its first window", () => {
    const read = readSection(page, "Guide", count);
    if (!read.ok) throw new Error(read.message);
    expect(read.cut).toBe(true);
    expect(read.tokens).toBeLessThanOrEqual(page.windowTokens);
    expect(read.next).toBe(`§1 continues: offset ${read.endLine + 1}.`);
  });

  it("an unknown section is refused with the range", () => {
    const read = readSection(page, "Pricing", count);
    expect(!read.ok && read.message).toMatch(/No section matches "Pricing"/);
  });

  it("a page without headings says so", () => {
    const read = readSection(prepared("plain\ntext"), "1", count);
    expect(!read.ok && read.message).toMatch(/no headings/);
  });

  it("unicode headings match by text and id", () => {
    const p = prepared(
      "# Überblick\n\ntext\n\n## 安装指南\n\nmore\n\n## Café & Crème\n\nend",
    );
    expect(p.headings.map((h) => h.slug)).toEqual([
      "überblick",
      "安装指南",
      "café--crème",
    ]);
    const byText = readSection(p, "ÜBERBLICK", count);
    expect(byText.ok && byText.section?.n).toBe(1);
    const cjk = readSection(p, "安装", count);
    expect(cjk.ok && cjk.section?.n).toBe(2);
    const byId = readSection(p, "café--crème", count);
    expect(byId.ok && byId.section?.n).toBe(3);
  });
});

describe("grepPage", () => {
  const text = [
    "# API",
    "intro",
    "## Rate limits",
    "Requests are limited to 600 a minute per key.",
    "A rate-limit response is 429.",
    "## Errors",
    "An error body is JSON.",
    "Retry after a rate limit with backoff.",
  ].join("\n");
  const page = prepared(text);

  it("returns numbered matches with their sections", () => {
    const g = grepPage(page, "rate.?limit", count);
    if (!g.ok) throw new Error(g.message);
    expect(g.header).toBe('3 lines match "rate.?limit" (of 8)');
    expect(g.lines).toEqual([
      "3 [§2 Rate limits]: ## Rate limits",
      "5 [§2 Rate limits]: A rate-limit response is 429.",
      "8 [§3 Errors]: Retry after a rate limit with backoff.",
    ]);
    expect(g.footer).toBe(
      "Read a match in context with offset (e.g. offset 1).",
    );
  });

  it("is case-insensitive", () => {
    const g = grepPage(page, "REQUESTS", count);
    expect(g.ok && g.matchLines).toEqual([4]);
  });

  it("lines before any heading have no section", () => {
    const g = grepPage(prepared("before\n# H\nafter before"), "before", count);
    expect(g.ok && g.lines).toEqual(["1: before", "3 [§1 H]: after before"]);
  });

  it("an invalid expression is matched as plain text and says so", () => {
    const g = grepPage(prepared("call f(x\nother"), "f(x", count);
    if (!g.ok) throw new Error(g.message);
    expect(g.literal).toBe(true);
    expect(g.matchLines).toEqual([1]);
    expect(g.footer.split("\n")[0]).toBe(
      '["f(x" is not a valid regular expression, so it was matched as plain text]',
    );
  });

  it("plain mode does not read the pattern as an expression", () => {
    const g = grepPage(prepared("a.b\naxb"), "a.b", count, { literal: true });
    expect(g.ok && g.matchLines).toEqual([1]);
    const r = grepPage(prepared("a.b\naxb"), "a.b", count);
    expect(r.ok && r.matchLines).toEqual([1, 2]);
  });

  it("shows context lines and separates groups", () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      i === 4 || i === 6 || i === 20 ? `hit ${i + 1}` : `line ${i + 1}`,
    );
    const g = grepPage(prepared(lines.join("\n")), "hit", count, {
      context: 1,
    });
    expect(g.ok && g.lines).toEqual([
      "4- line 4",
      "5: hit 5",
      "6- line 6",
      "7: hit 7",
      "8- line 8",
      "--",
      "20- line 20",
      "21: hit 21",
      "22- line 22",
    ]);
  });

  it("adjacent matches keep the context after the last one; empty context lines have no space", () => {
    const g = grepPage(prepared("a\n\nhit\nhit\nb\nc"), "hit", count, {
      context: 1,
    });
    expect(g.ok && g.lines).toEqual(["2-", "3: hit", "4: hit", "5- b"]);
    expect(g.ok && g.matchLines).toEqual([3, 4]);
  });

  it("quotes the pattern as given", () => {
    const g = grepPage(page, "rate\\.limit", count);
    expect(g.ok && g.header).toBe('0 lines match "rate\\.limit" (of 8)');
  });

  it("caps the matches at 200 and says there are more", () => {
    const many = Array.from({ length: 500 }, (_, i) => `x${i}`).join("\n");
    const g = grepPage(prepared(many, 100_000), "x", count);
    if (!g.ok) throw new Error(g.message);
    expect(g.shown).toBe(MAX_GREP_MATCHES);
    expect(g.matchCount).toBe(500);
    expect(g.more).toBe(true);
    expect(g.footer).toContain("[more than 200 matches; narrow the pattern]");
    expect(g.header).toBe('500 lines match "x" (of 500)');
  });

  it("honours a smaller limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => `x${i}`).join("\n");
    const g = grepPage(prepared(many), "x", count, { limit: 3 });
    expect(g.ok && g.matchLines).toEqual([1, 2, 3]);
    expect(g.ok && g.footer).toContain("[more than 3 matches");
  });

  it("stops at one window of text", () => {
    const many = Array.from(
      { length: 150 },
      (_, i) => `match ${i} ${"padding ".repeat(20)}`,
    ).join("\n");
    const g = grepPage(prepared(many, 1_500), "match", count);
    if (!g.ok) throw new Error(g.message);
    expect(g.cutAtWindow).toBe(true);
    expect(g.more).toBe(false);
    expect(g.shown).toBeLessThan(150);
    expect(count(g.lines.join("\n"))).toBeLessThanOrEqual(1_500);
    expect(g.footer).toContain("did not fit in one result");
  });

  it("no match says so", () => {
    const g = grepPage(page, "zebra", count);
    expect(g.ok && g.footer).toBe("[no line matches]");
    expect(g.ok && g.header).toBe('0 lines match "zebra" (of 8)');
  });

  it("an empty pattern is refused", () => {
    expect(grepPage(page, "", count).ok).toBe(false);
  });

  it("CRLF text greps the same as LF", () => {
    const g = grepPage(prepared(text.replace(/\n/g, "\r\n")), "rate", count);
    const h = grepPage(page, "rate", count);
    expect(JSON.stringify(g)).toBe(JSON.stringify(h));
  });
});

describe("readWebPage", () => {
  const page = prepared(docsPage());

  it("defaults to page 2", () => {
    const { read, ignored } = readWebPage(page, {}, count);
    expect(read.ok && read.selector === "page" && read.page).toBe(2);
    expect(ignored).toEqual([]);
  });

  it("defaults to page 1 of a one-page result", () => {
    const { read } = readWebPage(prepared("short"), {}, count);
    expect(read.ok && read.selector === "page" && read.page).toBe(1);
  });

  it.each([
    [{ section: "2", page: 3, grep: "x" }, "section", ["page", "grep"]],
    [{ page: 3, offset: 10 }, "page", ["offset"]],
    [{ offset: 10, grep: "x" }, "offset", ["grep"]],
    [{ grep: "rate" }, "grep", []],
    [{ grep: "", page: 2 }, "page", []],
  ])("%j uses %s", (args, selector, ignored) => {
    const result = readWebPage(page, args, count);
    expect(result.read.selector).toBe(selector);
    expect(result.ignored).toEqual(ignored);
  });

  it("grep with lines caps the matches", () => {
    const { read } = readWebPage(page, { grep: "paragraph", lines: 4 }, count);
    expect(read.ok && read.selector === "grep" && read.shown).toBe(4);
  });
});
