import { ChatHistoryItem, ToolCallState } from "core";
import { CANCELLED_TOOL_CALL_MESSAGE } from "core/tools/constants";
import { describe, expect, it } from "vitest";
import {
  constructMessages,
  withoutIncompleteToolCalls,
} from "./constructMessages";

function call(id: string, name: string, args = "{}") {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

function state(
  id: string,
  name: string,
  status: ToolCallState["status"] = "done",
): ToolCallState {
  return {
    toolCallId: id,
    toolCall: call(id, name),
    status,
    parsedArgs: {},
    output: [{ name: "out", description: "", content: `output of ${id}` }],
  };
}

const user = (text: string): ChatHistoryItem => ({
  message: { role: "user", content: text },
  contextItems: [],
});

function assistant(
  calls: ReturnType<typeof call>[],
  states: ToolCallState[],
  content = "",
): ChatHistoryItem {
  return {
    message: { role: "assistant", content, toolCalls: calls },
    contextItems: [],
    toolCallStates: states,
  };
}

describe("withoutIncompleteToolCalls", () => {
  it("returns the same item when every call is complete", () => {
    const item = assistant([call("a", "read_file")], [state("a", "read_file")]);
    expect(withoutIncompleteToolCalls(item)).toBe(item);
  });

  it("drops a call with no id, and its state", () => {
    const item = assistant(
      [call("", "multi_edit"), call("b", "multi_edit")],
      [state("", "multi_edit", "errored"), state("b", "multi_edit")],
    );
    const out = withoutIncompleteToolCalls(item);
    expect(
      out.message.role === "assistant" &&
        out.message.toolCalls?.map((c) => c.id),
    ).toEqual(["b"]);
    expect(out.toolCallStates?.map((s) => s.toolCallId)).toEqual(["b"]);
  });

  it("drops a call with no name", () => {
    const item = assistant(
      [call("a", ""), call("b", "ls")],
      [state("a", ""), state("b", "ls")],
    );
    expect(
      withoutIncompleteToolCalls(item).toolCallStates?.map((s) => s.toolCallId),
    ).toEqual(["b"]);
  });

  it("leaves no empty toolCalls list when every call was incomplete", () => {
    const out = withoutIncompleteToolCalls(
      assistant([call("", "")], [state("", "", "canceled")]),
    );
    expect(out.message.role === "assistant" && out.message.toolCalls).toBe(
      undefined,
    );
    expect(out.toolCallStates).toEqual([]);
  });

  it("leaves a user message alone", () => {
    const item = user("hi");
    expect(withoutIncompleteToolCalls(item)).toBe(item);
  });

  it("does not change the original item", () => {
    const item = assistant(
      [call("", "x"), call("b", "x")],
      [state("", "x"), state("b", "x")],
    );
    const before = structuredClone(item);
    withoutIncompleteToolCalls(item);
    expect(item).toEqual(before);
  });
});

describe("constructMessages with a turn cut off mid-call", () => {
  // The shape of the session Bedrock refused on resume: a parallel call left
  // without an id next to a real call, and a turn holding only such a call.
  const history: ChatHistoryItem[] = [
    user("edit the file"),
    assistant(
      [call("", ""), call("tooluse_b", "multi_edit")],
      [state("", "", "errored"), state("tooluse_b", "multi_edit", "errored")],
      "That edit was too large.",
    ),
    {
      message: { role: "tool", content: "x", toolCallId: "" },
      contextItems: [],
    },
    assistant([call("", "")], [state("", "", "canceled")]),
    user("try again"),
  ];

  const { messages } = constructMessages(history, undefined, [], {});

  it("sends no tool call and no tool result without an id", () => {
    for (const m of messages) {
      if (m.role === "assistant") {
        for (const c of m.toolCalls ?? []) expect(c.id).toBeTruthy();
      }
      if (m.role === "tool") expect(m.toolCallId).toBeTruthy();
    }
  });

  it("keeps the complete call and answers it right after", () => {
    const i = messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        m.toolCalls?.some((c) => c.id === "tooluse_b"),
    );
    expect(i).toBeGreaterThan(-1);
    expect(messages[i + 1]).toMatchObject({
      role: "tool",
      toolCallId: "tooluse_b",
    });
  });

  it("drops a turn that held only an incomplete call", () => {
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
  });

  it("still answers a canceled complete call with the cancelled text", () => {
    const { messages: out } = constructMessages(
      [
        user("go"),
        assistant(
          [call("c", "ls")],
          [{ ...state("c", "ls", "canceled"), output: undefined }],
        ),
        user("next"),
      ],
      undefined,
      [],
      {},
    );
    expect(out.find((m) => m.role === "tool")).toMatchObject({
      toolCallId: "c",
      content: CANCELLED_TOOL_CALL_MESSAGE,
    });
  });
});
