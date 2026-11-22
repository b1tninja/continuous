import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/args.mjs";
import {
  classify,
  classifyElement,
  collapse,
  diffBaseline,
  findingKey,
  mergeBaseline,
} from "../src/overflow.mjs";
import { launchOptions } from "../src/shoot.mjs";
import { planJobs, VIEWS } from "../src/views.mjs";

const VIEWPORT = 300;

/** A measured element that fits; each test changes what it is about. */
const fact = (over = {}) => ({
  selector: "div.flex",
  tag: "div",
  text: "Some text",
  left: 10,
  right: 290,
  width: 280,
  height: 20,
  scrollWidth: 280,
  clientWidth: 280,
  overflowX: "visible",
  truncates: false,
  formControl: false,
  rendered: true,
  srOnly: false,
  inTruncated: false,
  reachable: false,
  parent: -1,
  ...over,
});
const kinds = (f) => classifyElement(f, VIEWPORT).map((x) => x.kind);

describe("classifyElement", () => {
  it("passes an element that fits", () => {
    assert.deepEqual(classifyElement(fact(), VIEWPORT), []);
  });

  it("reports a box past an edge, with the side and the amount", () => {
    assert.deepEqual(classifyElement(fact({ right: 324.4 }), VIEWPORT), [
      { kind: "outside", side: "right", px: 24 },
    ]);
    assert.deepEqual(classifyElement(fact({ left: -28 }), VIEWPORT), [
      { kind: "outside", side: "left", px: 28 },
    ]);
    // a centred form that is too wide is cut on both sides
    assert.deepEqual(
      classifyElement(fact({ left: -43.5, right: 343.5 }), VIEWPORT),
      [{ kind: "outside", side: "both", px: 44 }],
    );
  });

  it("ignores a pixel of rounding", () => {
    assert.deepEqual(kinds(fact({ right: 300.9 })), []);
    assert.deepEqual(kinds(fact({ right: 301.4 })), []);
    assert.deepEqual(
      kinds(fact({ overflowX: "hidden", scrollWidth: 281 })),
      [],
    );
  });

  it("reports content cut by overflow hidden or clip", () => {
    for (const overflowX of ["hidden", "clip"]) {
      assert.deepEqual(
        classifyElement(fact({ overflowX, scrollWidth: 344 }), VIEWPORT),
        [{ kind: "clipped", px: 64 }],
      );
    }
    // visible overflow is not cut here; what sticks out is reported as outside
    assert.deepEqual(kinds(fact({ scrollWidth: 344 })), []);
  });

  it("does not report text cut on purpose, or what is inside it", () => {
    assert.deepEqual(
      kinds(fact({ overflowX: "hidden", truncates: true, scrollWidth: 500 })),
      [],
    );
    assert.deepEqual(kinds(fact({ right: 500, inTruncated: true })), []);
  });

  it("reports truncated text that has no room left to show", () => {
    assert.deepEqual(
      classifyElement(
        fact({
          overflowX: "hidden",
          truncates: true,
          width: 0,
          clientWidth: 0,
          scrollWidth: 196,
        }),
        VIEWPORT,
      ),
      [{ kind: "squeezed", px: 196 }],
    );
    // empty, so nothing is lost
    assert.deepEqual(
      kinds(
        fact({
          truncates: true,
          text: "",
          width: 0,
          clientWidth: 0,
          scrollWidth: 9,
        }),
      ),
      [],
    );
  });

  it("does not report visually hidden or unrendered elements", () => {
    const wide = { right: 900, overflowX: "hidden", scrollWidth: 900 };
    assert.deepEqual(kinds(fact({ ...wide, srOnly: true })), []);
    assert.deepEqual(kinds(fact({ ...wide, rendered: false })), []);
    assert.deepEqual(kinds(fact({ ...wide, width: 0 })), []);
    // sr-only itself: a 1 px box whose text is wider than it
    assert.deepEqual(
      kinds(
        fact({
          srOnly: true,
          width: 1,
          height: 1,
          clientWidth: 1,
          scrollWidth: 52,
          overflowX: "hidden",
        }),
      ),
      [],
    );
  });

  it("does not report what a sideways scroller reaches, or a form control's own text", () => {
    assert.deepEqual(kinds(fact({ right: 700, reachable: true })), []);
    assert.deepEqual(
      kinds(
        fact({
          tag: "input",
          formControl: true,
          overflowX: "clip",
          scrollWidth: 600,
        }),
      ),
      [],
    );
  });

  it("reports a container that scrolls sideways, but not a code block or a table", () => {
    const scroller = { overflowX: "auto", scrollWidth: 312 };
    assert.deepEqual(classifyElement(fact(scroller), VIEWPORT), [
      { kind: "scroll-x", px: 32 },
    ]);
    assert.deepEqual(kinds(fact({ ...scroller, tag: "pre" })), []);
    assert.deepEqual(kinds(fact({ ...scroller, tag: "table" })), []);
  });
});

