import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopFrame, type LoopFrameState } from "./LoopFrame";
import {
  LOOP_FRAME_SURFACES,
  LOOP_FRAME_TOKENS,
  contrastRatio,
} from "./loopFrameTokens";

const STATES: LoopFrameState[] = [
  "running",
  "waiting",
  "failed",
  "finished",
  "stopped",
];

function mockMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  window.matchMedia = globalThis.matchMedia;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("LoopFrame", () => {
  beforeEach(() => {
    mockMedia(false);
    setVisibility("visible");
  });
  afterEach(() => {
    cleanup();
    document.body.removeAttribute("class");
    vi.unstubAllGlobals();
  });

  it.each(STATES)("puts state %s in data-state", (state) => {
    render(<LoopFrame state={state}>body</LoopFrame>);
    const frame = screen.getByTestId("loop-frame");
    expect(frame.getAttribute("data-state")).toBe(state);
    expect(frame.className).toContain("loop-frame");
    expect(frame.textContent).toBe("body");
  });

  it("is static by default, even while running", () => {
    render(<LoopFrame state="running" />);
    expect(screen.getByTestId("loop-frame").getAttribute("data-motion")).toBe(
      "off",
    );
  });

  it("sweeps only for a running loop that is told to animate", () => {
    for (const state of STATES) {
      const { unmount } = render(<LoopFrame state={state} animate />);
      expect(screen.getByTestId("loop-frame").getAttribute("data-motion")).toBe(
        state === "running" ? "sweep" : "off",
      );
      unmount();
    }
  });

  it("does not sweep under prefers-reduced-motion", () => {
    mockMedia(true);
    render(<LoopFrame state="running" animate />);
    expect(screen.getByTestId("loop-frame").getAttribute("data-motion")).toBe(
      "off",
    );
  });

  it("does not sweep when VS Code's Reduce Motion class is set", () => {
    document.body.classList.add("vscode-reduce-motion");
    render(<LoopFrame state="running" animate />);
    expect(screen.getByTestId("loop-frame").getAttribute("data-motion")).toBe(
      "off",
    );
  });

  it("stops sweeping while the page is hidden and resumes when shown", () => {
    render(<LoopFrame state="running" animate />);
    const motion = () =>
      screen.getByTestId("loop-frame").getAttribute("data-motion");
    expect(motion()).toBe("sweep");
    act(() => {
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(motion()).toBe("off");
    act(() => {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(motion()).toBe("sweep");
  });

  it("is decoration: no role and no live region", () => {
    render(<LoopFrame state="waiting" />);
    const frame = screen.getByTestId("loop-frame");
    expect(frame.getAttribute("role")).toBeNull();
    expect(frame.getAttribute("aria-live")).toBeNull();
  });
});

describe("loopFrame.css", () => {
  const css = readFileSync(join(__dirname, "loopFrame.css"), "utf8");

  it("keeps a transparent 2 px border in every state (no layout shift)", () => {
    expect(css).toMatch(/border:\s*2px solid transparent/);
    expect(css).not.toMatch(/data-state[^{]*\{[^}]*border-width/);
  });

  it("holds the same hexes as the token module", () => {
    for (const theme of ["dark", "light"] as const) {
      for (const [name, hex] of Object.entries(LOOP_FRAME_TOKENS[theme])) {
        const prop = `--lf-${name}`;
        expect(css).toContain(`${prop}: ${hex};`);
      }
    }
  });

  it("registers the angle, with fallbacks and a forced-colours rule", () => {
    expect(css).toContain("@property --lf-angle");
    expect(css).toMatch(/box-shadow: 0 0 6px rgba\(/);
    expect(css).toContain("color-mix(in srgb");
    expect(css).toMatch(/forced-colors: active[\s\S]*CanvasText/);
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(css).toContain("body:not(.vscode-reduce-motion)");
    // the conic gradient sits in the rule that animates, not in a shared variable
    expect(css).not.toMatch(/--lf-[a-z]+:\s*conic-gradient/);
  });

  it("only the glow is a shadow: it is outer, never inset", () => {
    expect(css).not.toContain("inset");
  });
});

describe("loop frame contrast (WCAG 1.4.11, at least 3:1)", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const [surface, bg] of Object.entries(LOOP_FRAME_SURFACES[theme])) {
      for (const [name, hex] of Object.entries(LOOP_FRAME_TOKENS[theme])) {
        it(`${theme} ${name} ${hex} on ${surface} ${bg}`, () => {
          expect(contrastRatio(hex, bg)).toBeGreaterThanOrEqual(3);
        });
      }
    }
  }
});
