import type { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import { clearDanglingMessages, sessionSlice } from "./sessionSlice";

const reducer = sessionSlice.reducer;
type SessionState = ReturnType<typeof reducer>;

/**
 * The shape of the session that lost a prompt: a user message, the empty
 * assistant placeholder the stream opens, and a thought that stopped after 28
 * characters. The turn is then ended by "Steer now" (interruptStream) or by Stop
 * (cancelStream).
 */
function stateWith(history: ChatHistoryItem[]): SessionState {
  const initial = reducer(undefined, { type: "init" });
  return {
    ...initial,
    history: history.map((item, i) => ({
      ...item,
      message: { ...item.message, id: `m${i}` },
    })),
  } as SessionState;
}

const earlier: ChatHistoryItem = {
  message: { role: "assistant", content: "Done with the last task." },
  contextItems: [],
};
const user: ChatHistoryItem = {
  message: {
    role: "user",
    content: "check our own usage and session history",
  },
  contextItems: [],
  editorState: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "check our own usage" }],
      },
    ],
  },
};
const placeholder: ChatHistoryItem = {
  message: { role: "assistant", content: "" },
  contextItems: [],
};
const shortThought: ChatHistoryItem = {
  message: { role: "thinking", content: "This new request shifts dire" },
  contextItems: [],
  reasoning: {
    active: true,
    text: "This new request shifts dire",
    startAt: 1,
  },
};
const noThought: ChatHistoryItem = {
  message: { role: "thinking", content: "" },
  contextItems: [],
  reasoning: { active: true, text: "", startAt: 1 },
};

const roles = (s: SessionState) => s.history.map((h) => h.message.role);
const hasPrompt = (s: SessionState) =>
  s.history.some(
    (h) =>
      h.message.role === "user" &&
      String(h.message.content).includes("check our own usage"),
  );

describe("ending a turn that has only started to think", () => {
  it("Stop keeps the user's message and the partial thought, marked", () => {
    const state = reducer(
      stateWith([earlier, user, placeholder, shortThought]),
      clearDanglingMessages("stopped"),
    );
    expect(hasPrompt(state)).toBe(true);
    expect(roles(state)).toEqual([
      "assistant",
      "user",
      "assistant",
      "thinking",
    ]);
    expect(state.history[3].interrupted).toBe("stopped");
  });

  it("Steer now keeps the user's message and the thought", () => {
    // interruptStream passes "steered". The message the person sent must not
    // be taken out of the history, or the model never sees the request that
    // was in flight, and the next message is sent over the top of it.
    const state = reducer(
      stateWith([earlier, user, placeholder, shortThought]),
      clearDanglingMessages("steered"),
    );
    expect(hasPrompt(state)).toBe(true);
    expect(roles(state)).toEqual([
      "assistant",
      "user",
      "assistant",
      "thinking",
    ]);
  });

  it("Steer now marks nothing for Resume and ends the thought", () => {
    const state = reducer(
      stateWith([earlier, user, placeholder, shortThought]),
      clearDanglingMessages("steered"),
    );
    expect(state.history[3].interrupted).toBeUndefined();
    expect(state.history[3].reasoning?.active).toBe(false);
  });

  it("Steer now does not hand the message back to the input box", () => {
    const state = reducer(
      stateWith([earlier, user, placeholder, shortThought]),
      clearDanglingMessages("steered"),
    );
    expect(state.mainEditorContentTrigger).toBeUndefined();
  });

  it("Steer now before the model wrote anything keeps the message too", () => {
    const state = reducer(
      stateWith([earlier, user, placeholder]),
      clearDanglingMessages("steered"),
    );
    expect(hasPrompt(state)).toBe(true);
    expect(state.mainEditorContentTrigger).toBeUndefined();
  });

  it("Steer now with an empty thought keeps the message", () => {
    const state = reducer(
      stateWith([earlier, user, placeholder, noThought]),
      clearDanglingMessages("steered"),
    );
    expect(hasPrompt(state)).toBe(true);
    expect(state.mainEditorContentTrigger).toBeUndefined();
  });

  it("a retry (no marker) still drops the message so it can be sent again", () => {
    // The opposite of a steer, and why they cannot share a meaning: a retry
    // restarts the turn, so the message goes and is sent afresh.
    const state = reducer(
      stateWith([user, placeholder, shortThought]),
      clearDanglingMessages(undefined),
    );
    expect(state.history).toEqual([]);
  });

  it("a steer after a finished tool result keeps the tool result", () => {
    const tool: ChatHistoryItem = {
      message: { role: "tool", content: "ok", toolCallId: "t1" },
      contextItems: [],
    };
    const state = reducer(
      stateWith([earlier, tool, placeholder, shortThought]),
      clearDanglingMessages("steered"),
    );
    expect(roles(state)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "thinking",
    ]);
  });

  it("Stop before the model wrote anything still puts the message back in the input box", () => {
    // The existing, intended behaviour: nothing was answered, so the message
    // is given back to be edited and sent again.
    const state = reducer(
      stateWith([earlier, user, placeholder]),
      clearDanglingMessages("stopped"),
    );
    expect(roles(state)).toEqual(["assistant"]);
    expect(state.mainEditorContentTrigger).toBeDefined();
  });

  it("an empty thought is not worth keeping, and Stop gives the message back", () => {
    const state = reducer(
      stateWith([earlier, user, placeholder, noThought]),
      clearDanglingMessages("stopped"),
    );
    expect(hasPrompt(state)).toBe(false);
    expect(state.mainEditorContentTrigger).toBeDefined();
  });
});
