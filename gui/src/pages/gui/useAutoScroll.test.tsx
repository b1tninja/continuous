import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAnnouncement,
  resetAnnouncer,
} from "../../components/a11y/announcer";
import { NEW_CONTENT_ANNOUNCEMENT, useAutoScroll } from "./useAutoScroll";

let resizeCallbacks: Array<() => void> = [];

beforeEach(() => {
  resetAnnouncer();
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      disconnect() {
        resizeCallbacks = resizeCallbacks.filter((c) => c !== this.cb);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const history = [
  { message: { role: "user", id: "1", content: "hi" } },
  { message: { role: "assistant", id: "2", content: "yo" } },
] as any;

/** A box whose geometry the test sets directly. */
function Harness({ box }: { box: { current: HTMLDivElement | null } }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { paused, scrollToLatest } = useAutoScroll(ref, history);
  return (
    <>
      <div
        ref={(el) => {
          ref.current = el;
          box.current = el;
        }}
      />
      <span data-testid="paused">{String(paused)}</span>
      <button onClick={scrollToLatest}>latest</button>
    </>
  );
}

function geometry(el: HTMLDivElement, g: { height: number; client: number }) {
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => g.height,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => g.client,
  });
}

async function setup() {
  const box = { current: null as HTMLDivElement | null };
  render(<Harness box={box} />);
  const el = box.current!;
  const g = { height: 1000, client: 400 };
  geometry(el, g);
  el.scrollTop = 600;
  const scrollTo = async (top: number) => {
    await act(async () => {
      el.scrollTop = top;
      el.dispatchEvent(new Event("scroll"));
    });
  };
  const resize = async () => {
    await act(async () => {
      resizeCallbacks.forEach((cb) => cb());
    });
  };
  // The view starts at the bottom, as a chat does
  await scrollTo(600);
  return { el, g, scrollTo, resize };
}

describe("useAutoScroll", () => {
  it("follows new content while the view is at the bottom", async () => {
    const { el, g, resize } = await setup();
    g.height = 1400;
    await resize();
    expect(el.scrollTop).toBe(1400);
  });

  it("stops following when the user scrolls up, and resumes at the bottom", async () => {
    const { el, g, scrollTo, resize } = await setup();
    await scrollTo(200);
    g.height = 1400;
    await resize();
    expect(el.scrollTop).toBe(200);

    // Back to the bottom, within a few pixels
    await scrollTo(g.height - g.client - 3);
    g.height = 1800;
    await resize();
    expect(el.scrollTop).toBe(1800);
  });

  it("a panel below growing is not the user leaving the bottom", async () => {
    const { el, g, scrollTo, resize } = await setup();
    // The box shrinks under a growing plan panel; a late scroll event from
    // our own scroll arrives while the view is no longer exactly at the bottom
    g.client = 300;
    await scrollTo(600);
    g.height = 1200;
    await resize();
    expect(el.scrollTop).toBe(1200);
  });

  describe("Jump to latest", () => {
    it("reports paused only while the user is scrolled up", async () => {
      const { g, scrollTo } = await setup();
      expect(screen.getByTestId("paused").textContent).toBe("false");
      await scrollTo(200);
      expect(screen.getByTestId("paused").textContent).toBe("true");
      await scrollTo(g.height - g.client);
      expect(screen.getByTestId("paused").textContent).toBe("false");
    });

    it("announces new content once per pause, not per update", async () => {
      const { g, scrollTo, resize } = await setup();
      await scrollTo(200);
      expect(getAnnouncement("polite").seq).toBe(0);
      g.height = 1100;
      await resize();
      g.height = 1200;
      await resize();
      g.height = 1300;
      await resize();
      expect(getAnnouncement("polite")).toEqual({
        text: NEW_CONTENT_ANNOUNCEMENT,
        seq: 1,
      });
    });

    it("says nothing when auto-scroll is following", async () => {
      const { g, resize } = await setup();
      g.height = 1400;
      await resize();
      expect(getAnnouncement("polite").seq).toBe(0);
    });

    it("scrolls to the end and resumes following when asked", async () => {
      const { el, g, scrollTo, resize } = await setup();
      await scrollTo(200);
      g.height = 1400;
      await resize();
      await act(async () => {
        fireEvent.click(screen.getByText("latest"));
      });
      expect(screen.getByTestId("paused").textContent).toBe("false");
      expect(el.scrollTop).toBe(1400);
    });
  });
});
