import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ToggleSwitch from "./Switch";

describe("ToggleSwitch", () => {
  it("is a switch a keyboard can reach and work", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ToggleSwitch isToggled={false} onToggle={onToggle} text="Read files" />,
    );
    const control = screen.getByRole("switch", { name: "Read files" });
    expect(control.tagName).toBe("BUTTON");
    expect(control.getAttribute("aria-checked")).toBe("false");

    await user.tab();
    expect(document.activeElement).toBe(control);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("says when it is on", () => {
    render(<ToggleSwitch isToggled onToggle={() => {}} text="Read files" />);
    expect(
      screen
        .getByRole("switch", { name: "Read files" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("does nothing when disabled, by click or by key", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ToggleSwitch
        isToggled={false}
        onToggle={onToggle}
        text="Read files"
        disabled
      />,
    );
    const control = screen.getByRole("switch", { name: "Read files" });
    await user.click(control);
    await user.tab();
    expect(document.activeElement).not.toBe(control);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
