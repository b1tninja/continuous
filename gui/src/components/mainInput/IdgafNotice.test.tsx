import { act, fireEvent, screen } from "@testing-library/react";
import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
import { builtinForPreset } from "core/tools/permissions/safetyDegrees";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import { setPolicyExtras, setPolicyLevels } from "../../redux/slices/uiSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { IdgafNotice, resetIdgafNoticeForTests } from "./IdgafNotice";

async function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<IdgafNotice />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  return store;
}

const line = () => screen.queryByTestId("idgaf-notice");

describe("IdgafNotice (D-001, D-002)", () => {
  beforeEach(() => resetIdgafNoticeForTests());

  /** The IDGAF preset: its levels and its switches, which say it is on */
  const idgaf = (store: Awaited<ReturnType<typeof setup>>) => {
    store.dispatch(setPolicyLevels({ ...POLICY_PRESETS.idgaf.levels }));
    store.dispatch(setPolicyExtras({ builtin: builtinForPreset("idgaf") }));
  };

  it("says nothing while any check is on", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevels({ ...DEFAULT_POLICY_LEVELS }));
    });
    expect(line()).toBeNull();
  });

  it("says nothing for the levels alone: the switches are what makes it IDGAF", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevels({ ...POLICY_PRESETS.idgaf.levels }));
    });
    expect(line()).toBeNull();
  });

  it("states once that rules, locked rules and protected files stop nothing", async () => {
    const store = await setup();
    await act(async () => idgaf(store));
    const text = line()!.textContent!;
    expect(text).toContain("IDGAF is on");
    expect(text).not.toContain("this session only");
    expect(text).toContain("rules, protected files and locks stop nothing");
    // A notice, not a question: the only control is Dismiss
    expect(line()!.querySelectorAll("button")).toHaveLength(1);
  });

  it("goes away when one check is turned back on", async () => {
    const store = await setup();
    await act(async () => idgaf(store));
    expect(line()).not.toBeNull();
    await act(async () => {
      store.dispatch(
        setPolicyExtras({
          builtin: { ...builtinForPreset("idgaf"), "protect-secrets": true },
        }),
      );
    });
    expect(line()).toBeNull();
  });

  it("stays dismissed for the chat session and shows again in a new one", async () => {
    const store = await setup();
    await act(async () => idgaf(store));
    fireEvent.click(screen.getByTestId("idgaf-notice-dismiss"));
    expect(line()).toBeNull();
    // Lowered and raised again in the same chat: still once
    await act(async () => {
      store.dispatch(setPolicyExtras({ builtin: {} }));
      idgaf(store);
    });
    expect(line()).toBeNull();
    // Dismissing changes nothing about the settings
    expect(store.getState().ui.policyLevels.tools).toBe("permissive");
    await act(async () => {
      store.dispatch(newSession());
    });
    expect(line()).not.toBeNull();
  });
});
