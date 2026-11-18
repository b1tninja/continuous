import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setPolicyLevels } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
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
});
