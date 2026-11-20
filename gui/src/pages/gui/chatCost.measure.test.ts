import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";

import { chatWindowRange } from "./chatWindow";

/**
 * V0 of plans/memory-and-history.md, for the part of the cost that is plain
 * JavaScript and does not need a browser: what a streamed token costs once a
 * conversation is long. It prints a table; the assertions are loose so the
 * test does not become a flaky benchmark.
 */
type Item = {
  message: { role: string; content: string; id: string };
  contextItems: unknown[];
  toolCallStates?: unknown[];
};

function build(n: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    const role = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool";
    items.push({
      message: { role, content: "x".repeat(400), id: `m${i}` },
      contextItems: [],
      ...(role === "assistant" ? { toolCallStates: [] } : {}),
    });
  }
  return items;
}

function time(fn: () => void, reps: number): number {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

const SIZES = [1_000, 5_000, 20_000];

describe("per-token cost at length (V0)", () => {
  const rows: string[] = [];

  for (const n of SIZES) {
    it(`measures at ${n} items`, () => {
      const history = build(n);
      const heights = history.map(() => (120 + Math.random() * 200) | 0);

      // what Chat does on every render when history is a new array
      const filter = time(
        () => history.filter((i) => i.message.role !== "system"),
        50,
      );
      // what chatWindowRange does on every scroll and every token
      const range = time(
        () =>
          chatWindowRange({
            count: n,
            scrollTop: 400,
            viewport: 900,
            heights,
            stickToEnd: true,
          }),
        50,
      );
      const rangeScroll = time(
        () =>
          chatWindowRange({
            count: n,
            scrollTop: (n * 120) / 2,
            viewport: 900,
            heights,
            stickToEnd: false,
          }),
        50,
      );
      // a shallow copy of the array, which Immer does per streamed token
      const copy = time(() => history.slice(), 50);
      // JSON size of the whole session, which a save writes
      const t0 = performance.now();
      const json = JSON.stringify(history, undefined, 2);
      const stringify = performance.now() - t0;

      rows.push(
        [
          String(n).padStart(6),
          filter.toFixed(3).padStart(10),
          range.toFixed(3).padStart(10),
          rangeScroll.toFixed(3).padStart(12),
          copy.toFixed(3).padStart(9),
          stringify.toFixed(1).padStart(10),
          (json.length / 1024 / 1024).toFixed(1).padStart(8),
        ].join(" "),
      );
      expect(range).toBeLessThan(50);
    });
  }

  it("prints the table", () => {
    console.log(
      "\n items  filter(ms)  window(ms)  windowScroll   copy(ms) stringify(ms)  json(MB)\n" +
        rows.join("\n"),
    );
    expect(rows.length).toBe(SIZES.length);
  });
});
