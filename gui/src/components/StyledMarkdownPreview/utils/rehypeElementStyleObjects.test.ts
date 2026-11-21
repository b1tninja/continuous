import { describe, expect, it } from "vitest";
import { rehypeElementStyleObjects } from "./rehypeElementStyleObjects";

const el = (properties: Record<string, unknown>) => ({
  type: "element",
  tagName: "span",
  properties,
  children: [],
});

const run = (...elements: any[]) => {
  const tree = { type: "root", children: elements };
  rehypeElementStyleObjects()(tree);
  return tree.children.map((c: any) => c.properties);
};

describe("rehypeElementStyleObjects", () => {
  it("parses a katex-style color string", () => {
    expect(run(el({ style: "color:#cc0000" }))).toEqual([
      { style: { color: "#cc0000" } },
    ]);
  });

  it("parses multiple declarations like katex html output", () => {
    expect(run(el({ style: "position:absolute; width:0; height:0" }))).toEqual([
      { style: { position: "absolute", width: "0", height: "0" } },
    ]);
  });

  it("leaves object styles untouched", () => {
    expect(run(el({ style: { textAlign: "left" } }))).toEqual([
      { style: { textAlign: "left" } },
    ]);
  });

  it("drops an unparseable style string", () => {
    expect(run(el({ style: "" }))).toEqual([{}]);
  });
});