describe("classify", () => {
  it("names the outermost element outside an edge, not its children", () => {
    const found = classify({
      viewport: VIEWPORT,
      elements: [
        fact({ selector: "div.form", right: 324 }),
        fact({ selector: "div.form > div.row", right: 308, parent: 0 }),
        // through a parent that is itself inside
        fact({
          selector: "div.form > div.row > button",
          right: 308,
          parent: 1,
        }),
        // out on the other side: a problem of its own
        fact({ selector: "div.form > button.back", left: -12, parent: 0 }),
      ],
    });
    assert.deepEqual(
      found.map((f) => `${findingKey(f)} ${f.side} ${f.px}`),
      ["outside div.form right 24", "outside div.form > button.back left 12"],
    );
  });

  it("keeps a clipped container beside the element that sticks out of it", () => {
    const found = classify({
      viewport: VIEWPORT,
      elements: [
        fact({ selector: "div.row", overflowX: "hidden", scrollWidth: 344 }),
        fact({ selector: "div.row > div.controls", right: 344, parent: 0 }),
      ],
    });
    assert.deepEqual(found.map(findingKey), [
      "clipped div.row",
      "outside div.row > div.controls",
    ]);
  });
});

describe("overflow baseline", () => {
  const entry = (view, width, overflow) => ({ view, width, overflow });
  const f = (kind, selector, px) => ({ kind, selector, px });

  it("collapse keys by view and width and keeps the largest amount per element", () => {
    assert.deepEqual(
      collapse([
        entry("history", 200, [f("outside", "li", 5), f("outside", "li", 9)]),
        entry("history", 250, []),
        entry("chat", 200, [f("clipped", "div", 64)]),
      ]),
      {
        chat: { 200: { "clipped div": 64 } },
        history: { 200: { "outside li": 9 }, 250: {} },
      },
    );
  });

  it("a finding that is not listed, or has grown, is new", () => {
    const base = { chat: { 200: { "clipped div": 64 } } };
    const { added } = diffBaseline(
      {
        chat: {
          200: { "clipped div": 70, "outside a": 3 },
          250: { "clipped div": 14 },
        },
        history: { 200: { "outside li": 5 } },
      },
      base,
    );
    assert.deepEqual(
      added.map((a) => `${a.view}/${a.width}/${a.key}`),
      [
        "chat/200/clipped div",
        "chat/200/outside a",
        "chat/250/clipped div",
        "history/200/outside li",
      ],
    );
  });

  it("the same finding, a little larger or smaller, passes", () => {
    const base = { chat: { 200: { "clipped div": 64 } } };
    for (const px of [62, 64, 66]) {
      const r = diffBaseline({ chat: { 200: { "clipped div": px } } }, base);
      assert.deepEqual(r, { added: [], improved: [] });
    }
  });

  it("reports what went away or shrank, for the views and widths that ran", () => {
    const base = {
      chat: { 200: { "clipped div": 64, "outside a": 9 }, 300: { x: 5 } },
      loop: { 200: { "outside b": 4 } },
    };
    const r = diffBaseline({ chat: { 200: { "clipped div": 20 } } }, base);
    assert.equal(r.added.length, 0);
    assert.deepEqual(
      r.improved.map((i) => `${i.key} ${i.was}->${i.px}`),
      ["clipped div 64->20", "outside a 9->0"],
    );
  });

  it("mergeBaseline replaces the widths that ran and keeps the rest", () => {
    assert.deepEqual(
      mergeBaseline(
        { chat: { 200: { a: 1 }, 300: { b: 2 } }, loop: { 200: { c: 3 } } },
        { chat: { 200: {} } },
      ),
      { chat: { 200: {}, 300: { b: 2 } }, loop: { 200: { c: 3 } } },
    );
  });
});

describe("zoom, scrollbars and --serve", () => {
  it("a zoomed view carries its factor into every job", () => {
    const zoomed = Object.keys(VIEWS).filter((v) => VIEWS[v].zoom);
    assert.ok(zoomed.length > 0);
    const [job] = planJobs({
      views: [zoomed[0]],
      widths: [300],
      themes: ["dark"],
      height: 700,
    });
    assert.equal(job.zoom, VIEWS[zoomed[0]].zoom);
    const [plain] = planJobs({
      views: ["chat"],
      widths: [300],
      themes: ["dark"],
      height: 700,
    });
    assert.equal("zoom" in plain, false);
  });

  it("scrollbars are hidden unless a view asks for them", () => {
    assert.ok(launchOptions({}).args.includes("--hide-scrollbars"));
    const shown = launchOptions({}, { scrollbars: true });
    assert.equal(shown.args.includes("--hide-scrollbars"), false);
    assert.deepEqual(shown.ignoreDefaultArgs, ["--hide-scrollbars"]);
  });

  it("--serve needs no --out and takes a port and views", () => {
    const o = parseArgs(["--serve"]);
    assert.equal(o.serve, true);
    assert.equal(o.port, 0);
    assert.equal(o.views.length, Object.keys(VIEWS).length);
    const one = parseArgs(["--serve", "--port", "5199", "--view", "history"]);
    assert.equal(one.port, 5199);
    assert.deepEqual(one.views, ["history"]);
    assert.throws(() => parseArgs(["--serve", "--port", "x"]), /--port/);
  });
});
