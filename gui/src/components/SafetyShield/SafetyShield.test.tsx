import { act, screen } from "@testing-library/react";
import { POLICY_PRESETS } from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setPolicyExtras } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import {
  applyPolicyPreset,
  changePolicyLevel,
  loadPolicySettings,
} from "../../redux/thunks/policySettings";
import { renderWithProviders } from "../../util/test/render";
import { SafetyShield } from "./SafetyShield";

function messenger(sessionAreas: string[] = []) {
  const ideMessenger = new MockIdeMessenger();
  const saves: any[] = [];
  ideMessenger.responseHandlers["policy/save"] = async (update: unknown) => {
    saves.push(update);
  };
  ideMessenger.responseHandlers["policy/sessionIdgaf"] = async () => ({
    areas: sessionAreas,
  });
  return { ideMessenger, saves };
}

describe("SafetyShield", () => {
  async function setup() {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    const view = await renderWithProviders(<SafetyShield />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    return { ...view, store, saves };
  }

  it("says All on by default, and None on after the IDGAF preset", async () => {
    const { store } = await setup();
    const badge = screen.getByTestId("safety-shield-toggle");
    expect(badge.getAttribute("aria-label")).toBe("Safety checks: All on");
    expect(badge.getAttribute("data-degree")).toBe("all");
    await act(async () => {
      await store.dispatch(applyPolicyPreset(POLICY_PRESETS.idgaf.levels));
    });
    expect(badge.getAttribute("aria-label")).toBe("Safety checks: None on");
    expect(badge.getAttribute("data-on")).toBe("false");
  });

  it("names the degree of each preset", async () => {
    const { store } = await setup();
    const badge = screen.getByTestId("safety-shield-toggle");
    const expected = {
      careful: "All on",
      acceptEdits: "All on",
      reviewer: "Some on",
      handsOff: "A few on",
      idgaf: "None on",
    } as const;
    for (const [name, label] of Object.entries(expected)) {
      await act(async () => {
        await store.dispatch(
          applyPolicyPreset(
            POLICY_PRESETS[name as keyof typeof POLICY_PRESETS].levels,
          ),
        );
      });
      expect(badge.getAttribute("aria-label"), name).toBe(
        `Safety checks: ${label}`,
      );
    }
  });

  it("None on and All on set every check at once", async () => {
    const { store, user } = await setup();
    await user.click(screen.getByTestId("safety-shield-toggle"));
    await user.click(screen.getByTestId("safety-shield-none"));
    expect(store.getState().ui.policyExtras.builtin).toEqual(
      builtinForPreset("idgaf"),
    );
    expect(screen.getByTestId("safety-shield-label").textContent).toBe(
      "None on",
    );
    await user.click(screen.getByTestId("safety-shield-all"));
    expect(store.getState().ui.policyExtras.builtin).toEqual({});
    expect(screen.getByTestId("safety-shield-label").textContent).toBe(
      "All on",
    );
  });

  it("one check can be switched on its own, and the label counts", async () => {
    const { store, user } = await setup();
    await act(async () => {
      await store.dispatch(applyPolicyPreset(POLICY_PRESETS.idgaf.levels));
    });
    await user.click(screen.getByTestId("safety-shield-toggle"));
    await user.click(
      screen
        .getByTestId("shield-protect-secrets")
        .querySelector(".rounded-full")!,
    );
    expect(store.getState().ui.policyExtras.builtin?.["protect-secrets"]).toBe(
      true,
    );
    expect(screen.getByTestId("safety-shield-label").textContent).toBe(
      "1 of 12 on",
    );
  });

  it("shows each check as on or off by its own switch", async () => {
    const { store, user } = await setup();
    await act(async () => {
      store.dispatch(
        setPolicyExtras({ builtin: { "ask-large-change": false } }),
      );
    });
    await user.click(screen.getByTestId("safety-shield-toggle"));
    const thumb = (id: string) =>
      screen
        .getByTestId(`shield-${id}`)
        .querySelector(".rounded-full .rounded-full")!.className;
    expect(thumb("protect-secrets")).not.toContain("-translate-x-1/2");
    expect(thumb("ask-large-change")).toContain("-translate-x-1/2");
  });
});

describe("a preset sets every knob", () => {
  it("the IDGAF preset turns every check off and writes none of that to the file", async () => {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    // The file had one check off
    store.dispatch(setPolicyExtras({ builtin: { "ask-large-change": false } }));
    await store.dispatch(applyPolicyPreset(POLICY_PRESETS.idgaf.levels));
    const extras = store.getState().ui.policyExtras;
    expect(extras.builtin).toEqual(builtinForPreset("idgaf"));
    expect(extras.savedBuiltin).toEqual({ "ask-large-change": false });
    // The file keeps what it had
    expect(saves.at(-1).builtin).toEqual({ "ask-large-change": false });
  });

  it("leaving IDGAF for Careful puts all the checks on, and that is what is saved", async () => {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    await store.dispatch(applyPolicyPreset(POLICY_PRESETS.idgaf.levels));
    await store.dispatch(applyPolicyPreset(POLICY_PRESETS.careful.levels));
    const extras = store.getState().ui.policyExtras;
    expect(extras.builtin).toEqual({});
    expect(extras.savedBuiltin).toBeUndefined();
    expect(saves.at(-1).builtin).toEqual({});
  });

  it("Hands off saves its own checks", async () => {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    await store.dispatch(applyPolicyPreset(POLICY_PRESETS.handsOff.levels));
    expect(saves.at(-1).builtin).toEqual(builtinForPreset("handsOff"));
  });

  it("changing one area leaves the checks as they are", async () => {
    const { ideMessenger } = messenger();
    const store = setupStore({ ideMessenger });
    await store.dispatch(applyPolicyPreset(POLICY_PRESETS.handsOff.levels));
    await store.dispatch(changePolicyLevel({ area: "tools", level: "idgaf" }));
    expect(store.getState().ui.policyExtras.builtin).toEqual(
      builtinForPreset("handsOff"),
    );
  });
});

describe("reloading the webview in the middle of an IDGAF run", () => {
  const file = (builtin: Record<string, boolean>) => async () => ({
    settings: { levels: POLICY_PRESETS.careful.levels, builtin },
    notices: [],
  });

  it("brings the checks back off when every area was at IDGAF", async () => {
    const { ideMessenger } = messenger([
      "context",
      "tools",
      "edits",
      "plan",
      "questions",
    ]);
    ideMessenger.responseHandlers["policy/load"] = file({
      "ask-large-change": false,
    });
    const store = setupStore({ ideMessenger });
    await store.dispatch(loadPolicySettings());
    const extras = store.getState().ui.policyExtras;
    expect(extras.builtin).toEqual(builtinForPreset("idgaf"));
    expect(extras.savedBuiltin).toEqual({ "ask-large-change": false });
  });

  it("reads the file's checks when only some areas were at IDGAF", async () => {
    const { ideMessenger } = messenger(["tools"]);
    ideMessenger.responseHandlers["policy/load"] = file({
      "ask-large-change": false,
    });
    const store = setupStore({ ideMessenger });
    await store.dispatch(loadPolicySettings());
    expect(store.getState().ui.policyExtras.builtin).toEqual({
      "ask-large-change": false,
    });
    expect(store.getState().ui.policyExtras.savedBuiltin).toBeUndefined();
  });

  it("reads the file's checks in a new session", async () => {
    const { ideMessenger } = messenger([]);
    ideMessenger.responseHandlers["policy/load"] = file({});
    const store = setupStore({ ideMessenger });
    await store.dispatch(loadPolicySettings());
    expect(store.getState().ui.policyExtras.builtin).toEqual({});
  });
});
