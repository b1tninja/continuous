import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseByView, diffBaseline } from "../src/axe.mjs";

const entry = (view, width, axe) => ({ view, width, axe });
const v = (id, count) => ({ id, count });

test("collapseByView keeps the worst count per rule across widths and themes", () => {
  const out = collapseByView([
    entry("chat", 300, [v("button-name", 2)]),
    entry("chat", 800, [v("button-name", 3), v("color-contrast", 1)]),
    entry("loop", 300, []),
  ]);
  assert.deepEqual(out, {
    chat: { "button-name": 3, "color-contrast": 1 },
    loop: {},
  });
});

test("diffBaseline fails on a new rule, a new view and a larger count", () => {
  const base = { chat: { "button-name": 2 } };
  const { added } = diffBaseline(
    { chat: { "button-name": 3, label: 1 }, loop: { "color-contrast": 1 } },
    base,
  );
  assert.deepEqual(
    added.map((a) => `${a.view}/${a.rule}`),
    ["chat/button-name", "chat/label", "loop/color-contrast"],
  );
});

test("diffBaseline passes on the same or fewer, and reports improvements", () => {
  const base = { chat: { "button-name": 2, label: 1 } };
  const r = diffBaseline({ chat: { "button-name": 2 } }, base);
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.improved, [
    { view: "chat", rule: "label", was: 1, count: 0 },
  ]);
});
