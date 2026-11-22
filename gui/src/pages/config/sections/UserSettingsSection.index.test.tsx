import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { updateConfig } from "../../../redux/slices/configSlice";
import { setupStore } from "../../../redux/store";
import { renderWithProviders } from "../../../util/test/render";
import { bottomTabSections, getAllTabs, topTabSections } from "../configTabs";
import ConfigPage from "../index";
import { indexingSummary } from "./IndexingSettingsSection";
import { answerProtectionsReads } from "./permissions/protectionsTestHost";
import { UserSettingsSection } from "./UserSettingsSection";

async function setup(
  config: { disableIndexing?: boolean; docs?: unknown[] } = {},
  opts: { path?: string; ui?: React.ReactElement } = {},
) {
  const ideMessenger = new MockIdeMessenger();
  // A moved section's link opens the Protections view, which reads its state
  answerProtectionsReads(ideMessenger);
  const store = setupStore({ ideMessenger });
  await renderWithProviders(opts.ui ?? <UserSettingsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
    ...(opts.path
      ? { routerProps: { initialEntries: [opts.path] } as never }
      : {}),
  });
  await act(async () => {
    store.dispatch(
      updateConfig({ ...store.getState().config.config, ...config } as never),
    );
  });
  return store;
}

const summary = () => screen.getByTestId("fold-summary-index").textContent;
const isOpen = () =>
  screen.getByTestId("fold-toggle-index").getAttribute("aria-expanded") ===
  "true";

describe("General: Codebase index and docs", () => {
  it("is the General page, with the index group folded and marked deprecated", async () => {
    await setup();
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByText("User Settings")).toBeNull();
    const toggle = screen.getByTestId("fold-toggle-index");
    expect(toggle.textContent).toContain("Codebase index and docs");
    expect(toggle.textContent).toContain("deprecated");
    expect(isOpen()).toBe(false);
  });

  it("says in one line whether the index is on, who chose that, and the docs", async () => {
    await setup();
    expect(summary()).toBe("Not set: index on. 0 docs");
    expect(indexingSummary({ disableIndexing: true, docs: [{}] })).toBe(
      "Set by you: index off. 1 doc",
    );
    expect(indexingSummary({ disableIndexing: false, docs: [{}, {}] })).toBe(
      "Set by you: index on. 2 docs",
    );
  });

  it("the header follows the switch", async () => {
    await setup({ disableIndexing: true, docs: [{ startUrl: "a" }] });
    expect(summary()).toBe("Set by you: index off. 1 doc");
  });

  it("holds the three sections the Indexing tab had, each once", async () => {
    await setup();
    fireEvent.click(screen.getByTestId("fold-toggle-index"));
    expect(isOpen()).toBe(true);
    expect(screen.getAllByText("Indexing has been deprecated")).toHaveLength(1);
    expect(screen.getAllByText("Enable indexing")).toHaveLength(1);
    expect(screen.getAllByText("@codebase index")).toHaveLength(1);
    expect(screen.getAllByText("Documentation")).toHaveLength(1);
    expect(screen.getByTestId("indexing-state").textContent).toBe(
      "Not set: on.",
    );
  });

  it("?section=index opens the group", async () => {
    await setup({}, { path: "/config?tab=general&section=index" });
    expect(isOpen()).toBe(true);
  });
});

describe("the Settings tabs", () => {
  it("has no Indexing tab and no tab named Settings; General and Help are last", () => {
    const ids = getAllTabs()
      .filter((t) => !t.action)
      .map((t) => t.id);
    expect(ids).not.toContain("indexing");
    expect(ids).not.toContain("settings");
    expect(ids.slice(-2)).toEqual(["general", "help"]);
    expect(bottomTabSections[0].tabs.map((t) => t.label)).toEqual([
      "General",
      "Help",
    ]);
  });

  it("orders the first group Models, Tools, Permissions, Rules, then Configs", () => {
    const ids = topTabSections
      .flatMap((s) => s.tabs)
      .filter((t) => !t.action)
      .map((t) => t.id)
      // Providers goes when it merges into Models; MCP servers joins after Models
      .filter((id) => id !== "providers" && id !== "mcp");
    expect(ids).toEqual(["models", "tools", "permissions", "rules", "configs"]);
    expect(topTabSections.flatMap((s) => s.tabs)[1].id).toBe("models");
  });

  it("the old Indexing link opens General with the index group open", async () => {
    await setup({}, { path: "/config?tab=indexing", ui: <ConfigPage /> });
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(isOpen()).toBe(true);
  });

  it("the old Settings link opens General with the index group folded", async () => {
    await setup({}, { path: "/config?tab=settings", ui: <ConfigPage /> });
    expect(
      screen
        .getByRole("tab", { name: "General" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(isOpen()).toBe(false);
  });

  it("a moved section's link opens its Permissions view with the fold open", async () => {
    await setup(
      {},
      { path: "/config?tab=tools&section=decision-timer", ui: <ConfigPage /> },
    );
    await act(async () => {});
    expect(
      screen
        .getByRole("tab", { name: "Permissions" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByTestId("view-protections").getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("fold-toggle-decision-timer")
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("the Approval link opens Permissions at Levels", async () => {
    await setup(
      {},
      { path: "/config?tab=tools&section=approval", ui: <ConfigPage /> },
    );
    await act(async () => {});
    expect(
      screen.getByTestId("view-levels").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("policy-card")).toBeTruthy();
  });
});
