import { describe, expect, it } from "vitest";

import {
  buildOutline,
  cleanHeadingText,
  findSection,
  formatCount,
  headingAt,
  headingSlug,
  jsonTopLevelKeys,
  OUTLINE_MAX_ENTRIES,
  OUTLINE_MAX_TOKENS,
  parseHeadings,
} from "./outline";
import { preparePage } from "./window";

const count = (text: string) => Math.ceil(text.length / 4);

function outlineOf(text: string, windowTokens = 1_500) {
  return preparePage(text, { windowTokens, count });
}

function headingsOf(text: string) {
  const lines = text.split("\n");
  return parseHeadings(
    lines,
    lines.map((l) => count(l)),
  );
}

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1,000"],
    [1_530, "1,530"],
    [1_234_567, "1,234,567"],
    [-4_000, "-4,000"],
  ])("%d is %s", (n, text) => {
    expect(formatCount(n)).toBe(text);
  });
});

describe("parseHeadings", () => {
  it("reads # to #### and skips ##### and deeper", () => {
    const h = headingsOf("# A\n## B\n### C\n#### D\n##### E\n###### F");
    expect(h.map((x) => [x.n, x.level, x.text])).toEqual([
      [1, 1, "A"],
      [2, 2, "B"],
      [3, 3, "C"],
      [4, 4, "D"],
    ]);
  });

  it("ignores headings in fenced code", () => {
    const h = headingsOf(
      "# Real\n```bash\n# a comment\n```\n~~~~\n## not\n~~~\n## still not\n~~~~\n## Also real",
    );
    expect(h.map((x) => x.text)).toEqual(["Real", "Also real"]);
  });

  it("requires a space after the #s, strips closing #s", () => {
    const h = headingsOf(
      "#hashtag\n## Title ##\n   ### Indented\n    #### Code",
    );
    expect(h.map((x) => x.text)).toEqual(["Title", "Indented"]);
  });

  it("cleans heading text: links, whitespace, hidden characters, 80 characters", () => {
    expect(cleanHeadingText("[Install](https://x/y)  the   tool")).toBe(
      "Install the tool",
    );
    expect(cleanHeadingText("A​B")).toBe("AB");
    expect(cleanHeadingText("![logo](https://evil/?q=1) Title")).toBe(
      "[image: logo] Title",
    );
    const long = "é".repeat(100);
    expect(Array.from(cleanHeadingText(long))).toHaveLength(80);
    const emoji = "😀".repeat(100);
    expect(cleanHeadingText(emoji)).toBe("😀".repeat(80));
  });

  it("sections end at the next heading of the same or higher level", () => {
    const h = headingsOf("# A\nx\n## B\ny\n### C\nz\n## D\nw\n# E\nv");
    expect(h.map((x) => [x.text, x.line, x.endLine])).toEqual([
      ["A", 1, 8],
      ["B", 3, 6],
      ["C", 5, 6],
      ["D", 7, 8],
      ["E", 9, 10],
    ]);
  });

  it("gives duplicate headings distinct ids", () => {
    const h = headingsOf("## Example\n## Example\n## Example");
    expect(h.map((x) => x.slug)).toEqual(["example", "example-1", "example-2"]);
  });

  it("sizes each section from its lines' tokens", () => {
    const h = headingsOf(`# A\n${"x".repeat(400)}\n# B\nyy`);
    expect(h.map((x) => x.tokens)).toEqual([1 + 100, 1 + 1]);
  });

  it("headingAt finds the innermost heading at or before a line", () => {
    const h = headingsOf("intro\n# A\nx\n## B\ny");
    expect(headingAt(h, 1)).toBeUndefined();
    expect(headingAt(h, 2)?.text).toBe("A");
    expect(headingAt(h, 3)?.text).toBe("A");
    expect(headingAt(h, 5)?.text).toBe("B");
  });

  it("findSection: number, id, exact, prefix", () => {
    const h = headingsOf("# Setup\n# Setup on macOS\n# Usage");
    expect(findSection(h, 3)?.text).toBe("Usage");
    expect(findSection(h, "§2")?.text).toBe("Setup on macOS");
    expect(findSection(h, "setup")?.n).toBe(1);
    expect(findSection(h, "setup-on-macos")?.n).toBe(2);
    expect(findSection(h, "us")?.n).toBe(3);
    expect(findSection(h, "99")).toBeUndefined();
    expect(findSection(h, "  ")).toBeUndefined();
  });

  it.each([
    ["Rate limits", "rate-limits"],
    ["What's new in v2.0?", "whats-new-in-v20"],
    ["snake_case and-dash", "snake_case-and-dash"],
    ["Überblick", "überblick"],
    ["Привет мир", "привет-мир"],
  ])("headingSlug(%j) is %s", (text, slug) => {
    expect(headingSlug(text)).toBe(slug);
  });
});

