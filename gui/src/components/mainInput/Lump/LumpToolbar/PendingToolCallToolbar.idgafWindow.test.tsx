import { act, fireEvent, screen } from "@testing-library/react";
import { PLAN_MODE_HOLD_REASON } from "core/tools/permissions/planMode";
import { POLICY_PRESETS } from "core/tools/permissions/policy";
import { refusalText } from "core/tools/refusalText";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../../../context/MockIdeMessenger";
import {
  EMPTY_CONFIG,
  updateConfig,
} from "../../../../redux/slices/configSlice";
import { newSession } from "../../../../redux/slices/sessionSlice";
import {
  setPolicyExtras,
  setPolicyLevels,
} from "../../../../redux/slices/uiSlice";
import { setupStore } from "../../../../redux/store";
import { holdForHeadsUp } from "../../../../redux/thunks/headsUp";
import { findToolCallById } from "../../../../redux/util";
import { renderWithProviders } from "../../../../util/test/render";

import {
  generateToolCallButtonTestId,
  PendingToolCallToolbar,
} from "./PendingToolCallToolbar";

/**
 * IDGAF with a heads-up window of 5 s: a call it ran past Plan mode's hold is
 * shown with a countdown and what a lower level would have done. It runs when
 * the window ends; "Don't run" declines that one call.
 */
const PLAN_OVERRIDE = {
  policy: "allowedWithPermission" as const,
  source: "plan-mode",
  reason: PLAN_MODE_HOLD_REASON,
};

const call = (id: string) =>
  ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    parsedArgs: { command: "mkdir x" },
    status: "generated",
  }) as any;

async function setup(seconds: number | undefined) {
  const sent: Array<{ type: string; data: any }> = [];
  const ideMessenger = new MockIdeMessenger();
  for (const type of ["audit/timer", "audit/answer"] as const) {
    ideMessenger.responseHandlers[type] = (async (data: unknown) => {
      sent.push({ type, data });
    }) as never;
  }
  const store = setupStore({ ideMessenger });
  await renderWithProviders(<PendingToolCallToolbar />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  let held = new Set<string>();
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        ui: { ...EMPTY_CONFIG.ui, continueAfterToolRejection: true },
      }),
    );
    store.dispatch(setPolicyLevels({ ...POLICY_PRESETS.idgaf.levels }));
    if (seconds) {
      store.dispatch(setPolicyExtras({ headsUp: { idgaf: seconds } as never }));
    }
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [call("a")],
          },
        ],
      } as any),
    );
    // What the turn does with a call the engine allowed at IDGAF
    held = holdForHeadsUp(store.getState(), store.dispatch, [
      {
        source: "idgaf",
        idgafOverride: PLAN_OVERRIDE,
        toolCallState: findToolCallById(store.getState().session.history, "a")!,
      },
    ]);
  });
  return { store, sent, held };
}

const stateOf = (store: Awaited<ReturnType<typeof setup>>["store"]) =>
  findToolCallById(store.getState().session.history, "a");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PendingToolCallToolbar: IDGAF's heads-up window", () => {
  it("at 0, the default, the call is not held and nothing is shown", async () => {
    const { held } = await setup(undefined);
    expect(held.size).toBe(0);
    expect(screen.queryByTestId("ask-timer-a")).toBeNull();
  });

  it("at 5 s, says when it runs and what a lower level would have done", async () => {
    const { held } = await setup(5);
    expect([...held]).toEqual(["a"]);
    expect(screen.getByTestId("ask-timer-a").textContent).toBe(
      `Runs in 5 s unless you answer. Below IDGAF this call would have been asked: ${PLAN_MODE_HOLD_REASON}`,
    );
    expect(
      screen.getByTestId(generateToolCallButtonTestId("accept", "a"))
        .textContent,
    ).toContain("Run now");
    expect(
      screen.getByTestId(generateToolCallButtonTestId("reject", "a"))
        .textContent,
    ).toBe("Don't run");
  });

  it("counts down, and does not run before the window ends", async () => {
    const { store, sent } = await setup(5);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByTestId("ask-timer-a").textContent).toContain(
      "Runs in 2 s unless you answer.",
    );
    expect(stateOf(store)?.status).toBe("generated");
    expect(sent).toEqual([]);
  });

  it("runs when the window ends, and the trail says nobody answered", async () => {
    const { store, sent } = await setup(5);
    await act(async () => {
      vi.advanceTimersByTime(5_500);
    });
    // The store here has no model, so the call itself stops early; the
    // record is written before that, and it was not declined
    expect(stateOf(store)?.status).not.toBe("canceled");
    expect(sent.filter((s) => s.type === "audit/timer")).toEqual([
      {
        type: "audit/timer",
        data: {
          callId: "a",
          resolved: { outcome: "default-applied", final: "allow" },
          held: { proposed: "allow", seconds: 5 },
        },
      },
    ]);
  });

  it("Don't run declines that call: it does not run, and the level stays", async () => {
    const { store, sent } = await setup(5);
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(generateToolCallButtonTestId("reject", "a")),
      );
    });
    expect(stateOf(store)?.status).toBe("canceled");
    expect(stateOf(store)?.output?.[0].content).toBe(
      refusalText.declined("run_terminal_command"),
    );
    expect(sent).toEqual([
      {
        type: "audit/timer",
        data: {
          callId: "a",
          resolved: { outcome: "overridden", final: "refuse" },
          held: { proposed: "allow", seconds: 5 },
        },
      },
    ]);
    expect(store.getState().ui.policyLevels.tools).toBe("idgaf");
    // The window that would have run it is gone with the call
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(stateOf(store)?.status).toBe("canceled");
    expect(sent).toHaveLength(1);
  });

  it("Run now runs it at once, recorded as the person's choice", async () => {
    const { store, sent } = await setup(5);
    await act(async () => {
      fireEvent.click(
        screen.getByTestId(generateToolCallButtonTestId("accept", "a")),
      );
    });
    expect(stateOf(store)?.status).not.toBe("canceled");
    expect(sent.find((s) => s.type === "audit/timer")?.data.resolved).toEqual({
      outcome: "confirmed",
      final: "allow",
    });
  });

  it("Keep waiting stops the countdown: the buttons are Accept and Reject again", async () => {
    const { store } = await setup(5);
    await act(async () => {
      fireEvent.click(screen.getByTestId("keep-waiting-a"));
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(stateOf(store)?.status).toBe("generated");
    expect(
      screen.getByTestId(generateToolCallButtonTestId("reject", "a"))
        .textContent,
    ).toBe("Reject");
  });
});
