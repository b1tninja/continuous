import { act, fireEvent, screen } from "@testing-library/react";
import {
  DEFAULT_POLICY_LEVELS,
  POLICY_PRESETS,
} from "core/tools/permissions/policy";
import { beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import { setPolicyLevels } from "../../redux/slices/uiSlice";
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

  it("says nothing below IDGAF", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevels({ ...DEFAULT_POLICY_LEVELS }));
    });
    expect(line()).toBeNull();
  });

  it("states once that rules, locked rules and protected files stop nothing", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevels({ ...POLICY_PRESETS.idgaf.levels }));
    });
    const text = line()!.textContent!;
    expect(text).toContain("IDGAF is on for this session only");
    expect(text).toContain("locked rules and protected files stop nothing");
    expect(text).toContain("audit trail records");
    // A notice, not a question: the only control is Dismiss
    expect(line()!.querySelectorAll("button")).toHaveLength(1);
  });

  it("names the areas when only some are at IDGAF", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(
        setPolicyLevels({ ...DEFAULT_POLICY_LEVELS, tools: "idgaf" }),
      );
    });
    expect(line()!.textContent).toContain("IDGAF is on for Tool use for");
  });

  it("stays dismissed for the chat session and shows again in a new one", async () => {
    const store = await setup();
    await act(async () => {
      store.dispatch(setPolicyLevels({ ...POLICY_PRESETS.idgaf.levels }));
    });
    fireEvent.click(screen.getByTestId("idgaf-notice-dismiss"));
    expect(line()).toBeNull();
    // Lowered and raised again in the same chat: still once
    await act(async () => {
      store.dispatch(setPolicyLevels({ ...DEFAULT_POLICY_LEVELS }));
      store.dispatch(setPolicyLevels({ ...POLICY_PRESETS.idgaf.levels }));
    });
    expect(line()).toBeNull();
    // The level stays where it was: dismissing changes nothing
    expect(store.getState().ui.policyLevels.tools).toBe("idgaf");
    await act(async () => {
      store.dispatch(newSession());
    });
    expect(line()).not.toBeNull();
  });
});
