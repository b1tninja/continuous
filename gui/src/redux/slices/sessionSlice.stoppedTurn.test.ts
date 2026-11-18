import type { ChatHistoryItem, Session } from "core";
import { describe, expect, it } from "vitest";
import { constructMessages } from "../util/constructMessages";
import {
  clearDanglingMessages,
  newSession,
  sessionSlice,
} from "./sessionSlice";

const reducer = sessionSlice.reducer;
type SessionState = ReturnType<typeof reducer>;

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

const user: ChatHistoryItem = {
  message: { role: "user", content: "Explain the build" },
  contextItems: [],
  editorState: { type: "doc", content: [] },
};
const placeholder: ChatHistoryItem = {
  message: { role: "assistant", content: "" },
  contextItems: [],
};
const thinking: ChatHistoryItem = {
  message: { role: "thinking", content: "Let me look at the config" },
  contextItems: [],
  reasoning: { active: true, text: "Let me look at the config", startAt: 1 },
};

function sentRoles(history: ChatHistoryItem[]) {
  const next: ChatHistoryItem = {
    message: { role: "user", content: "Go on" },
    contextItems: [],
  };
  return constructMessages([...history, next], "system", [], {}).messages.map(
    (m) => m.role,
  );
}

describe("clearDanglingMessages after Stop or a failure", () => {
  it("Stop during reasoning keeps the reasoning on screen, marked, and never sends it", () => {
    const state = reducer(
      stateWith([user, placeholder, thinking]),
      clearDanglingMessages("stopped"),
    );

    expect(state.history.map((h) => h.message.role)).toEqual([
      "user",
      "assistant",
      "thinking",
    ]);
    const last = state.history.at(-1)!;
    expect(last.interrupted).toBe("stopped");
    expect(last.reasoning?.active).toBe(false);
    expect(state.mainEditorContentTrigger).toBeUndefined();
    // No reasoning-only assistant turn reaches the provider
    expect(sentRoles(state.history)).toEqual(["system", "user", "user"]);
  });

  it("Stop before any text drops the empty turn and puts the prompt back", () => {
    const state = reducer(
      stateWith([user, placeholder]),
      clearDanglingMessages("stopped"),
    );

    expect(state.history).toEqual([]);
    expect(state.mainEditorContentTrigger).toEqual(user.editorState);
  });

  it("keeps a stopped turn's partial text and marks it", () => {
    const state = reducer(
      stateWith([
        user,
        placeholder,
        { ...thinking, reasoning: undefined },
        {
          message: { role: "assistant", content: "The build runs" },
          contextItems: [],
        },
      ]),
      clearDanglingMessages("stopped"),
    );

    expect(state.history.at(-1)?.message.content).toBe("The build runs");
    expect(state.history.at(-1)?.interrupted).toBe("stopped");
    expect(sentRoles(state.history)).toEqual([
      "system",
      "user",
      "thinking",
      "assistant",
      "user",
    ]);
  });

  it("an error mid-tool-call cancels the unfinished call and marks the turn failed", () => {
    const state = reducer(
      stateWith([
        user,
        {
          message: {
            role: "assistant",
            content: "I'll read it",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"filepa' },
              },
            ],
          },
          contextItems: [],
          toolCallStates: [
            {
              toolCallId: "call-1",
              status: "generating",
              parsedArgs: {},
              toolCall: {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"filepa' },
              },
            },
          ],
        },
      ]),
      clearDanglingMessages("failed"),
    );

    const last = state.history.at(-1)!;
    expect(last.interrupted).toBe("failed");
    expect(last.toolCallStates?.[0].status).toBe("canceled");
  });

  it("a retry (no reason) leaves nothing marked and drops orphan reasoning", () => {
    const state = reducer(
      stateWith([user, placeholder, thinking]),
      clearDanglingMessages(undefined),
    );
    expect(state.history).toEqual([]);
  });
});

describe("loading a session cut off by a reload", () => {
  function load(history: ChatHistoryItem[]) {
    const session = {
      sessionId: "s1",
      title: "t",
      workspaceDirectory: "",
      history,
    } as Session;
    return reducer(stateWith([]), newSession(session));
  }

  it("marks a turn that was still reasoning", () => {
    const state = load([user, placeholder, thinking]);
    expect(state.history.at(-1)?.interrupted).toBe("reloaded");
    expect(state.history.at(-1)?.reasoning?.active).toBe(false);
  });

  it("does not mark a finished turn", () => {
    const state = load([
      user,
      {
        message: { role: "assistant", content: "Done." },
        contextItems: [],
      },
    ]);
    expect(state.history.at(-1)?.interrupted).toBeUndefined();
  });
});
