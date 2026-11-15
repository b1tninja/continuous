import type { ChatHistoryItem, LoopState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";

// The buttons' own thunks: a palette command must run exactly these
const calls = vi.hoisted(() => [] as string[]);
vi.mock("./cancelStream", () => ({
  cancelStream: () => () => calls.push("cancelStream"),
}));
vi.mock("./resumeTurn", () => ({
  resumeTurn: () => () => calls.push("resumeTurn"),
}));
vi.mock("./loop", () => ({
  chooseLoopMode: () => () => calls.push("chooseLoopMode"),
  resumeLoopThunk: () => () => calls.push("resumeLoopThunk"),
  stopLoopThunk: () => () => calls.push("stopLoopThunk"),
}));

import {
  resumeResponseThunk,
  startLoopFromPaletteThunk,
  stopLoopFromPaletteThunk,
  stopResponseThunk,
} from "./paletteCommands";

/** Session fields to set; test histories carry plain ChatHistoryItems. */
function storeWith(session: Record<string, unknown>) {
  const base = getEmptyRootState();
  return createMockStore({
    session: { ...base.session, ...session } as typeof base.session,
  });
}

const user = (interrupted?: ChatHistoryItem["interrupted"]): ChatHistoryItem =>
  ({
    message: { id: "u1", role: "user", content: "hi" },
    contextItems: [],
    editorState: { type: "doc", content: [] },
    interrupted,
  }) as ChatHistoryItem;

const loop = (overrides: Partial<LoopState>): LoopState =>
  ({ status: "running", ...overrides }) as LoopState;

beforeEach(() => {
  calls.length = 0;
});

describe("palette Stop Response", () => {
  it("cancels a streaming reply", async () => {
    const store = storeWith({ isStreaming: true });
    expect(await store.dispatch(stopResponseThunk() as any).unwrap()).toBe(
      true,
    );
    expect(calls).toEqual(["cancelStream"]);
  });

  it("kills running terminal commands, as Stop Terminal does", async () => {
    const terminal = {
      message: { id: "a1", role: "assistant", content: "" },
      contextItems: [],
      toolCallStates: [
        {
          toolCallId: "t1",
          status: "calling",
          parsedArgs: {},
          toolCall: {
            id: "t1",
            type: "function",
            function: {
              name: BuiltInToolNames.RunTerminalCommand,
              arguments: "{}",
            },
          },
        },
      ],
    } as unknown as ChatHistoryItem;
    const store = storeWith({ history: [user(), terminal] });
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    expect(await store.dispatch(stopResponseThunk() as any).unwrap()).toBe(
      true,
    );
    expect(request).toHaveBeenCalledWith("process/killTerminalProcess", {
      toolCallId: "t1",
    });
    expect(calls).toEqual([]);
  });

  it("answers false when nothing runs", async () => {
    const store = storeWith({});
    expect(await store.dispatch(stopResponseThunk() as any).unwrap()).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });
});

describe("palette Resume Response", () => {
  it("resumes a stopped turn", async () => {
    const store = storeWith({ history: [user("stopped")] });
    expect(await store.dispatch(resumeResponseThunk() as any).unwrap()).toBe(
      true,
    );
    expect(calls).toEqual(["resumeTurn"]);
  });

  it("does nothing while streaming or when no turn was cut off", async () => {
    for (const session of [
      { history: [user("stopped")], isStreaming: true },
      { history: [user()] },
    ]) {
      const store = storeWith(session);
      expect(await store.dispatch(resumeResponseThunk() as any).unwrap()).toBe(
        false,
      );
    }
    expect(calls).toEqual([]);
  });
});

describe("palette Start Loop and Stop Loop", () => {
  it("resumes a stopped loop that can go on, as the strip's Resume does", async () => {
    const store = storeWith({
      loop: loop({ status: "stopped", stopReason: "left_loop" } as any),
    });
    expect(
      await store.dispatch(startLoopFromPaletteThunk() as any).unwrap(),
    ).toBe("resumed");
    expect(calls).toEqual(["resumeLoopThunk"]);
  });

  it("otherwise picks Loop, as the mode picker does", async () => {
    for (const session of [
      {},
      { loop: loop({ status: "stopped", stopReason: "done" } as any) },
    ]) {
      calls.length = 0;
      const store = storeWith(session);
      expect(
        await store.dispatch(startLoopFromPaletteThunk() as any).unwrap(),
      ).toBe("chosen");
      expect(calls).toEqual(["chooseLoopMode"]);
    }
  });

  it("leaves a running loop alone", async () => {
    const store = storeWith({ loop: loop({}) });
    expect(
      await store.dispatch(startLoopFromPaletteThunk() as any).unwrap(),
    ).toBe("running");
    expect(calls).toEqual([]);
  });

  it("stops a running loop, and not one already stopping or stopped", async () => {
    const running = storeWith({ loop: loop({}) });
    expect(
      await running.dispatch(stopLoopFromPaletteThunk() as any).unwrap(),
    ).toBe(true);
    expect(calls).toEqual(["stopLoopThunk"]);

    calls.length = 0;
    for (const l of [
      loop({ stopRequested: true } as any),
      loop({ status: "stopped" } as any),
      undefined,
    ]) {
      const store = storeWith({ loop: l });
      expect(
        await store.dispatch(stopLoopFromPaletteThunk() as any).unwrap(),
      ).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});
