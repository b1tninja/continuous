import type { Element, Root } from "hast";
import { describe, expect, it } from "vitest";
import { rehypeHighlightPlugin } from "./rehypeHighlightPlugin";

function codeBlock(lang: string, text: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: [`language-${lang}`] },
            children: [{ type: "text", value: text }],
          },
        ],
      },
    ],
  };
}

function highlighted(tree: Root): Element {
  const transform = rehypeHighlightPlugin()();
  void transform(tree, { message: () => {} } as never);
  return (tree.children[0] as Element).children[0] as Element;
}

describe("rehypeHighlightPlugin", () => {
  it("gives every parse the same highlighter", () => {
    expect(rehypeHighlightPlugin()()).toBe(rehypeHighlightPlugin()());
  });

  it("highlights one tree after another, each on its own", () => {
    const ts = highlighted(codeBlock("ts", "const a = 1;"));
    expect(ts.properties.className).toContain("hljs");
    expect(JSON.stringify(ts.children)).toContain("hljs-keyword");

    const plain = highlighted(codeBlock("ts", "a"));
    expect(JSON.stringify(plain.children)).not.toContain("hljs-keyword");
  });

  it("knows a language added to the common set", () => {
    const code = highlighted(codeBlock("powershell", "Write-Host $name"));
    expect(JSON.stringify(code.children)).toContain("hljs-");
  });
});
