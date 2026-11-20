import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { selectPendingToolCalls } from "../selectors/selectToolCalls";
import { newSession, setToolCallTimer } from "../slices/sessionSlice";
import { setPolicyExtras, setPolicyLevels } from "../slices/uiSlice";
import { setupStore } from "../store";
import { findToolCallById } from "../util";

import { cancelToolCallThunk } from "./cancelToolCall";
import { lapseToolCallThunk } from "./lapseToolCall";
import { startToolTimersThunk } from "./startToolTimers";

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

function setup(calls: any[]) {
  const sent: Array<{ type: string; data: any }> = [];
  const ideMessenger = new MockIdeMessenger();
  for (const type of ["audit/timer", "audit/answer"] as const) {
    ideMessenger.responseHandlers[type] = (async (data: unknown) => {
      sent.push({ type, data });
    }) as never;
  }
  const store = setupStore({ ideMessenger });
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
  store.dispatch(setPolicyLevels({ ...LEVELS }));
  return { store, sent };
}

const stateOf = (store: ReturnType<typeof setup>["store"], id: string) =>
  findToolCallById(store.getState().session.history, id);

describe("startToolTimersThunk", () => {
  it("starts a window on a waiting ask, from the setting at its level", async () => {
    const { store } = setup([call("a")]);
    store.dispatch(setPolicyExtras({ timer: { cautious: 15 } }));
    await store.dispatch(startToolTimersThunk());
    expect(stateOf(store, "a")?.askTimer).toMatchObject({
      seconds: 15,
      proposed: "refuse",
    });
  });

  it("does nothing without a setting", async () => {
    const { store } = setup([call("a")]);
    await store.dispatch(startToolTimersThunk());
    expect(stateOf(store, "a")?.askTimer).toBeUndefined();
  });

  it("does nothing when the setting is for another level", async () => {
    const { store } = setup([call("a")]);
    store.dispatch(setPolicyExtras({ timer: { permissive: 10 } }));
    await store.dispatch(startToolTimersThunk());
    expect(stateOf(store, "a")?.askTimer).toBeUndefined();
  });

  it("leaves an ask that a rule or a guard raised to wait", async () => {
    const { store } = setup([
      call("rule", { policySource: "ask-rule" }),
      call("path", { policySource: "protected-path" }),
      call("taint", { policySource: "tainted-session" }),
      call("plain"),
    ]);
    store.dispatch(setPolicyExtras({ timer: { cautious: 10 } }));
    await store.dispatch(startToolTimersThunk());
    expect(stateOf(store, "rule")?.askTimer).toBeUndefined();
    expect(stateOf(store, "path")?.askTimer).toBeUndefined();
    expect(stateOf(store, "taint")?.askTimer).toBeUndefined();
    expect(stateOf(store, "plain")?.askTimer).toBeDefined();
  });

  it("runs the windows of several waiting asks side by side, from the same moment", async () => {
    const { store } = setup([call("a"), call("b"), call("c")]);
    store.dispatch(setPolicyExtras({ timer: { cautious: 30 } }));
    await store.dispatch(startToolTimersThunk());
    const starts = ["a", "b", "c"].map(
      (id) => stateOf(store, id)?.askTimer?.startedAt,
    );
    expect(new Set(starts).size).toBe(1);
  });

  it("does not restart a window, or one the person stopped", async () => {
    const { store } = setup([call("a"), call("b")]);
    store.dispatch(setPolicyExtras({ timer: { cautious: 10 } }));
    store.dispatch(
      setToolCallTimer({
        toolCallId: "a",
        timer: { startedAt: 1, seconds: 10, proposed: "refuse", kept: true },
      }),
    );
    await store.dispatch(startToolTimersThunk());
    expect(stateOf(store, "a")?.askTimer).toEqual({
      startedAt: 1,
      seconds: 10,
      proposed: "refuse",
      kept: true,
    });
  });

  it("ignores a call that is not waiting", async () => {
    const { store } = setup([call("done", { status: "done" })]);
    store.dispatch(setPolicyExtras({ timer: { cautious: 10 } }));
    await store.dispatch(startToolTimersThunk());
    expect(stateOf(store, "done")?.askTimer).toBeUndefined();
  });
});

