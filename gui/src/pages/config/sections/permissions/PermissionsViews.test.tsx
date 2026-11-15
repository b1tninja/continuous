import { act, fireEvent, screen } from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";

const report = {
  ...listEffectiveRules({ levels: DEFAULT_POLICY_LEVELS, user: {} }),
  userFile: { path: "config.yaml", state: "ok" as const, hash: "h1" },
};

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
  await renderWithProviders(<PermissionsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
    ...(path ? { routerProps: { initialEntries: [path] } as any } : {}),
  });
  await act(async () => {});
  return h;
}

describe("Permissions views", () => {
  it("reads the audit only when its view is opened, and keeps the rules", async () => {
    const h = await setup();
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

  it("moves between the views with the arrow keys", async () => {
    await setup();
    await act(async () =>
      fireEvent.keyDown(screen.getByTestId("view-switch"), {
        key: "ArrowRight",
      }),
    );
    expect(
      screen.getByTestId("view-recent").getAttribute("aria-selected"),
    ).toBe("true");
  });
});
