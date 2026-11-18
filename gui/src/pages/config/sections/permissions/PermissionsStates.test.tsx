import { act, fireEvent, screen } from "@testing-library/react";
import { listEffectiveRules } from "core/tools/permissions/effectiveRules";
import { DEFAULT_POLICY_LEVELS } from "core/tools/permissions/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import { updateConfig } from "../../../../redux/slices/configSlice";
import { setupStore } from "../../../../redux/store";
import { renderWithProviders } from "../../../../util/test/render";
import { PermissionsSection } from "./PermissionsSection";
import { SLOW_AFTER_MS } from "./PermissionsStates";

const report = listEffectiveRules({
  levels: DEFAULT_POLICY_LEVELS,
  user: {},
  maxNewPlanItems: 3,
});

async function setup(handler: () => Promise<unknown>) {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responseHandlers["policy/rules"] = handler as any;
  const post = vi.spyOn(ideMessenger, "post");
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<PermissionsSection />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {});
  return { post, store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Permissions loading and error states", () => {
  it("shows a status skeleton while the rules are read, then the page", async () => {
    let release: (v: unknown) => void = () => {};
    await setup(() => new Promise((res) => (release = res)));
    expect(screen.getByTestId("permissions-loading").textContent).toContain(
      "Reading your permission rules",
    );
    expect(
      screen.queryByRole("tablist", { name: "Permission areas" }),
    ).toBeNull();
    expect(screen.queryByTestId("permissions-slow")).toBeNull();
    await act(async () => release(report));
    expect(screen.queryByTestId("permissions-loading")).toBeNull();
    expect(
      screen.getByRole("tablist", { name: "Permission areas" }),
    ).toBeDefined();
  });

  it("says it is slow after the timeout and offers to try again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    await setup(() => {
      calls += 1;
      return new Promise(() => {});
    });
    expect(calls).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(SLOW_AFTER_MS + 100);
    });
    const slow = screen.getByTestId("permissions-slow");
    expect(slow.textContent).toContain("config.yaml");
    fireEvent.click(screen.getByTestId("permissions-retry"));
    await act(async () => {});
    expect(calls).toBe(2);
  });

  it("an error names the files, is not an empty list and Retry reads again", async () => {
    let fail = true;
    await setup(async () => {
      if (fail) throw new Error("boom");
      return report;
    });
    const alert = screen.getByTestId("permissions-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("config.yaml");
    expect(alert.textContent).toContain("not an empty list");
    expect(screen.queryByTestId("no-rules")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByTestId("permissions-retry"));
    await act(async () => {});
    expect(screen.queryByTestId("permissions-error")).toBeNull();
    expect(screen.getByTestId("tab-tools")).toBeDefined();
  });

  it("an area with no rules says what to do next", async () => {
    await setup(async () => report);
    expect(screen.getByTestId("no-rules").textContent).toContain("Add a rule");
  });
});

describe("Permissions first-run overview", () => {
  it("shows once, names the five areas and the presets, and has a named 24 px button", async () => {
    await setup(async () => report);
    const card = screen.getByTestId("permissions-intro");
    expect(card.textContent).toContain("Context use");
    expect(card.textContent).toContain("Questions");
    for (const preset of ["Careful", "Accept edits", "Hands off", "IDGAF"]) {
      expect(card.textContent).toContain(preset);
    }
    const dismiss = screen.getByRole("button", {
      name: "Got it, dismiss the permissions overview",
    });
    expect(dismiss.className).toContain("h-6");
    expect(document.querySelectorAll("[id]").length).toBe(
      new Set([...document.querySelectorAll("[id]")].map((e) => e.id)).size,
    );
  });

  it("dismissing hides it and saves it in the user's own settings", async () => {
    const { post, store } = await setup(async () => report);
    fireEvent.click(screen.getByTestId("permissions-intro-dismiss"));
    expect(screen.queryByTestId("permissions-intro")).toBeNull();
    expect(post).toHaveBeenCalledWith("config/updateSharedConfig", {
      permissionsIntroDismissed: true,
    });
    expect(store.getState().config.config.ui?.permissionsIntroDismissed).toBe(
      true,
    );
  });

  it("is not shown when it was dismissed before", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responseHandlers["policy/rules"] = (async () => report) as any;
    const store = setupStore({ ideMessenger });
    await renderWithProviders(<PermissionsSection />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    await act(async () => {});
    await act(async () => {
      store.dispatch(
        updateConfig({
          ...store.getState().config.config,
          ui: { permissionsIntroDismissed: true },
        }),
      );
    });
    expect(screen.queryByTestId("permissions-intro")).toBeNull();
  });
});
