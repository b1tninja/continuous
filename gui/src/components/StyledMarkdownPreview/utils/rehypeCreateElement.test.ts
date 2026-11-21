import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeReact from "rehype-react";
import { describe, expect, it } from "vitest";
import { rehypeCreateElement } from "./rehypeCreateElement";

/** The shape React 19 gives an element in a production build. */
function productionCreateElement(type: any, props?: any, ...children: any[]) {
  const element = createElement(type, props, ...children);
  return {
    $$typeof: (element as any).$$typeof,
    type: element.type,
    key: element.key,
    ref: null,
    props: element.props,
  };
}

const katexSpan = {
  type: "root",
  children: [
    {
      type: "element",
      tagName: "span",
      properties: {
        className: ["katex"],
        style: "height:1em;vertical-align:-0.25em",
      },
      children: [{ type: "text", value: "x" }],
    },
    {
      type: "element",
      tagName: "code",
      properties: { className: ["language-mermaid"] },
      children: [{ type: "text", value: "graph TD" }],
    },
  ],
};

function compile(create: any, components: Record<string, any> = {}) {
  const holder: any = {};
  (rehypeReact as any).call(holder, {
    createElement: create,
    Fragment,
    components,
  });
  return holder.Compiler(structuredClone(katexSpan));
}

function findAll(node: any, type: any, found: any[] = []): any[] {
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, type, found));
  } else if (node && typeof node === "object") {
    if (node.type === type) {
      found.push(node);
    }
    findAll(node.props?.children, type, found);
  }
  return found;
}

describe("rehypeCreateElement", () => {
  it("shows the fault: production-shaped elements keep style as a string", () => {
    const tree = compile(productionCreateElement);
    const [span] = findAll(tree, "span");
    expect(span.props.style).toBe("height:1em;vertical-align:-0.25em");
    expect(span.props.className).toBeUndefined();
  });

  it("gives production-shaped elements a style object and className", () => {
    const tree = compile(rehypeCreateElement(productionCreateElement));
    const [span] = findAll(tree, "span");
    expect(span.props.style).toEqual({
      height: "1em",
      verticalAlign: "-0.25em",
    });
    expect(span.props.className).toBe("katex");
  });

  it("passes className to a custom component", () => {
    const seen: any[] = [];
    const code = (props: any) => {
      seen.push(props.className);
      return null;
    };
    const tree = compile(rehypeCreateElement(productionCreateElement), {
      code,
    });
    const [element] = findAll(tree, code);
    expect(element.props.className).toBe("language-mermaid");
  });

  it("renders with the real createElement", () => {
    const html = renderToStaticMarkup(compile(rehypeCreateElement()));
    expect(html).toContain(
      '<span class="katex" style="height:1em;vertical-align:-0.25em">x</span>',
    );
  });
});
