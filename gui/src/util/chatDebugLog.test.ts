import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_DEBUG_LIMIT,
  clearChatDebug,
  getChatDebugEvents,
  noteChatDebug,
  noteCompiledRequest,
  noteCompileFailure,
  noteContextWindow,
  noteProviderFailure,
  noteStreamStop,
  noteToolFailure,
  resetChatDebugForTests,
} from "./chatDebugLog";

afterEach(() => {
  resetChatDebugForTests();
});

describe("chatDebugLog", () => {
  it("keeps only the most recent events", () => {
    for (let i = 0; i < CHAT_DEBUG_LIMIT + 15; i++) {
      noteChatDebug("provider-error", `error ${i}`);
    }
    const events = getChatDebugEvents();
    expect(events).toHaveLength(CHAT_DEBUG_LIMIT);
    expect(events[0].summary).toBe(`error ${15}`);
    expect(events[events.length - 1].summary).toBe(
      `error ${CHAT_DEBUG_LIMIT + 14}`,
    );
  });

  it("drops a repeated note that arrives immediately", () => {
    noteChatDebug("stream-empty", "Stream stopped with no reply text");
    noteChatDebug("stream-empty", "Stream stopped with no reply text");
    expect(getChatDebugEvents()).toHaveLength(1);
  });

  it("clears", () => {
    noteChatDebug("tool-error", "read_file failed");
    clearChatDebug();
    expect(getChatDebugEvents()).toHaveLength(0);
  });

  it("notes a stream that stopped with no reply, and skips one that answered", () => {
    noteStreamStop([
      { message: { role: "user", content: "hi" } },
      { message: { role: "assistant", content: "" } },
    ]);
    noteStreamStop([
      { message: { role: "user", content: "hi" } },
      { message: { role: "assistant", content: "hello" } },
    ]);
    noteStreamStop([
      { message: { role: "user", content: "hi" } },
      {
        message: { role: "assistant", content: "" },
        toolCallStates: [{}],
      },
    ]);
    expect(getChatDebugEvents().map((event) => event.summary)).toEqual([
      "Stream stopped with no reply text",
    ]);
  });

  it("notes compile, prune, and prompt ageing separately from a provider refusal", () => {
    noteCompiledRequest({ didPrune: false, didAge: false });
    noteCompiledRequest({ didPrune: true, didAge: true });
    noteCompileFailure("tokenizer exploded");
    noteContextWindow("Compile refused the request: not enough context");
    noteProviderFailure("prompt is too long: 1067710 tokens > 1000000 maximum");
    noteProviderFailure("connection reset");
    noteToolFailure("read_file", "disk full");
    expect(getChatDebugEvents().map((event) => event.kind)).toEqual([
      "compile",
      "compile",
      "context-window",
      "context-window",
      "provider-error",
      "tool-error",
    ]);
    expect(getChatDebugEvents()[0].summary).toContain("pruned messages");
    expect(getChatDebugEvents()[0].summary).toContain("prompt");
    expect(getChatDebugEvents()[3].summary).toContain("1067710");
    expect(getChatDebugEvents()[4].summary).toContain("connection reset");
    expect(getChatDebugEvents()[5].summary).toContain("read_file");
    expect(getChatDebugEvents()[5].summary).toContain("disk full");
  });
});
