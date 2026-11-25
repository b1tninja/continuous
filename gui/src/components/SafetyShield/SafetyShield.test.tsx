import { act, screen } from "@testing-library/react";
import {
  BUILTIN_RULES,
  presetOf,
  PRESET_FREE_RULES,
  type PolicyPresetName,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
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

function messenger() {
  const ideMessenger = new MockIdeMessenger();
  const saves: any[] = [];
  ideMessenger.responseHandlers["policy/save"] = async (update: unknown) => {
    saves.push(update);
  };
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
      await store.dispatch(applyPolicyPreset("idgaf"));
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
        await store.dispatch(applyPolicyPreset(name as PolicyPresetName));
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
      await store.dispatch(applyPolicyPreset("idgaf"));
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
    // 1 of however many checks a preset sets: derived, so adding a switch does not break this
    const total = BUILTIN_RULES.filter(
      (r) => !PRESET_FREE_RULES.has(r.id),
    ).length;
    expect(screen.getByTestId("safety-shield-label").textContent).toBe(
      `1 of ${total} on`,
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

describe("a preset sets every knob, and what it sets is saved like anything else", () => {
  it("the IDGAF preset turns every check off, and the file gets those switches", async () => {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    // The file had one check off
    store.dispatch(setPolicyExtras({ builtin: { "ask-large-change": false } }));
    await store.dispatch(applyPolicyPreset("idgaf"));
    const extras = store.getState().ui.policyExtras;
    expect(extras.builtin).toEqual(builtinForPreset("idgaf"));
    // IDGAF is a preset like the others: nothing is held back for later
    expect(saves.at(-1).builtin).toEqual(builtinForPreset("idgaf"));
    expect(saves.at(-1).levels).toMatchObject({
      tools: "permissive",
      edits: "permissive",
    });
  });

  it("leaving IDGAF for Careful puts all the checks on, and that is what is saved", async () => {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    await store.dispatch(applyPolicyPreset("idgaf"));
    await store.dispatch(applyPolicyPreset("careful"));
    const extras = store.getState().ui.policyExtras;
    expect(extras.builtin).toEqual({});
    expect(saves.at(-1).builtin).toEqual({});
  });

  it("Hands off saves its own checks", async () => {
    const { ideMessenger, saves } = messenger();
    const store = setupStore({ ideMessenger });
    await store.dispatch(applyPolicyPreset("handsOff"));
    expect(saves.at(-1).builtin).toEqual(builtinForPreset("handsOff"));
  });

  it("changing one area leaves the checks as they are", async () => {
    const { ideMessenger } = messenger();
    const store = setupStore({ ideMessenger });
    await store.dispatch(applyPolicyPreset("handsOff"));
    await store.dispatch(
      changePolicyLevel({ area: "tools", level: "permissive" }),
    );
    expect(store.getState().ui.policyExtras.builtin).toEqual(
      builtinForPreset("handsOff"),
    );
  });

  it("a rejected save puts the levels and the checks back", async () => {
    const { ideMessenger } = messenger();
    ideMessenger.responseHandlers["policy/save"] = async () => {
      throw new Error("disk full");
    };
    const store = setupStore({ ideMessenger });
    const before = store.getState().ui.policyLevels;
    const beforeBuiltin = store.getState().ui.policyExtras.builtin;
    await store.dispatch(applyPolicyPreset("idgaf"));
    expect(store.getState().ui.policyLevels).toEqual(before);
    expect(store.getState().ui.policyExtras.builtin).toEqual(beforeBuiltin);
  });
});

describe("reloading the webview", () => {
  const file =
    (preset: PolicyPresetName, builtin: Record<string, boolean>) =>
    async () => ({
      settings: { levels: POLICY_PRESETS[preset].levels, builtin },
      notices: [],
    });

  it("keeps the IDGAF preset: its checks come back as they were saved", async () => {
    const { ideMessenger } = messenger();
    ideMessenger.responseHandlers["policy/load"] = file(
      "idgaf",
      builtinForPreset("idgaf"),
    );
    const store = setupStore({ ideMessenger });
    await store.dispatch(loadPolicySettings());
    const { policyLevels, policyExtras } = store.getState().ui;
    expect(presetOf(policyLevels, policyExtras.builtin)).toBe("idgaf");
    expect(policyExtras.builtin).toEqual(builtinForPreset("idgaf"));
  });

  it("reads the file's checks as they are for any other levels", async () => {
    const { ideMessenger } = messenger();
    ideMessenger.responseHandlers["policy/load"] = file("careful", {
      "ask-large-change": false,
    });
    const store = setupStore({ ideMessenger });
    await store.dispatch(loadPolicySettings());
    expect(store.getState().ui.policyExtras.builtin).toEqual({
      "ask-large-change": false,
    });
  });

  it("the levels of IDGAF with one check on read as Custom, not IDGAF", async () => {
    const { ideMessenger } = messenger();
    ideMessenger.responseHandlers["policy/load"] = file("idgaf", {
      ...builtinForPreset("idgaf"),
      "protect-secrets": true,
    });
    const store = setupStore({ ideMessenger });
    await store.dispatch(loadPolicySettings());
    const { policyLevels, policyExtras } = store.getState().ui;
    expect(presetOf(policyLevels, policyExtras.builtin)).toBeUndefined();
  });
});
