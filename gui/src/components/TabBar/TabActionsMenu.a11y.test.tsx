import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setTabs } from "../../redux/slices/tabsSlice";
import {
  applyForkState,
  setupForkStore,
} from "../../redux/thunks/forkSession.fixture";
import { renderWithProviders } from "../../util/test/render";
import { TabBar } from "./TabBar";

async function setup() {
  const { store, ideMessenger } = setupForkStore();
  store.dispatch(
    setTabs([
      {
        id: "t1",
        title: "Fix the parser",
        isActive: true,
        sessionId: "parent",
      },
      { id: "t2", title: "Other work", isActive: false, sessionId: "other" },
    ]),
  );
  const view = await renderWithProviders(<TabBar />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  // The render loads its own config; put the fixture's back
  await act(async () => applyForkState(store));
  return { store, view, ideMessenger };
}

describe("Session tab menu: assistive technology", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("each tab has a menu button named for its session", async () => {
    await setup();
    const button = screen.getByRole("button", {
      name: "Actions for Fix the parser",
    });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("button", { name: "Actions for Other work" }),
    ).toBeTruthy();
  });

  it("opens from the keyboard and moves focus into a menu with Fork session", async () => {
    const { view } = await setup();
    const button = screen.getByRole("button", {
      name: "Actions for Fix the parser",
    });
    act(() => button.focus());
    await view.user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(menu).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const item = screen.getByRole("menuitem", { name: "Fork session" });
    // Focus is on the menu, which points at its first item
    await waitFor(() => expect(document.activeElement).toBe(menu));
    expect(menu.getAttribute("aria-activedescendant")).toBe(item.id);
  });

  it("says what the fork costs as the item's description", async () => {
    const { view } = await setup();
    await view.user.click(
      screen.getByRole("button", { name: "Actions for Fix the parser" }),
    );
    const item = await screen.findByRole("menuitem", { name: "Fork session" });
    const description = document.getElementById(
      item.getAttribute("aria-describedby")!,
    );
    // Auto is on the 1-hour lifetime here (escalated), so writes are $8/M
    expect(description?.textContent).toMatch(
      /^Fork re-reads 62k tokens ≈ \$0\.50; within the cache window \(\d+ min left\) ≈ \$0\.01$/,
    );
  });

  it("closes with Escape and gives focus back to its button", async () => {
    const { view } = await setup();
    const button = screen.getByRole("button", {
      name: "Actions for Fix the parser",
    });
    await view.user.click(button);
    await screen.findByRole("menu");
    await view.user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it("forks the open session when chosen with the keyboard, without switching tabs first", async () => {
    const { store, view } = await setup();
    act(() =>
      screen
        .getByRole("button", { name: "Actions for Fix the parser" })
        .focus(),
    );
    await view.user.keyboard("{Enter}");
    await screen.findByRole("menuitem", { name: "Fork session" });
    await view.user.keyboard("{Enter}");
    await waitFor(() =>
      expect(store.getState().session.forkedFrom).toEqual({
        sessionId: "parent",
      }),
    );
  });
});
