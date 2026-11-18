import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoopStateIcon } from "./LoopStateIcon";
import { LOOP_VISUAL, type LoopVisualState } from "./loopVisualState";

describe("LoopStateIcon", () => {
  it("draws a decorative glyph in the state's colour for every state", () => {
    for (const state of Object.keys(LOOP_VISUAL) as LoopVisualState[]) {
      const { unmount } = render(<LoopStateIcon state={state} />);
      const icon = screen.getByTestId("loop-state-icon");
      expect(icon.getAttribute("data-state")).toBe(state);
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });

  it("pulses the running dot only when motion is allowed", () => {
    render(<LoopStateIcon state="running" />);
    const dot = screen.getByTestId("loop-state-icon").firstElementChild!;
    expect(dot.className).toContain("animate-pulse");
    expect(dot.className).toContain("motion-reduce:animate-none");
    expect(dot.className).toContain("motion-reduce:ring-2");
  });
});
