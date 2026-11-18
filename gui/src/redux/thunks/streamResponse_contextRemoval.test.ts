import { JSONContent } from "@tiptap/core";
import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));
vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "next",
      legacyCommandWithInput: undefined,
    })),
  }),
);

const claude: ModelDescription = {
  title: "Claude Sonnet",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};

const editorState: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "next" }] }],
};

const call = {
  id: "c1",
  type: "function" as const,
  function: {
    name: "read_file",
    arguments: JSON.stringify({ filepath: "big.ts" }),
  },
};

/** A request sent after "Choose what to keep" (core/util/contextRemoval.ts). */
describe("sending after Choose what to keep", () => {
  it("sends the stub with the same tool call id, and ends the free undo", async () => {
    const state = getEmptyRootState();
    state.session.id = "s1";
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "read big.ts" },
        contextItems: [],
      },
      {
        message: {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [call],
        },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "c1",
            toolCall: call,
            status: "done",
            parsedArgs: { filepath: "big.ts" },
            output: [
              {
                name: "big.ts",
                description: "big.ts",
                content: "B".repeat(8000),
              },
            ],
          },
        ],
        removedByUser: { toolResults: ["c1"] },
      },
    ];
    state.session.contextRemovalUndo = {
      previous: { a1: null },
      removedTokens: 2000,
    };
    state.config.config = {
      ...state.config.config,
      selectedModelByRole: {
        ...state.config.config.selectedModelByRole,
        chat: claude,
      },
    };
    const store = createMockStore(state);
    const compiled: any[] = [];
    store.mockIdeMessenger.responseHandlers["llm/compileChat"] = (async (
      data: any,
    ) => {
      compiled.push(data);
      return {
        compiledChatMessages: data.messages,
        didPrune: false,
        contextPercentage: 0.1,
      };
    }) as any;
    store.mockIdeMessenger.llmStreamChat = vi.fn(async function* () {}) as any;

    await store.dispatch(
      streamResponseThunk({
        editorState,
        modifiers: { useCodebase: false, noContext: true },
      }) as any,
    );

    const messages = compiled[0].messages;
    const tool = messages.find((m: any) => m.role === "tool");
    expect(tool).toMatchObject({
      toolCallId: "c1",
      content: "[output removed by you: 2.0k tokens, Read big.ts]",
    });
    expect(JSON.stringify(messages)).not.toContain("B".repeat(100));
    const after = store.getState() as RootState;
    expect(after.session.contextRemovalUndo).toBeUndefined();
    // The original stays in the session
    expect(after.session.history[1].toolCallStates![0].output![0].content).toBe(
      "B".repeat(8000),
    );
  });
});
