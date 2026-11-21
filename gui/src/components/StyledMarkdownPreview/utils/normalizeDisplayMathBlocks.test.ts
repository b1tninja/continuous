import { describe, expect, it } from "vitest";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { normalizeDisplayMathBlocks } from "./normalizeDisplayMathBlocks";

function mathNodeTypes(markdown: string): string[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath: true })
    .parse(markdown);
  const types: string[] = [];
  visit(tree, (node) => {
    if (node.type === "math" || node.type === "inlineMath") {
      types.push(node.type);
    }
  });
  return types;
}

describe("normalizeDisplayMathBlocks", () => {
  it("turns a one-line $$ block into flow math", () => {
    const source = "Also show a display equation:\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$";
    const normalized = normalizeDisplayMathBlocks(source);
    expect(mathNodeTypes(normalized)).toEqual(["math"]);
  });

  it("leaves multiline display math as flow math", () => {
    const source = "$$\n\\int_0^1\n$$";
    expect(mathNodeTypes(normalizeDisplayMathBlocks(source))).toEqual(["math"]);
  });

  it("parses the standard inline + display sample", () => {
    const source = normalizeDisplayMathBlocks(
      "The equation $x^2 + y^2 = 1$ defines $y$ implicitly as a function of $x$ near suitable points.\n\nAlso show a display equation:\n\n$$\\int_0^1 x\\,dx = \\frac{1}{2}$$",
    );
    expect(mathNodeTypes(source)).toEqual([
      "inlineMath",
      "inlineMath",
      "inlineMath",
      "math",
    ]);
  });
});