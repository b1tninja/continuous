import { act, fireEvent, screen } from "@testing-library/react";
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
import { findToolCallById } from "../../../../redux/util";
import { renderWithProviders } from "../../../../util/test/render";
import { PendingToolCallToolbar } from "./PendingToolCallToolbar";

const LEVELS = {
  context: "cautious",
  tools: "cautious",
  edits: "cautious",
  plan: "cautious",
  questions: "cautious",
} as const;

const call = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    parsedArgs: { command: "npm test" },
    status: "generated",
    ...extra,
  }) as any;

async function setup(calls: any[], timer: Record<string, number> | undefined) {
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
  await act(async () => {
    store.dispatch(updateConfig({ ...EMPTY_CONFIG }));
    store.dispatch(setPolicyLevels({ ...LEVELS }));
    if (timer) store.dispatch(setPolicyExtras({ timer: timer as never }));
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: calls,
          },
        ],
      } as any),
    );
  });
  return { store, sent };
}

const status = (
  store: Awaited<ReturnType<typeof setup>>["store"],
  id: string,
) => findToolCallById(store.getState().session.history, id)?.status;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PendingToolCallToolbar: the decision timer", () => {
  it("shows no countdown when no window is set", async () => {
    await setup([call("a")], undefined);
    expect(screen.queryByTestId("ask-timer-a")).toBeNull();
    expect(screen.queryByTestId("keep-waiting-a")).toBeNull();
  });

  it("shows what will happen and how long is left", async () => {
    await setup([call("a")], { cautious: 15 });
    expect(screen.getByTestId("ask-timer-a").textContent).toBe(
      "Refused in 15 s unless you answer",
    );
  });

  it("counts down", async () => {
    await setup([call("a")], { cautious: 15 });
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.getByTestId("ask-timer-a").textContent).toBe(
      "Refused in 9 s unless you answer",
    );
  });

  it("refuses the call when the window ends, and removes it from the list", async () => {
    const { store, sent } = await setup([call("a")], { cautious: 10 });
    await act(async () => {
      vi.advanceTimersByTime(10_500);
    });
    expect(status(store, "a")).toBe("errored");
    expect(screen.queryByTestId("pending-tool-call-toolbar")).toBeNull();
    expect(sent.map((s) => s.type)).toEqual(["audit/timer"]);
    expect(sent[0].data.resolved).toEqual({
      outcome: "default-applied",
      final: "refuse",
    });
  });

  it("does not refuse a call before its window ends", async () => {
    const { store } = await setup([call("a")], { cautious: 10 });
    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(status(store, "a")).toBe("generated");
  });

  it("Keep waiting stops the countdown and the call waits as long as it takes", async () => {
    const { store, sent } = await setup([call("a")], { cautious: 10 });
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("keep-waiting-a"));
    });
    expect(screen.queryByTestId("ask-timer-a")).toBeNull();
    expect(screen.queryByTestId("keep-waiting-a")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(600_000);
    });
    expect(status(store, "a")).toBe("generated");
    expect(sent).toEqual([]);
  });

  it("each waiting ask has its own countdown, on one clock", async () => {
    const { store } = await setup([call("a"), call("b")], { cautious: 10 });
    expect(screen.getByTestId("ask-timer-a").textContent).toBe(
      screen.getByTestId("ask-timer-b").textContent,
    );
    await act(async () => {
      vi.advanceTimersByTime(10_500);
    });
    expect(status(store, "a")).toBe("errored");
    expect(status(store, "b")).toBe("errored");
  });

  it("stopping one countdown leaves the other running", async () => {
    const { store } = await setup([call("a"), call("b")], { cautious: 10 });
    await act(async () => {
      fireEvent.click(screen.getByTestId("keep-waiting-a"));
    });
    await act(async () => {
      vi.advanceTimersByTime(10_500);
    });
    expect(status(store, "a")).toBe("generated");
    expect(status(store, "b")).toBe("errored");
  });

  it("an ask a rule raised has no countdown", async () => {
    await setup([call("a", { policySource: "ask-rule" })], { cautious: 10 });
    expect(screen.queryByTestId("ask-timer-a")).toBeNull();
  });

  it("the countdown is a timer that does not announce every second", async () => {
    await setup([call("a")], { cautious: 10 });
    const el = screen.getByTestId("ask-timer-a");
    expect(el.getAttribute("role")).toBe("timer");
    expect(el.getAttribute("aria-live")).toBe("off");
  });
});
