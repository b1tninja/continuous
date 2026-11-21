import { createElement } from "react";

type CreateElement = (type: any, props?: any, ...children: any[]) => any;

/**
 * rehype-react 6 decides whether it is building React elements by calling
 * `createElement("div")` with no props and looking for `_owner` or `_store` on
 * the result. React 19 production elements have neither, so in a built page it
 * stopped treating them as React: `style` stayed a string, which React rejects
 * (error 62, hit by every KaTeX formula), and `className` arrived as `class`,
 * which our `pre` and `code` components do not read.
 *
 * Answer that one probe with an object it recognises. Every real element is
 * created with a props object, so the probe is the only call without one.
 */
export function rehypeCreateElement(
  create: CreateElement = createElement,
): CreateElement {
  return (type, props, ...children) => {
    if (props === undefined || props === null) {
      return { type, key: null, props: {}, _owner: null };
    }
    return create(type, props, ...children);
  };
}
