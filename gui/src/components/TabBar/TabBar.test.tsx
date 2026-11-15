import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setTabs } from "../../redux/slices/tabsSlice";
import { renderWithProviders } from "../../util/test/render";
import { TabBar } from "./TabBar";

async function renderTabs() {
  const rendered = await renderWithProviders(<TabBar />);
  const current = rendered.store.getState().session.id;
  act(() => {
    rendered.store.dispatch(
      setTabs([
        { id: "t1", title: "Now", isActive: true, sessionId: current },
        { id: "t2", title: "Earlier", isActive: false, sessionId: "s-old" },
      ]),
    );
  });
  return rendered;
}

describe("TabBar session actions", () => {
  it("archives a tab's session and closes the tab", async () => {
    const { store } = await renderTabs();
    const tab = screen.getByText("Earlier").parentElement!;
    fireEvent.click(
      within(tab).getByRole("button", { name: "Archive Earlier" }),
    );
    await act(async () => {});
    expect(store.getState().ui.archivedSessions).toEqual({
      "s-old": expect.any(Number),
    });
    expect(store.getState().tabs.tabs.map((t) => t.id)).toEqual(["t1"]);
  });

  it("does not archive an open session that has nothing in it", async () => {
    const { store } = await renderTabs();
    const tab = screen.getByText("Now").parentElement!;
    fireEvent.click(within(tab).getByRole("button", { name: "Archive Now" }));
    await act(async () => {});
    expect(store.getState().ui.archivedSessions).toEqual({});
  });

  it("opens a new session in a new tab", async () => {
    const { store } = await renderTabs();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    await act(async () => {});
    const tabs = store.getState().tabs.tabs;
    expect(tabs).toHaveLength(3);
    expect(tabs.at(-1)!.isActive).toBe(true);
  });
});
