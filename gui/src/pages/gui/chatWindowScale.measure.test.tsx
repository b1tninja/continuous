import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { ChatTranscript, useScrollBox } from "./ChatTranscript";

/**
 * The acceptance bar of plans/memory-and-history.md V3: the number of mounted
 * rows stays flat as the history grows, and a re-render (what each streamed
 * token causes) does not grow with it.
 */
afterEach(() => vi.restoreAllMocks());

function installGeometry(viewport: number, rowHeight: number) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.chatScroll !== undefined ? viewport : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.chatIndex !== undefined ? rowHeight : 0;
    },
  );
}

function List({ items, tick }: { items: string[]; tick: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollElement = useScrollBox(ref);
  return (
    <div ref={ref} data-chat-scroll="" data-tick={tick}>
      <ChatTranscript
        scrollElement={scrollElement}
        items={items}
        stickToEnd
        itemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    </div>
  );
}

const SIZES = [1_000, 5_000, 20_000];

describe("the mounted window stays flat as the history grows", () => {
  const table: string[] = [];

  for (const n of SIZES) {
    it(`at ${n} rows`, () => {
      installGeometry(800, 120);
      const items = Array.from({ length: n }, (_, i) => `row-${i}`);
      const t0 = performance.now();
      const view = render(<List items={items} tick={0} />);
      const mount = performance.now() - t0;
      const mounted = screen.getAllByTestId("chat-transcript-row").length;

      // a streamed token: the array identity changes and the last row changes
      const reps = 20;
      const t1 = performance.now();
      for (let i = 1; i <= reps; i++) {
        const next = items.slice();
        next[n - 1] = `row-${n - 1}-${i}`;
        act(() => {
          view.rerender(<List items={next} tick={i} />);
        });
      }
      const rerender = (performance.now() - t1) / reps;

      table.push(
        `${String(n).padStart(6)}  ${String(mounted).padStart(7)}  ${mount.toFixed(1).padStart(9)}  ${rerender.toFixed(2).padStart(11)}`,
      );
      // about a viewport of rows plus overscan, however long the history is
      expect(mounted).toBeLessThan(30);
    });
  }

  it("prints the table", () => {
    console.log(
      "\n  rows  mounted  mount(ms)  rerender(ms)\n" + table.join("\n"),
    );
    expect(table.length).toBe(SIZES.length);
  });
});