describe("buildOutline", () => {
  it("lists every heading of a small outline", () => {
    const page = outlineOf("# Guide\nintro\n## Install\nsteps\n## Use\nmore");
    expect(page.outline.kind).toBe("headings");
    expect(page.outline.text).toBe(
      [
        "§1 Guide (line 1, ~12)",
        "§2 Install (line 3, ~5)",
        "§3 Use (line 5, ~3)",
      ].join("\n"),
    );
  });

  it("drops #### first, then ###, and says so; numbers stay", () => {
    const parts: string[] = [];
    for (let a = 1; a <= 10; a++) {
      parts.push(`## Part ${a}`);
      for (let b = 1; b <= 8; b++) {
        parts.push(`### Topic ${a}.${b}`);
        for (let c = 1; c <= 2; c++) parts.push(`#### Detail ${a}.${b}.${c}`);
      }
    }
    const page = outlineOf(parts.join("\n"));
    expect(page.headings).toHaveLength(10 + 80 + 160);
    expect(page.outline.droppedLevels).toEqual([3, 4]);
    expect(page.outline.entries).toHaveLength(10);
    expect(page.outline.entries[1]).toBe(
      `§26 Part 2 (line 26, ~${formatCount(page.headings[25].tokens)})`,
    );
    expect(page.outline.text.endsWith("### and #### headings not shown")).toBe(
      true,
    );
  });

  it("drops only #### when the rest fits", () => {
    const parts: string[] = [];
    for (let a = 1; a <= 10; a++) {
      parts.push(`## Part ${a}`);
      for (let c = 1; c <= 8; c++) parts.push(`#### Detail ${a}.${c}`);
    }
    const page = outlineOf(parts.join("\n"));
    expect(page.outline.droppedLevels).toEqual([4]);
    expect(page.outline.entries).toHaveLength(10);
    expect(page.outline.text.split("\n").pop()).toBe("#### headings not shown");
  });

  it("cuts a flat outline at the caps and counts the rest", () => {
    const flat = Array.from(
      { length: 150 },
      (_, i) => `## Heading number ${i + 1}`,
    );
    const page = outlineOf(flat.join("\n"));
    const { entries, omitted, text } = page.outline;
    expect(entries.length).toBeLessThanOrEqual(OUTLINE_MAX_ENTRIES);
    expect(entries.length + omitted).toBe(150);
    expect(count(text)).toBeLessThanOrEqual(OUTLINE_MAX_TOKENS);
    expect(text.split("\n").pop()).toBe(`${omitted} more headings not shown`);
  });

  it("lists the top-level keys of pretty JSON", () => {
    const json = JSON.stringify(
      {
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        paths: { "/a": { get: {} }, "/b": { post: {} } },
        'with "quote"': 1,
      },
      null,
      2,
    );
    const page = outlineOf(json);
    expect(page.outline.kind).toBe("json");
    expect(page.outline.entries.map((e) => e.replace(/ \(.*$/, ""))).toEqual([
      '"openapi"',
      '"info"',
      '"paths"',
      '"with \\"quote\\""',
    ]);
    expect(page.outline.entries[1]).toMatch(/^"info" \(line 3, ~\d+\)$/);
  });

  it("JSON with more than 60 keys falls back to the page list", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 61; i++) big[`k${i}`] = "v".repeat(200);
    const page = outlineOf(JSON.stringify(big, null, 2));
    expect(page.outline.kind).toBe("pages");
    expect(page.outline.entries[0]).toMatch(
      /^page 1: lines 1-\d+ \(~[\d,]+ tokens\)$/,
    );
  });

  it("a JSON array or tab-indented object", () => {
    const lines = JSON.stringify([{ a: 1 }], null, 2).split("\n");
    expect(jsonTopLevelKeys(lines, lines.map(count))).toEqual([]);
    const tabbed = JSON.stringify({ a: { b: 1 }, c: 2 }, null, "\t").split(
      "\n",
    );
    expect(
      jsonTopLevelKeys(tabbed, tabbed.map(count)).map((k) => k.key),
    ).toEqual(["a", "c"]);
  });

  it("plain text gets the page list", () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `log line ${i} ${"x".repeat(60)}`,
    ).join("\n");
    const page = outlineOf(text);
    expect(page.outline.kind).toBe("pages");
    expect(page.outline.entries).toHaveLength(page.pages.length);
  });

  it("is the same for the same input", () => {
    const headings = headingsOf("# A\n## B\n### C");
    const pages = [{ page: 1, startLine: 1, endLine: 3, tokens: 3 }];
    expect(JSON.stringify(buildOutline({ headings, pages, count }))).toBe(
      JSON.stringify(buildOutline({ headings, pages, count })),
    );
  });
});
