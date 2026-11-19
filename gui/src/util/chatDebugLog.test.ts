import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_DEBUG_LIMIT,
  clearChatDebug,
  getChatDebugEvents,
  noteAgentCut,
  noteChatDebug,
  noteCompiledRequest,
  noteCompileFailure,
  noteContextWindow,
  noteProviderFailure,
  noteRequestSent,
  noteStreamCancelled,
  noteStreamStop,
  noteToolFailure,
  noteTurnEnded,
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
    expect(getChatDebugEvents()[0].summary).toContain(
      "Stopped with no reply and no tool call",
    );
    expect(getChatDebugEvents()[0].summary).toContain("stop=not reported");
  });

  it("notes a turn whose only text was reasoning", () => {
    noteStreamStop([
      { message: { role: "user", content: "hi" } },
      { message: { role: "thinking", content: "The last word is Goodbye." } },
    ]);
    const summary = getChatDebugEvents()[0].summary;
    expect(summary).toContain("The only text was reasoning");
    expect(summary).toContain("tool calls=0");
  });

  it("names the cap and window when a reply ends the agent", () => {
    noteRequestSent({
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      maxTokens: 128000,
      contextLength: 100000,
      outputTokensAvailable: 89000,
    });
    noteTurnEnded({
      history: [
        { message: { role: "user", content: "implement the ledger" } },
        { message: { role: "assistant", content: "Here is the first step." } },
      ],
      stopReason: "end_turn",
      promptTokens: 842,
      completionTokens: 40,
      why: "no-tool-call",
    });
    const summary = getChatDebugEvents()[0].summary;
    expect(getChatDebugEvents()[0].kind).toBe("turn");
    expect(summary).toContain("did not continue");
    expect(summary).toContain("stop=end_turn");
    expect(summary).toContain("maxTokens=128000");
    expect(summary).toContain("context=100000");
    expect(summary).toContain("model=claude-sonnet-5-5");
    expect(summary).toContain("promptTokens=842");
    expect(summary).toContain("room=89000");
  });

  it("shows the cap that will be sent when the config asked for more", () => {
    noteRequestSent({
      model: "claude-haiku-4-5",
      provider: "bedrock",
      maxTokens: 64000,
      askedMaxTokens: 128000,
      ceiling: 64000,
      contextLength: 200000,
      promptEstimate: 1200,
    });
    noteTurnEnded({
      history: [
        { message: { role: "user", content: "hi" } },
        { message: { role: "assistant", content: "done" } },
      ],
      stopReason: "end_turn",
      why: "no-tool-call",
    });
    const summary = getChatDebugEvents()[0].summary;
    expect(summary).toContain("maxTokens=64000, asked=128000");
    expect(summary).toContain("promptEstimate=1200");
    expect(summary).not.toContain("ceiling=");
  });

  it("says when the output cap was over the model limit", () => {
    noteRequestSent({
      model: "claude-sonnet-4-5",
      provider: "bedrock",
      maxTokens: 128000,
      contextLength: 200000,
    });
    noteProviderFailure(
      "The maximum tokens you requested exceeds the model limit of 64000",
    );
    const summary = getChatDebugEvents()[0].summary;
    expect(summary).toContain("Output cap refused");
    expect(summary).toContain("64000");
    expect(summary).toContain("maxTokens=128000");
  });

  it("does not log an empty stop again after the turn was already recorded", () => {
    noteTurnEnded({
      history: [
        { message: { role: "user", content: "hi" } },
        { message: { role: "assistant", content: "" } },
      ],
      stopReason: "end_turn",
      why: "no-tool-call",
    });
    noteStreamStop([
      { message: { role: "user", content: "hi" } },
      { message: { role: "assistant", content: "" } },
    ]);
    expect(getChatDebugEvents()).toHaveLength(1);
  });

  it("does not add a second line when the turn was just recorded", () => {
    noteStreamCancelled("steer");
    noteAgentCut("The reply was cut off before it finished.");
    expect(getChatDebugEvents().map((event) => event.summary)).toEqual([
      "Interrupted to steer. The reply was cut off so a queued message could be sent.",
    ]);
  });

  it("records a cut that nothing else explained", () => {
    noteAgentCut(
      "Compaction was aborted before the next request, so the agent did not continue.",
    );
    expect(getChatDebugEvents()[0].summary).toContain(
      "Compaction was aborted",
    );
  });

  it("records a stop by the person and skips the empty-stream note", () => {
    noteStreamCancelled("stopped");
    noteStreamStop([
      { message: { role: "user", content: "hi" } },
      { message: { role: "thinking", content: "still thinking" } },
    ]);
    expect(getChatDebugEvents().map((event) => event.summary)).toEqual([
      "Stopped by you.",
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
