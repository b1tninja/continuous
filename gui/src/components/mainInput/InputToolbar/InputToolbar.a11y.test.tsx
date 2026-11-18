import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import InputToolbar from "../InputToolbar";
import { AttachMenu } from "./AttachMenu";
import { HoverButton } from "./HoverItem";

async function renderToolbar() {
  // A wide row, so the active-file hint is in the Tab order
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 24,
  } as DOMRect);
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(
    <div>
      <AttachMenu onAddContextItem={vi.fn()} onImageFilesSelected={vi.fn()} />
      <InputToolbar activeKey={null} onEnter={vi.fn()} isMainInput />
    </div>,
    { store, mockIdeMessenger: ideMessenger },
  );
}

describe("input toolbar accessibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("HoverButton is a named button of at least 24 px", async () => {
    await renderWithProviders(<HoverButton aria-label="Thing">x</HoverButton>);
    const b = await screen.findByRole("button", { name: "Thing" });
    expect(b.getAttribute("type")).toBe("button");
    expect(b.className).toContain("min-h-6");
    expect(b.className).toContain("min-w-6");
    expect(b.className).toContain("inline-flex");
  });

  it("has one + button, named and 24 px, and no unnamed overflow menu", async () => {
    await renderToolbar();
    const plus = screen.getByRole("button", { name: "Add image or context" });
    expect(plus.className).toContain("min-h-6");
    expect(plus.className).toContain("min-w-6");
    expect(plus.getAttribute("data-testid")).toBe("attach-menu-button");
    // The "..." menu is gone: its controls are in the row
    expect(screen.queryByTestId("input-overflow-button")).toBeNull();
    // the old 12 px span icons are gone
    expect(screen.queryByLabelText("Attach Image")).toBeNull();
  });

  it("Tab order: +, model, active file (wide), send", async () => {
    await renderToolbar();
    const user = userEvent.setup();
    const seen: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      await user.tab();
      seen.push(document.activeElement?.getAttribute("data-testid") ?? null);
    }
    expect(seen).toEqual([
      "attach-menu-button",
      "model-select-button",
      "active-file-button",
      "submit-input-button",
    ]);
  });

  it("the + menu opens from the keyboard and offers add context", async () => {
    await renderToolbar();
    const user = userEvent.setup();
    screen.getByTestId("attach-menu-button").focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByTestId("attach-context-item")).toBeTruthy();
  });
});
