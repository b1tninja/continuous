import { ToolCallState } from "core";
import { describe, expect, it } from "vitest";
import { AppThunkDispatch } from "../store";
import { refuseTruncatedToolCalls } from "./preprocessToolCallArgs";

function call(id: string, args: string): ToolCallState {
  return {
    toolCallId: id,
    toolCall: {
      id,
      type: "function",
      function: { name: "multi_edit", arguments: args },
    },
    status: "generated",
    parsedArgs: {},
  };
}

/** The actions refuseTruncatedToolCalls dispatched, by type. */
function run(calls: ToolCallState[], stopReason?: string) {
  const actions: { type: string; payload: any }[] = [];
  const dispatch = ((action: { type: string; payload: any }) => {
    actions.push(action);
    return action;
  }) as unknown as AppThunkDispatch;
  refuseTruncatedToolCalls(dispatch, calls, 128000, stopReason);
  const outputs = actions
    .filter((a) => a.type.endsWith("updateToolCallOutput"))
    .map((a) => a.payload.contextItems[0]);
  const errored = actions
    .filter((a) => a.type.endsWith("errorToolCall"))
    .map((a) => a.payload.toolCallId);
  return { outputs, errored };
}

const PARTIAL = '{"edits": [{"old_string": "a", "new_string": "b';
const COMPLETE = '{"edits": [{"old_string": "a", "new_string": "b"}]}';

describe("refuseTruncatedToolCalls", () => {
  it("says cut off when the reply hit its output limit", () => {
    const { outputs, errored } = run([call("a", PARTIAL)], "max_tokens");
    expect(errored).toEqual(["a"]);
    expect(outputs[0].name).toBe("Cut off");
    expect(outputs[0].content).toContain("output limit of 128000 tokens");
  });

  it("says cut off for OpenAI's length stop reason too", () => {
    expect(run([call("a", PARTIAL)], "length").outputs[0].name).toBe("Cut off");
  });

  // The false verdict: a 1,100-character edit whose fragments landed on
  // another call was refused as cut off at 128000 tokens
  it("says the arguments arrived incomplete when the reply ended normally", () => {
    for (const reason of ["tool_use", "tool_calls", "end_turn", "stop"]) {
      const { outputs } = run([call("a", PARTIAL)], reason);
      expect(outputs[0].name).toBe("Incomplete arguments");
      expect(outputs[0].content).toContain("not the output limit");
      expect(outputs[0].content).not.toContain("smaller pieces");
    }
  });

  it("keeps the cut-off message when no stop reason was reported", () => {
    expect(run([call("a", PARTIAL)]).outputs[0].name).toBe("Cut off");
  });

  it("leaves a call with complete arguments alone", () => {
    const { outputs, errored } = run([call("a", COMPLETE)], "tool_use");
    expect(outputs).toEqual([]);
    expect(errored).toEqual([]);
  });

  it("refuses only the incomplete call of a parallel set", () => {
    const { errored } = run(
      [call("a", COMPLETE), call("b", PARTIAL)],
      "tool_use",
    );
    expect(errored).toEqual(["b"]);
  });
});
