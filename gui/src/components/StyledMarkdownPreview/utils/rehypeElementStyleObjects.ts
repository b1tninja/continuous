import styleToObject from "style-to-object";
import { visit } from "unist-util-visit";

/**
 * Parses string `style` properties on HAST elements into objects.
 *
 * `rehype-react` 6 / `hast-to-hyperscript` only turn a string `style` into an
 * object when they detect a React element prototype. React 19 production
 * builds no longer expose the fields that check looks for, so any element with
 * a string `style` crashes the chat UI (minified React error #62).
 *
 * KaTeX (`rehype-katex`) and some table paths still emit string styles.
 */
export function rehypeElementStyleObjects() {
  return (tree: any) => {
    visit(tree, "element", (node: any) => {
      const properties = node.properties;
      if (!properties) return;

      const { style } = properties;
      if (typeof style !== "string") return;

      const parsed = styleToObject(style);
      if (parsed && Object.keys(parsed).length > 0) {
        properties.style = parsed;
      } else {
        delete properties.style;
      }
    });
  };
}