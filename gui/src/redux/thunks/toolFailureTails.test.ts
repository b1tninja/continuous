import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ContinueErrorReason } from "core/util/errors";
import { describe, expect, it } from "vitest";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { AppThunkDispatch, RootState } from "../store";
import { callToolById } from "./callToolById";
import { preprocessToolCalls } from "./preprocessToolCallArgs";

/**
 * A failed call's result is the failure, with no "Please try something else
 * or request further instructions" after it (AG6): the tail named no next
 * step, and 103 of 302 sampled refusals were followed by the same again.
 */
const GENERIC_TAIL = /try something else|request further instructions|please/i;

function readCall(): ToolCallState {
  return {
    toolCallId: "read-1",
    toolCall: {
      id: "read-1",
      type: "function",
      function: {
        name: BuiltInToolNames.ReadFile,
        arguments: '{"filepath":"nope.ts"}',
      },
    },
    status: "generated",
    parsedArgs: { filepath: "nope.ts" },
  };
}

describe("a call that fails its argument checks", () => {
  it("says the call did not run and why, and nothing after", async () => {
    const actions: { type: string; payload: any }[] = [];
    const dispatch = ((action: { type: string; payload: any }) => {
      actions.push(action);
      return action;
    }) as unknown as AppThunkDispatch;
    const ideMessenger = {
      request: async () => ({
        status: "success",
        content: {
          errorReason: ContinueErrorReason.FileNotFound,
          errorMessage: 'File "nope.ts" does not exist',
        },
      }),
    } as unknown as IIdeMessenger;
    await preprocessToolCalls(dispatch, ideMessenger, [readCall()]);
    const content = actions.find((a) => a.type.endsWith("updateToolCallOutput"))
      ?.payload.contextItems[0].content;
    expect(content).toBe(
      'read_file did not run: File "nope.ts" does not exist',
    );
    expect(content).not.toMatch(GENERIC_TAIL);
    // A missing file is not "invalid arguments"
    expect(content).not.toMatch(/arguments were invalid/);
  });
});

describe("a tool that fails when it runs", () => {
  it("gives the tool's message and nothing after", async () => {
    const state = getEmptyRootState();
    state.config.config.selectedModelByRole.chat = {
      title: "Test model",
      model: "test-model",
      provider: "anthropic",
      underlyingProviderName: "anthropic",
    };
    state.session.isStreaming = true;
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "Read" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [readCall()],
      },
    ];
    // Stop: the result is recorded and no request follows it
    state.session.streamAborter.abort();
    const store = createMockStore(state);
    store.mockIdeMessenger.responses["tools/call"] = {
      contextItems: [],
      errorMessage: "EACCES: the file cannot be opened",
    };

    await store.dispatch(callToolById({ toolCallId: "read-1" }) as any);

    const call = (store.getState() as RootState).session.history[1]
      .toolCallStates![0];
    expect(call.status).toBe("errored");
    expect(call.output?.[0].content).toBe(
      "read_file failed with the message: EACCES: the file cannot be opened",
    );
    expect(call.output?.[0].content).not.toMatch(GENERIC_TAIL);
  });
});
