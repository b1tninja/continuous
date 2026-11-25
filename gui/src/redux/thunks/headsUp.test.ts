import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../slices/sessionSlice";
import { setPolicyExtras, setPolicyLevels } from "../slices/uiSlice";
import { setupStore } from "../store";
import { findToolCallById } from "../util";

import { callToolById } from "./callToolById";
import { holdForHeadsUp } from "./headsUp";
import { lapseToolCallThunk } from "./lapseToolCall";

const LEVELS = {
  context: "permissive",
  tools: "permissive",
  edits: "permissive",
  plan: "permissive",
  questions: "permissive",
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

function setup(calls: any[], headsUp?: Record<string, number>) {
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
  if (headsUp) store.dispatch(setPolicyExtras({ headsUp: headsUp as never }));
  return { store, sent };
}

const allowed = (store: ReturnType<typeof setup>["store"], ids: string[]) =>
  ids.map((id) => ({
    source: "permissive",
    toolCallState: findToolCallById(store.getState().session.history, id)!,
  }));

describe("holdForHeadsUp", () => {
  it("holds an allowed call for the window set at its level", () => {
    const { store } = setup([call("a")], { permissive: 5 });
    const held = holdForHeadsUp(
      store.getState(),
      store.dispatch,
      allowed(store, ["a"]),
    );
    expect([...held]).toEqual(["a"]);
    expect(
      findToolCallById(store.getState().session.history, "a")?.askTimer,
    ).toMatchObject({ seconds: 5, proposed: "allow" });
  });

  it("holds nothing without a heads-up window, even if an ask window is set", () => {
    const { store } = setup([call("a")]);
    store.dispatch(setPolicyExtras({ timer: { permissive: 30 } }));
    const held = holdForHeadsUp(
      store.getState(),
      store.dispatch,
      allowed(store, ["a"]),
    );
    expect(held.size).toBe(0);
    expect(
      findToolCallById(store.getState().session.history, "a")?.askTimer,
    ).toBeUndefined();
  });

  it("holds nothing at a level with no window", () => {
    const { store } = setup([call("a")], { manual: 5 });
    expect(
      holdForHeadsUp(store.getState(), store.dispatch, allowed(store, ["a"]))
        .size,
    ).toBe(0);
  });

  it("holds nothing at a level whose window is not the one set", () => {
    // a window for Permissive does not apply to a call at Cautious
    const { store } = setup([call("a")], { permissive: 5 });
    store.dispatch(setPolicyLevels({ ...LEVELS, tools: "cautious" }));
    expect(
      holdForHeadsUp(store.getState(), store.dispatch, allowed(store, ["a"]))
        .size,
    ).toBe(0);
  });

  it("holds several allowed calls together, on one reading of the clock", () => {
    const { store } = setup([call("a"), call("b"), call("c")], {
      permissive: 10,
    });
    const held = holdForHeadsUp(
      store.getState(),
      store.dispatch,
      allowed(store, ["a", "b", "c"]),
    );
    expect(held.size).toBe(3);
    const starts = ["a", "b", "c"].map(
      (id) =>
        findToolCallById(store.getState().session.history, id)?.askTimer
          ?.startedAt,
    );
    expect(new Set(starts).size).toBe(1);
  });

  it("holds nothing in an unattended Loop run", () => {
    const { store } = setup([call("a")], { permissive: 5 });
    const state = store.getState() as any;
    const looped = {
      ...state,
      session: { ...state.session, loop: { current: { id: "run" } } },
    };
    expect(
      holdForHeadsUp(looped, store.dispatch, allowed(store, ["a"])).size,
    ).toBe(0);
  });

  it("never holds longer than 10 s", () => {
    const { store } = setup([call("a")], { permissive: 10 });
    holdForHeadsUp(store.getState(), store.dispatch, allowed(store, ["a"]));
    const s = findToolCallById(store.getState().session.history, "a")?.askTimer;
    expect(s?.seconds).toBeLessThanOrEqual(10);
  });
});

describe("a heads-up window that ends", () => {
  const held = () =>
    call("a", { askTimer: { startedAt: 0, seconds: 5, proposed: "allow" } });

  it("lets the call run: it is not refused, and the trail says the system let it", async () => {
    const { store, sent } = setup([held()]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    const s = findToolCallById(store.getState().session.history, "a");
    expect(s?.status).not.toBe("errored");
    expect(JSON.stringify(s?.output ?? [])).not.toContain("No answer");
    expect(sent[0]).toEqual({
      type: "audit/timer",
      data: {
        callId: "a",
        resolved: { outcome: "default-applied", final: "allow" },
        held: { proposed: "allow", seconds: 5 },
      },
    });
  });
});

describe("the person answering inside a window", () => {
  it("accepting a heads-up is recorded as confirmed", async () => {
    const { store, sent } = setup([
      call("a", { askTimer: { startedAt: 0, seconds: 5, proposed: "allow" } }),
    ]);
    await store
      .dispatch(callToolById({ toolCallId: "a" }))
      .catch(() => undefined);
    expect(sent.find((s) => s.type === "audit/timer")?.data.resolved).toEqual({
      outcome: "confirmed",
      final: "allow",
    });
  });

  it("accepting an ask that was proposed to be refused is recorded as overridden", async () => {
    const { store, sent } = setup([
      call("a", {
        askTimer: { startedAt: 0, seconds: 15, proposed: "refuse" },
      }),
    ]);
    await store
      .dispatch(callToolById({ toolCallId: "a" }))
      .catch(() => undefined);
    expect(sent.find((s) => s.type === "audit/timer")?.data.resolved).toEqual({
      outcome: "overridden",
      final: "allow",
    });
  });

  it("a countdown the person stopped is not a timer outcome", async () => {
    const { store, sent } = setup([
      call("a", {
        askTimer: { startedAt: 0, seconds: 5, proposed: "allow", kept: true },
      }),
    ]);
    await store
      .dispatch(callToolById({ toolCallId: "a" }))
      .catch(() => undefined);
    expect(sent.filter((s) => s.type === "audit/timer")).toEqual([]);
  });

  it("a call with no timer sends no timer record", async () => {
    const { store, sent } = setup([call("a")]);
    await store
      .dispatch(callToolById({ toolCallId: "a" }))
      .catch(() => undefined);
    expect(sent.filter((s) => s.type === "audit/timer")).toEqual([]);
  });

  it("the call the window runs is not recorded twice", async () => {
    const { store, sent } = setup([
      call("a", { askTimer: { startedAt: 0, seconds: 5, proposed: "allow" } }),
    ]);
    await store.dispatch(lapseToolCallThunk({ toolCallId: "a" }));
    expect(sent.filter((s) => s.type === "audit/timer")).toHaveLength(1);
  });
});
