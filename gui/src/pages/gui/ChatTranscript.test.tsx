import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript, useScrollBox } from "./ChatTranscript";

afterEach(() => {
  vi.restoreAllMocks();
});

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

function List({
  count,
  stickToEnd,
  scrollTop,
}: {
  count: number;
  stickToEnd: boolean;
  scrollTop?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollElement = useScrollBox(ref);
  const items = Array.from({ length: count }, (_, i) => `row-${i}`);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el && scrollTop !== undefined) el.scrollTop = scrollTop;
      }}
      data-chat-scroll=""
    >
      <ChatTranscript
        scrollElement={scrollElement}
        items={items}
        stickToEnd={stickToEnd}
        itemKey={(item) => item}
        renderItem={(item) => <span>{item}</span>}
      />
    </div>
  );
}

describe("ChatTranscript", () => {
  it("mounts only the rows near the end of a long list", () => {
    installGeometry(250, 100);
    render(<List count={40} stickToEnd />);
    const rows = screen.getAllByTestId("chat-transcript-row");
    expect(rows.length).toBeLessThan(40);
    expect(screen.getByText("row-39")).toBeTruthy();
    expect(screen.queryByText("row-0")).toBeNull();
    expect(screen.getByTestId("chat-window-spacer")).toBeTruthy();
  });

  it("mounts earlier rows when the person scrolls back, and unmounts the tail", () => {
    installGeometry(250, 100);
    render(<List count={40} stickToEnd={false} scrollTop={0} />);
    expect(screen.getByText("row-0")).toBeTruthy();
    expect(screen.queryByText("row-39")).toBeNull();

    const scroller = document.querySelector(
      "[data-chat-scroll]",
    ) as HTMLDivElement;
    act(() => {
      scroller.scrollTop = 3000;
      scroller.dispatchEvent(new Event("scroll"));
    });

    expect(screen.queryByText("row-0")).toBeNull();
    expect(screen.getByText("row-30")).toBeTruthy();
    expect(screen.getAllByTestId("chat-transcript-row").length).toBeLessThan(
      40,
    );
  });
});
