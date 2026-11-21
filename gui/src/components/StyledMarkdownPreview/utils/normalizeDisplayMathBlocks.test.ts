import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { visit } from "unist-util-visit";
import remarkMath from "remark-math";
import { normalizeDisplayMathBlocks } from "./normalizeDisplayMathBlocks";
import { fixDoubleDollarNewLineLatex } from "./fixDoubleDollarLatex";

const require = createRequire(import.meta.url);
const unified = require("react-remark/node_modules/unified");
const remarkParse = require("react-remark/node_modules/remark-parse");

function parseWithChatParser(markdown: string) {
  return unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath: true })
    .parse(markdown);
}

function nodeTypes(markdown: string): string[] {
  const types: string[] = [];
  visit(parseWithChatParser(markdown), (node: { type: string; lang?: string }) => {
    if (node.type === "inlineMath") types.push("inlineMath");
    if (node.type === "code" && node.lang === "math") types.push("displayMath");
  });
  return types;
}

const sample =
  "The equation $x^2 + y^2 = 1$ defines $y$ implicitly as a function of $x$ near suitable points.\nAlso show a display equation:\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$";

describe("normalizeDisplayMathBlocks", () => {
  it("turns $$...$$ into a math fence the chat parser can read", () => {
    const source = normalizeDisplayMathBlocks(
      fixDoubleDollarNewLineLatex(sample),
    );
    expect(source).toContain("```math");
    expect(source).toContain("\\int_0^1");
    expect(nodeTypes(source)).toEqual([
      "inlineMath",
      "inlineMath",
      "inlineMath",
      "displayMath",
    ]);
  });

  it("does not throw on the react-remark parser", () => {
    const source = normalizeDisplayMathBlocks(
      fixDoubleDollarNewLineLatex(sample),
    );
    expect(() => parseWithChatParser(source)).not.toThrow();
  });
});
