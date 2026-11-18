import type { ChatHistoryItem, ToolCallState } from "core";
import { describe, expect, it } from "vitest";
import { findResumableTurn, markTurnCutOffOnLoad } from "./resumeTurn";

const user: ChatHistoryItem = {
  message: { role: "user", content: "Fix it" },
  contextItems: [],
  editorState: { type: "doc" },
};

function call(id: string, status: ToolCallState["status"]): ToolCallState {
  const toolCall = {
    id,
    type: "function" as const,
    function: { name: "run_terminal_command", arguments: "{}" },
  };
  return { toolCallId: id, status, parsedArgs: {}, toolCall };
}

function assistantWithCalls(
  states: ToolCallState[],
  interrupted?: ChatHistoryItem["interrupted"],
): ChatHistoryItem {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: states.map((s) => s.toolCall),
    },
    contextItems: [],
    toolCallStates: states,
    interrupted,
  };
}

describe("findResumableTurn", () => {
  it("offers nothing for a turn that was not interrupted", () => {
    expect(
      findResumableTurn([
        user,
        { message: { role: "assistant", content: "Done." }, contextItems: [] },
      ]),
    ).toBeUndefined();
  });

  it("continues a turn whose tool call ran, without running it again", () => {
    expect(
      findResumableTurn([
        user,
        assistantWithCalls([call("c1", "done")], "stopped"),
      ]),
    ).toEqual({ kind: "continue", userIndex: 0, cancelledToolCall: false });
  });

  it("notes a tool call stopped before it ran, so the model asks for it again", () => {
    expect(
      findResumableTurn([
        user,
        assistantWithCalls(
          [call("c1", "done"), call("c2", "canceled")],
          "stopped",
        ),
      ]),
    ).toEqual({ kind: "continue", userIndex: 0, cancelledToolCall: true });
  });

  it("sends the message again when the turn has no answer", () => {
    expect(
      findResumableTurn([
        user,
        { message: { role: "assistant", content: "" }, contextItems: [] },
        {
          message: { role: "thinking", content: "Hmm" },
          contextItems: [],
          interrupted: "failed",
        },
      ]),
    ).toEqual({ kind: "regenerate", userIndex: 0 });
  });
});

describe("markTurnCutOffOnLoad", () => {
  it("marks a turn whose tool call was still running", () => {
    const history = [user, assistantWithCalls([call("c1", "calling")])];
    markTurnCutOffOnLoad(history);
    expect(history[1].interrupted).toBe("reloaded");
  });

  it("marks a turn whose finished tool results the model never read", () => {
    const history = [user, assistantWithCalls([call("c1", "done")])];
    markTurnCutOffOnLoad(history);
    expect(history[1].interrupted).toBe("reloaded");
  });

  it("leaves a call waiting for approval alone", () => {
    const history = [user, assistantWithCalls([call("c1", "generated")])];
    markTurnCutOffOnLoad(history);
    expect(history[1].interrupted).toBeUndefined();
  });

  it("keeps the reason a turn was already marked with", () => {
    const history = [user, assistantWithCalls([call("c1", "done")], "failed")];
    markTurnCutOffOnLoad(history);
    expect(history[1].interrupted).toBe("failed");
  });
});