describe("lapseToolCallThunk", () => {
  const withTimer = (over: Record<string, unknown> = {}) =>
    call("a", {
      askTimer: { startedAt: 0, seconds: 10, proposed: "refuse" },
      ...over,
    });

  it("refuses the ask, tells the model nobody answered, and records it as the system's", async () => {
    const { store, sent } = setup([withTimer()]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    const s = stateOf(store, "a");
    expect(s?.status).toBe("errored");
    const text = (s?.output ?? []).map((o) => o.content).join("\n");
    expect(text).toContain("No answer to run_terminal_command within 10 s");
    expect(text).toContain("did not refuse it");
    expect(text).not.toMatch(
      /user skipped|alternative approach|security policy/i,
    );
    expect(sent).toEqual([
      {
        type: "audit/timer",
        data: {
          callId: "a",
          resolved: { outcome: "default-applied", final: "refuse" },
          held: { proposed: "refuse", seconds: 10 },
        },
      },
    ]);
  });

  it("does nothing for a countdown the person stopped", async () => {
    const { store, sent } = setup([
      withTimer({
        askTimer: { startedAt: 0, seconds: 10, proposed: "refuse", kept: true },
      }),
    ]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    expect(stateOf(store, "a")?.status).toBe("generated");
    expect(sent).toEqual([]);
  });

  it("does nothing for a call with no timer, one that already ran, or one that is unknown", async () => {
    const { store, sent } = setup([
      call("plain"),
      withTimer({ status: "done" }),
    ]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "plain" }));
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    await store.dispatch(lapseToolCallThunk({ toolCallId: "nope" }));
    expect(stateOf(store, "plain")?.status).toBe("generated");
    expect(stateOf(store, "a")?.status).toBe("done");
    expect(sent).toEqual([]);
  });

  it("is safe to run twice: the second does nothing", async () => {
    const { store, sent } = setup([withTimer()]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    expect(sent).toHaveLength(1);
  });

  it("leaves the other waiting asks alone", async () => {
    const { store } = setup([withTimer(), call("b")]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    expect(
      selectPendingToolCalls(store.getState()).map((c) => c.toolCallId),
    ).toEqual(["b"]);
  });
});

describe("rejecting a call the timer was holding", () => {
  it("records the timer's outcome and tells the model the person declined", async () => {
    const { store, sent } = setup([
      call("a", {
        askTimer: { startedAt: 0, seconds: 15, proposed: "refuse" },
      }),
    ]);
    store.dispatch({
      type: "config/updateConfig",
      payload: { ui: { continueAfterToolRejection: true } },
    } as never);
    await store.dispatch(cancelToolCallThunk({ toolCallId: "a" }));
    expect(sent).toEqual([
      {
        type: "audit/timer",
        data: {
          callId: "a",
          resolved: { outcome: "confirmed", final: "refuse" },
          held: { proposed: "refuse", seconds: 15 },
        },
      },
    ]);
  });

  it("a call with no timer is recorded and worded as before", async () => {
    const { store, sent } = setup([call("a")]);
    await store.dispatch(cancelToolCallThunk({ toolCallId: "a" }));
    expect(sent).toEqual([
      { type: "audit/answer", data: { callId: "a", approved: false } },
    ]);
  });

  it("a countdown the person stopped is a plain rejection", async () => {
    const { store, sent } = setup([
      call("a", {
        askTimer: { startedAt: 0, seconds: 15, proposed: "refuse", kept: true },
      }),
    ]);
    await store.dispatch(cancelToolCallThunk({ toolCallId: "a" }));
    expect(sent.map((s) => s.type)).toEqual(["audit/answer"]);
  });
});
