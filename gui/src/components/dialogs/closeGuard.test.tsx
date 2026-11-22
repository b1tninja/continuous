import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setDialogCloseGuard } from "./closeGuard";
import TextDialog from "./index";

const show = (onClose: () => void) =>
  render(
    <TextDialog
      showDialog
      onEnter={() => {}}
      onClose={onClose}
      message={<button>inside</button>}
    />,
  );

describe("the app dialog and a form with unsaved input", () => {
  it("closes on Escape and on its X when no dialog objects", () => {
    const onClose = vi.fn();
    show(onClose);
    fireEvent.keyDown(screen.getByText("inside"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("asks the open dialog first: Escape, the X and a click beside it all stay when it says no", () => {
    const onClose = vi.fn();
    const guard = vi.fn(() => false);
    const remove = setDialogCloseGuard(guard);
    const { container } = show(onClose);
    fireEvent.keyDown(screen.getByText("inside"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(container.firstElementChild!);
    expect(guard).toHaveBeenCalledTimes(3);
    expect(onClose).not.toHaveBeenCalled();

    // Once that dialog is gone, the container closes as before
    remove();
    fireEvent.keyDown(screen.getByText("inside"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer dialog's guard when an older one is removed late", () => {
    const removeOld = setDialogCloseGuard(() => false);
    const newer = vi.fn(() => false);
    const removeNew = setDialogCloseGuard(newer);
    removeOld();
    const onClose = vi.fn();
    show(onClose);
    fireEvent.keyDown(screen.getByText("inside"), { key: "Escape" });
    expect(newer).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    removeNew();
  });
});
