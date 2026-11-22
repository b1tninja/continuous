import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import ConfigPage from "./index";

vi.mock("./configTabs", () => {
  const tab = (id: string, label: string, extra = {}) => ({
    id,
    label,
    icon: <svg />,
    component: <div data-testid={`content-${id}`}>{label} content</div>,
    ...extra,
  });
  const top = [
    { id: "top", tabs: [tab("back", "Back", { action: true })] },
    {
      id: "blocks",
      showTopDivider: true,
      tabs: [tab("models", "Models"), tab("tools", "Tools")],
    },
  ];
  const bottom = [{ id: "bottom", tabs: [tab("settings", "Settings")] }];
  return {
    topTabSections: top,
    bottomTabSections: bottom,
    getAllTabs: () => [...top, ...bottom].flatMap((s) => s.tabs),
  };
});

const open = (tab: string) =>
  renderWithProviders(<ConfigPage />, {
    routerProps: { initialEntries: [`/config?tab=${tab}`] } as never,
  });

describe("Settings page at a narrow width", () => {
  it("shows the content, not a 'screen too small' notice, at every width", async () => {
    await open("tools");
    expect(screen.getByTestId("content-tools")).toBeDefined();
    expect(document.body.textContent).not.toContain("Screen width too small");
    // Nothing hides the content below `sm`
    const panel = screen.getByRole("tabpanel");
    expect(panel.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(panel.className).not.toContain("sm:block");
  });

  it("makes the navigation one row of icon tabs below sm and a column from sm", async () => {
    await open("tools");
    const nav = screen.getByRole("navigation", { name: "Settings" });
    const strip = nav.firstElementChild as HTMLElement;
    expect(strip.className).toContain("flex-row");
    // Nothing scrolls sideways out of view: the tabs share the row, and wrap if they must
    expect(strip.className).not.toContain("overflow-x-auto");
    expect(strip.className).toContain("flex-wrap");
    expect(strip.className).toContain("sm:flex-nowrap");
    expect(strip.className).toContain("sm:flex-col");
    // The tablist and the groups have no box below sm, so Back and every tab are items of the one row
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    expect(list.className).toContain("contents");
    expect(list.className).toContain("sm:flex");
    for (const tab of within(nav).getAllByRole("tab")) {
      expect(tab.className).toContain("max-sm:flex-1");
      expect(tab.parentElement?.className).toContain("contents");
      // The label is hidden below md; the name comes from aria-label
      expect(tab.querySelector("span")?.className).toContain("hidden");
      expect(tab.getAttribute("aria-label")).toBeTruthy();
    }
    expect(nav.className).toContain("sm:w-12");
    expect(nav.parentElement?.className).toContain("flex-col");
    expect(nav.parentElement?.className).toContain("sm:flex-row");
  });

  it("has a tablist whose tabs have names and one selected tab", async () => {
    await open("tools");
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Models",
      "Tools",
      "Settings",
    ]);
    expect(
      tabs.filter((t) => t.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Tools" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "Models" }).tabIndex).toBe(-1);
    // Back is a command beside the tabs, not one of them
    expect(within(list).queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    await open("models");
    const models = screen.getByRole("tab", { name: "Models" });
    models.focus();
    fireEvent.keyDown(models, { key: "ArrowRight" });
    expect(screen.getByTestId("content-tools")).toBeDefined();
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Tools" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByTestId("content-settings")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByTestId("content-models")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByTestId("content-settings")).toBeDefined();
  });

  it("opens a tab by click", async () => {
    await open("models");
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(screen.getByTestId("content-tools")).toBeDefined();
  });
});
