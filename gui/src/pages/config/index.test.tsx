import { act, fireEvent, screen, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { EMPTY_CONFIG, updateConfig } from "../../redux/slices/configSlice";
import { setupStore } from "../../redux/store";
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
      tabs: [
        tab("models", "Models"),
        tab("tools", "Tools"),
        tab("permissions", "Permissions"),
      ],
    },
  ];
  const bottom = [{ id: "bottom", tabs: [tab("general", "General")] }];
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
      "Permissions",
      "General",
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
    expect(screen.getByTestId("content-general")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByTestId("content-models")).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByTestId("content-general")).toBeDefined();
  });

  it("opens a tab by click", async () => {
    await open("models");
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(screen.getByTestId("content-tools")).toBeDefined();
  });
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.search}</div>;
}

/** The page at a link, with or without a chat model selected. */
async function openAt(path: string, opts: { chatModel?: boolean } = {}) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const view = await renderWithProviders(
    <>
      <ConfigPage />
      <Where />
    </>,
    {
      store,
      mockIdeMessenger: ideMessenger,
      routerProps: { initialEntries: [path] } as never,
    },
  );
  if (opts.chatModel !== undefined) {
    const model = { title: "Alpha", model: "alpha", provider: "openai" };
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...EMPTY_CONFIG,
          selectedModelByRole: {
            ...EMPTY_CONFIG.selectedModelByRole,
            chat: opts.chatModel ? (model as never) : null,
          },
        }),
      );
    });
  }
  return view;
}

const where = () => screen.getByTestId("where").textContent;
const selected = () =>
  screen
    .getAllByRole("tab")
    .find((t) => t.getAttribute("aria-selected") === "true")
    ?.getAttribute("aria-label");

describe("old links into Settings", () => {
  beforeEach(() => localStorage.clear());

  it("?tab=settings opens General", async () => {
    await openAt("/config?tab=settings");
    expect(screen.getByTestId("content-general")).toBeDefined();
    expect(selected()).toBe("General");
    expect(where()).toBe("?tab=general");
  });

  it("?tab=indexing opens General at the index group", async () => {
    await openAt("/config?tab=indexing");
    expect(screen.getByTestId("content-general")).toBeDefined();
    expect(where()).toBe("?tab=general&section=index");
  });

  it("?tab=providers opens Models at Connections", async () => {
    await openAt("/config?tab=providers");
    expect(screen.getByTestId("content-models")).toBeDefined();
    expect(selected()).toBe("Models");
    expect(where()).toBe("?tab=models&section=connections");
  });

  it("?tab=tools still opens Tools", async () => {
    await openAt("/config?tab=tools");
    expect(screen.getByTestId("content-tools")).toBeDefined();
    expect(where()).toBe("?tab=tools");
  });

  it.each([
    ["approval", "?tab=permissions&view=levels"],
    ["skip-confirmation", "?tab=permissions&view=levels"],
    ["plans-questions", "?tab=permissions&section=plans-questions&view=levels"],
    [
      "builtin-rules",
      "?tab=permissions&section=builtin-rules&view=protections",
    ],
    [
      "commands-secrets",
      "?tab=permissions&section=commands-secrets&view=protections",
    ],
    [
      "decision-timer",
      "?tab=permissions&section=decision-timer&view=protections",
    ],
    [
      "shadow-review",
      "?tab=permissions&section=shadow-review&view=protections",
    ],
  ])(
    "?tab=tools&section=%s opens Permissions, where it moved",
    async (section, search) => {
      await openAt(`/config?tab=tools&section=${section}`);
      expect(screen.getByTestId("content-permissions")).toBeDefined();
      expect(selected()).toBe("Permissions");
      expect(where()).toBe(search);
    },
  );

  it("keeps the other parameters of a link it rewrites", async () => {
    await openAt("/config?tab=settings&custom=current");
    expect(where()).toBe("?tab=general&custom=current");
  });

  it("leaves a section of the Tools tab that did not move alone", async () => {
    await openAt("/config?tab=tools&section=somewhere");
    expect(screen.getByTestId("content-tools")).toBeDefined();
    expect(where()).toBe("?tab=tools&section=somewhere");
  });
});

describe("the tab Settings opens on with no tab in the link", () => {
  beforeEach(() => localStorage.clear());

  it("is Models while no chat model is selected, whatever was used last", async () => {
    localStorage.setItem("continuous.settings.lastTab", "tools");
    await openAt("/config", { chatModel: false });
    expect(screen.getByTestId("content-models")).toBeDefined();
    expect(selected()).toBe("Models");
    // Landing there is not a choice: the tab used last is kept
    expect(localStorage.getItem("continuous.settings.lastTab")).toBe("tools");
  });

  it("is the tab used last once a chat model is selected", async () => {
    localStorage.setItem("continuous.settings.lastTab", "tools");
    await openAt("/config", { chatModel: true });
    expect(screen.getByTestId("content-tools")).toBeDefined();
  });

  it("is Models the first time, and when the remembered tab is gone", async () => {
    await openAt("/config", { chatModel: true });
    expect(screen.getByTestId("content-models")).toBeDefined();
    localStorage.setItem("continuous.settings.lastTab", "providers");
    await openAt("/config", { chatModel: true });
    expect(screen.getAllByTestId("content-models")).toHaveLength(2);
  });

  it("remembers a tab that is opened by click or by link, under its new name", async () => {
    await openAt("/config?tab=models", { chatModel: true });
    expect(localStorage.getItem("continuous.settings.lastTab")).toBe("models");
    fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));
    expect(localStorage.getItem("continuous.settings.lastTab")).toBe(
      "permissions",
    );
    await openAt("/config?tab=settings", { chatModel: true });
    expect(localStorage.getItem("continuous.settings.lastTab")).toBe("general");
  });

  it("opens on Models when the storage cannot be read", async () => {
    localStorage.setItem("continuous.settings.lastTab", "tools");
    const real = Storage.prototype.getItem;
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === "continuous.settings.lastTab") throw new Error("denied");
        return real.call(this, key);
      });
    try {
      await openAt("/config", { chatModel: true });
      expect(screen.getByTestId("content-models")).toBeDefined();
    } finally {
      get.mockRestore();
    }
  });
});
