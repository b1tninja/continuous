import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JumpToLatest } from "./JumpToLatest";

describe("JumpToLatest", () => {
  it("renders nothing while auto-scroll is following", () => {
    render(<JumpToLatest paused={false} scrollToLatest={() => {}} />);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("is a focusable button that scrolls when activated", () => {
    const scrollToLatest = vi.fn();
    render(<JumpToLatest paused scrollToLatest={scrollToLatest} />);
    const button = screen.getByRole("button", { name: "Jump to latest" });
    expect(button.tabIndex).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(scrollToLatest).toHaveBeenCalledOnce();
  });

  it("adds no live region of its own", () => {
    const { container } = render(
      <JumpToLatest paused scrollToLatest={() => {}} />,
    );
    expect(
      container.querySelector("[aria-live],[role=status],[role=alert]"),
    ).toBeNull();
  });
});
