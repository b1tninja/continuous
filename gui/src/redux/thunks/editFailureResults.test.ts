import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ContinueErrorReason } from "core/util/errors";
import { describe, expect, it } from "vitest";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { AppThunkDispatch, RootState } from "../store";
import { constructMessages } from "../util/constructMessages";
import { callToolById } from "./callToolById";
import { preprocessToolCalls } from "./preprocessToolCallArgs";

/**
 * An edit that did not change the file says why, on each path the IDE can
 * fail it (AG3). The bare "Failed to edit <file>" named no cause.
 */

function editCall(
  name: string,
  parsedArgs: Record<string, unknown>,
  status: ToolCallState["status"] = "generated",
): ToolCallState {
  return {
    toolCallId: "edit-1",
    toolCall: {
      id: "edit-1",
      type: "function",
      function: { name, arguments: JSON.stringify(parsedArgs) },
    },
    status,
    parsedArgs,
  };
}

/** The result preprocessing writes when core answers with `content`. */
async function preprocessed(
  call: ToolCallState,
  content: Record<string, unknown>,
): Promise<string> {
  const actions: { type: string; payload: any }[] = [];
  const dispatch = ((action: { type: string; payload: any }) => {
    actions.push(action);
    return action;
  }) as unknown as AppThunkDispatch;
  const ideMessenger = {
    request: async () => ({ status: "success", content }),
  } as unknown as IIdeMessenger;
  await preprocessToolCalls(dispatch, ideMessenger, [call]);
  return actions.find((a) => a.type.endsWith("updateToolCallOutput"))?.payload
    .contextItems[0].content;
}

describe("an edit refused while its arguments are checked", () => {
  const args = { filepath: "src/a.ts", old_string: "x", new_string: "y" };

  it("names the old text that was not found", async () => {
    const text = await preprocessed(
      editCall(BuiltInToolNames.SingleFindAndReplace, args),
      {
        errorReason: ContinueErrorReason.FindAndReplaceOldStringNotFound,
        errorMessage: 'Edit at index 0: string not found in file: "x"',
      },
    );
    expect(text).toBe(
      'single_find_and_replace did not change src/a.ts: the old text was not found in the file.\nEdit at index 0: string not found in file: "x".\nsrc/a.ts is unchanged. Read src/a.ts again and retry with the exact current text. Do not rewrite the whole file.',
    );
  });

  it("names the old text that was found more than once", async () => {
    const text = await preprocessed(
      editCall(BuiltInToolNames.MultiEdit, {
        filepath: "src/a.ts",
        edits: [args],
      }),
      {
        errorReason: ContinueErrorReason.FindAndReplaceMultipleOccurrences,
        errorMessage:
          'Edit at index 0: String "x" appears 3 times in the file.',
      },
    );
    expect(text).toMatch(
      /^multi_edit did not change src\/a\.ts: the old text was found more than once\.\n/,
    );
    expect(text).toContain(
      "src/a.ts is unchanged: multi_edit writes all of its edits or none.",
    );
  });

  it("names the file that does not exist", async () => {
    const text = await preprocessed(
      editCall(BuiltInToolNames.SingleFindAndReplace, args),
      {
        errorReason: ContinueErrorReason.FileNotFound,
        errorMessage: "File src/a.ts does not exist",
      },
    );
    expect(text).toBe(
      "single_find_and_replace did not change src/a.ts: the file does not exist. Nothing was written. Check the path and retry with a file that exists.",
    );
  });
});

describe("an edit that fails when it runs", () => {
  // The file changed between the check and the run: old_string is gone
  it("names the cause the error carries", async () => {
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
        message: { id: "u1", role: "user", content: "Rename it" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "" },
        contextItems: [],
        toolCallStates: [
          editCall(BuiltInToolNames.SingleFindAndReplace, {
            filepath: "src/a.ts",
            old_string: "const gone = 1;",
            new_string: "const here = 1;",
          }),
        ],
      },
    ];
    // Stop: the result is recorded and no request follows it
    state.session.streamAborter.abort();
    const store = createMockStore(state);
    const messenger = store.mockIdeMessenger;
    messenger.responses.fileExists = true;
    messenger.responses.readFile = "const other = 2;\n";

    await store.dispatch(callToolById({ toolCallId: "edit-1" }) as any);

    const call = (store.getState() as RootState).session.history[1]
      .toolCallStates![0];
    expect(call.status).toBe("errored");
    const text = call.output![0].content;
    expect(text).toMatch(
      /^single_find_and_replace did not change src\/a\.ts: the old text was not found in the file\.\n/,
    );
    expect(text).toMatch(
      /src\/a\.ts is unchanged\. Read src\/a\.ts again and retry with the exact current text\. Do not rewrite the whole file\.$/,
    );
    expect(text).not.toMatch(/try something else/);
  });
});

describe("a cancelled edit", () => {
  it("tells the model the person rejected it and the file is unchanged", () => {
    const { messages } = constructMessages(
      [
        {
          message: { role: "user", content: "Rename it" },
          contextItems: [],
        },
        {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "edit-1",
                type: "function",
                function: {
                  name: BuiltInToolNames.EditExistingFile,
                  arguments: "{}",
                },
              },
            ],
          },
          contextItems: [],
          toolCallStates: [
            editCall(
              BuiltInToolNames.EditExistingFile,
              { filepath: "src/a.ts", changes: "x" },
              "canceled",
            ),
          ],
        },
      ],
      "System",
      [],
      {},
    );
    const result = messages.find((m) => m.role === "tool");
    expect(result?.content).toBe(
      "The person rejected this edit_existing_file edit of src/a.ts. src/a.ts is unchanged. Do not send the same edit again.",
    );
  });
});
