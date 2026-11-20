import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setPolicyExtras, setPolicyLevels } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { changePolicyLevel } from "../../redux/thunks/policySettings";
import { renderWithProviders } from "../../util/test/render";
import { SafetyShield } from "./SafetyShield";
import { safetyShieldOn } from "./safetyChecks";

describe("safetyShieldOn", () => {
  it("follows the mode until the person chooses", () => {
    expect(safetyShieldOn(undefined, false)).toBe(true);
    expect(safetyShieldOn(undefined, true)).toBe(false);
    expect(safetyShieldOn(true, true)).toBe(true);
    expect(safetyShieldOn(false, false)).toBe(false);
  });
});

describe("SafetyShield", () => {
  async function setup() {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    const view = await renderWithProviders(<SafetyShield />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    return { ...view, store };
  }

  it("is on below IDGAF, and a click turns it off", async () => {
    const { store, user } = await setup();
    const badge = screen.getByTestId("safety-shield-toggle");
    expect(badge.getAttribute("data-on")).toBe("true");
    await user.click(badge);
    await user.click(
      screen
        .getByTestId("safety-shield-master")
        .querySelector(".rounded-full")!,
    );
    expect(store.getState().ui.policyExtras.safetyChecks).toBe(false);
    expect(badge.getAttribute("data-on")).toBe("false");
  });

  it("is off at IDGAF until the person turns it on", async () => {
    const { store, user } = await setup();
    await act(async () => {
      store.dispatch(
        setPolicyLevels({
          context: "idgaf",
          tools: "idgaf",
          edits: "idgaf",
          plan: "idgaf",
          questions: "idgaf",
        }),
      );
    });
    const badge = screen.getByTestId("safety-shield-toggle");
    expect(badge.getAttribute("aria-label")).toBe("Safety checks off at IDGAF");
    await user.click(badge);
    await user.click(
      screen
        .getByTestId("safety-shield-master")
        .querySelector(".rounded-full")!,
    );
    expect(store.getState().ui.policyExtras.safetyChecks).toBe(true);
    expect(badge.getAttribute("data-on")).toBe("true");
  });

  it("shows the individual checks off, and does not change them, while the shield is off", async () => {
    const { store, user } = await setup();
    await act(async () => {
      store.dispatch(setPolicyExtras({ safetyChecks: false }));
    });
    await user.click(screen.getByTestId("safety-shield-toggle"));
    const row = screen.getByTestId("shield-protect-secrets");
    const thumb = row.querySelector(".rounded-full .rounded-full")!;
    expect(thumb.className).toContain("-translate-x-1/2");
    await user.click(row.querySelector(".rounded-full")!);
    expect(
      store.getState().ui.policyExtras.builtin?.["protect-secrets"],
    ).not.toBe(false);
  });

  it("shows an individual check as on when the shield is on", async () => {
    const { user } = await setup();
    await user.click(screen.getByTestId("safety-shield-toggle"));
    const thumb = screen
      .getByTestId("shield-protect-secrets")
      .querySelector(".rounded-full .rounded-full")!;
    expect(thumb.className).toContain("translate-x-1/2");
    expect(thumb.className).not.toContain("-translate-x-1/2");
  });
});

describe("switching to IDGAF", () => {
  async function setupWithSaves() {
    const ideMessenger = new MockIdeMessenger();
    const saves: unknown[] = [];
    ideMessenger.responseHandlers["policy/save"] = async (update: unknown) => {
      saves.push(update);
    };
    ideMessenger.responseHandlers["policy/sessionIdgaf"] = async () => ({
      areas: [],
    });
    const store = setupStore({ ideMessenger });
    return { store, saves };
  }

  it("clears an explicit shield choice, and removes the line from the file", async () => {
    const { store, saves } = await setupWithSaves();
    store.dispatch(setPolicyExtras({ safetyChecks: true }));
    await store.dispatch(changePolicyLevel({ area: "tools", level: "idgaf" }));
    expect(store.getState().ui.policyExtras.safetyChecks).toBeUndefined();
    expect(saves.at(-1)).toMatchObject({ safetyChecks: null });
  });

  it("leaves a choice alone when no area enters IDGAF", async () => {
    const { store, saves } = await setupWithSaves();
    store.dispatch(setPolicyExtras({ safetyChecks: true }));
    await store.dispatch(
      changePolicyLevel({ area: "tools", level: "permissive" }),
    );
    expect(store.getState().ui.policyExtras.safetyChecks).toBe(true);
    expect(saves.at(-1)).toMatchObject({ safetyChecks: true });
  });

  it("keeps the choice made after entering IDGAF", async () => {
    const { store } = await setupWithSaves();
    await store.dispatch(changePolicyLevel({ area: "tools", level: "idgaf" }));
    store.dispatch(setPolicyExtras({ safetyChecks: true }));
    await store.dispatch(changePolicyLevel({ area: "edits", level: "idgaf" }));
    // IDGAF was already on: this is not a switch into it
    expect(store.getState().ui.policyExtras.safetyChecks).toBe(true);
  });
});
