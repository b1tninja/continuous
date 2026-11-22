import { act, fireEvent, screen, within } from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import {
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";

const report = {
  ...listEffectiveRules({ levels: DEFAULT_POLICY_LEVELS, user: {} }),
  userFile: { path: "config.yaml", state: "ok" as const, hash: "h1" },
};

/** The router's navigate, as the panel's `navigateTo` listener calls it. */
let navigate: NavigateFunction;
let search = "";
function RouterProbe() {
  navigate = useNavigate();
  search = useLocation().search;
  return null;
}

async function setup(path?: string) {
  const ideMessenger = new MockIdeMessenger();
  const h = ideMessenger.responseHandlers as any;
  h["policy/rules"] = vi.fn(async () => report);
  h["audit/status"] = vi.fn(async () => ({
    enabled: true,
    retentionDays: 30,
    via: "default",
  }));
  h["audit/list"] = vi.fn(async () => ({
    rows: [],
    facets: { tools: [], agents: ["main"] },
  }));
  h["audit/inbox"] = vi.fn(async () => ({ items: [], hiddenOlder: 0 }));
  const store = setupStore({ ideMessenger });
  await renderWithProviders(
    <>
      <PermissionsSection />
      <RouterProbe />
    </>,
    {
      store,
      mockIdeMessenger: ideMessenger,
      ...(path ? { routerProps: { initialEntries: [path] } as any } : {}),
    },
  );
  await act(async () => {});
  return h;
}

describe("Permissions views", () => {
  it("has five views in order and opens on Levels", async () => {
    await setup();
    const tabs = within(screen.getByTestId("view-switch")).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Levels",
      "Rules",
      "Protections",
      "Recent calls",
      "Inbox",
    ]);
    expect(
      screen.getByTestId("view-levels").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("policy-card")).toBeTruthy();
    expect(screen.queryByTestId("protections")).toBeNull();
  });

  it("reads the audit only when its view is opened, and keeps the rules", async () => {
    const h = await setup("/config?tab=permissions&view=rules");
    expect(h["audit/list"]).not.toHaveBeenCalled();
    expect(screen.getByTestId("view-rules").getAttribute("aria-selected")).toBe(
      "true",
    );
    await act(async () => fireEvent.click(screen.getByTestId("view-recent")));
    expect(h["audit/list"]).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("audit-list")).toBeTruthy();
    expect(
      screen.getByTestId("panel-tools").closest("[hidden]"),
    ).not.toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("view-inbox")));
    expect(h["audit/inbox"]).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("audit-empty-inbox")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByTestId("view-rules")));
    expect(screen.queryByTestId("audit-inbox")).toBeNull();
    expect(screen.getByTestId("panel-tools").closest("[hidden]")).toBeNull();
  });

  it("opens at the Inbox from ?view=inbox (Open the Audit Inbox in the palette)", async () => {
    const h = await setup("/config?tab=permissions&view=inbox");
    expect(screen.getByTestId("view-inbox").getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(h["audit/inbox"]).toHaveBeenCalledTimes(1);
  });

  it("lands on the Inbox each time the palette command runs, after a change of view by hand", async () => {
    const inbox = "/config?tab=permissions&view=inbox";
    await setup(inbox);
    expect(search).toBe("?tab=permissions");
    const selected = (id: string) =>
      screen.getByTestId(id).getAttribute("aria-selected");
    for (const other of ["view-rules", "view-recent"]) {
      await act(async () => fireEvent.click(screen.getByTestId(other)));
      expect(selected(other)).toBe("true");
      await act(async () => navigate(inbox));
      expect(selected("view-inbox"), `back from ${other}`).toBe("true");
    }
  });

  it("moves between the views with the arrow keys", async () => {
    await setup();
    await act(async () =>
      fireEvent.keyDown(screen.getByTestId("view-switch"), {
        key: "ArrowRight",
      }),
    );
    expect(screen.getByTestId("view-rules").getAttribute("aria-selected")).toBe(
      "true",
    );
    await act(async () =>
      fireEvent.keyDown(screen.getByTestId("view-switch"), {
        key: "ArrowLeft",
      }),
    );
    await act(async () =>
      fireEvent.keyDown(screen.getByTestId("view-switch"), {
        key: "ArrowLeft",
      }),
    );
    expect(screen.getByTestId("view-inbox").getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
