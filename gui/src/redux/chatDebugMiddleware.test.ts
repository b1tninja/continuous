import { afterEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { errorToolCall, newSession, setInactive } from "./slices/sessionSlice";
import { setupStore } from "./store";
import {
  getChatDebugEvents,
  resetChatDebugForTests,
} from "../util/chatDebugLog";

afterEach(() => {
  resetChatDebugForTests();
});

describe("chatDebugMiddleware", () => {
  it("records an empty stream stop and a tool failure from the actions", () => {
    const store = setupStore({ ideMessenger: new MockIdeMessenger() });
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "assistant", id: "a", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                toolCallId: "tc1",
                status: "generated",
                toolCall: {
                  id: "tc1",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              },
            ],
          },
        ],
      } as any),
    );
    store.dispatch(
      errorToolCall({
        toolCallId: "tc1",
        output: [
          {
            name: "Error",
            description: "disk full",
            content: "disk full",
          },
        ],
      }),
    );
    store.dispatch(
      newSession({
        sessionId: "s2",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "user", id: "u", content: "hi" },
            contextItems: [],
          },
          {
            message: { role: "assistant", id: "a2", content: "" },
            contextItems: [],
          },
        ],
      } as any),
    );
    store.dispatch(setInactive());

    expect(getChatDebugEvents().map((event) => event.kind)).toEqual([
      "tool-error",
      "stream-empty",
    ]);
    expect(getChatDebugEvents()[0].summary).toContain("read_file");
    expect(getChatDebugEvents()[0].summary).toContain("disk full");
  });
});
