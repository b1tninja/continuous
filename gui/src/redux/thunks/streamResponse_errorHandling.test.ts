import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

// Mock external dependencies only - let selectors run naturally
// Removed: modelSupportsNativeTools - let it run naturally

// Removed: addSystemMessageToolsToSystemMessage - let it run naturally

// Mock system message construction to keep test readable
vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(),
}));

import { getBaseSystemMessage } from "../util/getBaseSystemMessage";

// Removed: shouldAutoEnableSystemMessageTools - let it run naturally

vi.mock("uuid", () => ({
  v4: vi.fn(() => "mock-uuid-123"),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(),
  }),
);

import { unwrapResult } from "@reduxjs/toolkit";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { getRootStateWithClaude } from "./streamResponse.test";

const mockGetBaseSystemMessage = vi.mocked(getBaseSystemMessage);

const mockResolveEditorContent = vi.mocked(resolveEditorContent);

// Mock editor state (what user types in the input)
const mockEditorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Hello, please help me with this code" }],
    },
  ],
};

// Mock input modifiers (codebase context, etc.)
const mockModifiers: InputModifiers = {
  useCodebase: true,
  noContext: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveEditorContent.mockResolvedValue({
    selectedContextItems: [],
    selectedCode: [],
    content: "Hello, please help me with this code",
    legacyCommandWithInput: undefined,
  });

  // Mock getBaseSystemMessage to return simple system message for readable tests
  mockGetBaseSystemMessage.mockReturnValue("You are a helpful assistant.");
});

/**
 * A failed turn is saved (streamThunkWrapper), which dispatches the save
 * thunks; the flow below is asserted without them, and the save is asserted
 * to have been made.
 */
const SAVE_ACTION =
  /^session\/(saveCurrent|update|refreshMetadata)\/|^session\/(updateSessionMetadata|setIsSessionMetadataLoading|setAllSessionMetadata)$/;
function savedAfterFailure(actions: any[]): any[] {
  expect(actions.map((a) => a.type)).toContain("session/saveCurrent/pending");
  return actions.filter((a) => !SAVE_ACTION.test(a.type));
}

describe("streamResponseThunk", () => {
  it("should throw error when no chat model is selected", async () => {
    const noModelState = getEmptyRootState();
    noModelState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];

    // Create store with no selected chat model
    const mockStoreNoModel = createMockStore(noModelState);
    const requestSpy = vi.spyOn(mockStoreNoModel.mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(
      mockStoreNoModel.mockIdeMessenger,
      "llmStreamChat",
    );

    // Execute thunk and expect it to be rejected
    const result = await mockStoreNoModel.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify the thunk completed successfully but shows error dialog
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify the complete error handling flow
    const dispatchedActions = savedAfterFailure(mockStoreNoModel.getActions());
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "chat/cancelStream/pending",
        meta: {
          arg: { loop: "error", detail: expect.any(String) },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "session/abortStream",
        payload: undefined,
      },
      {
        type: "session/clearDanglingMessages",
        payload: "failed",
      },
      {
        type: "chat/cancelStream/fulfilled",
        meta: {
          arg: { loop: "error", detail: expect.any(String) },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "ui/setDialogMessage",
        payload: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "No chat model selected",
            }),
          }),
        }),
      },
      {
        type: "ui/setShowDialog",
        payload: true,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
    ]);

    // Verify no IDE messenger calls were made
    // Nothing reached the model; only the failed turn was saved
    expect(requestSpy.mock.calls.map(([type]) => type)).toEqual([
      "history/save",
      "history/list",
    ]);
    expect(chatSpy).not.toHaveBeenCalled();

    // Verify final state shows error dialog and inactive streaming
    const finalState = mockStoreNoModel.getState();
    expect(finalState).toEqual({
      ...noModelState,
      session: {
        ...noModelState.session,
        // the failed turn was saved, which titles the session
        title: "Hello",
        streamAborter: expect.any(AbortController),
        history: [
          { ...noModelState.session.history[0], isGatheringContext: false },
        ],
      },
      ui: {
        ...noModelState.ui,
        showDialog: true, // Error dialog is shown
        dialogMessage: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "No chat model selected",
            }),
          }),
        }),
      },
    });
  });

  it("should handle compilation error - not enough context", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    initialState.session.id = "session-123";
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(mockIdeMessenger, "llmStreamChat");

    requestSpy.mockImplementation(async (message, data) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "error",
          error: "Not enough context available for this request",
        };
      } else {
        return await new MockIdeMessenger().request(message, data);
      }
    });

    // Execute thunk
    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );
    unwrapResult(result);

    // Verify thunk completed successfully (doesn't throw, handles error gracefully)
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify exact action sequence for this error path
    const dispatchedActions = mockStore.getActions();
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/submitEditorAndInitAtIndex",
        payload: {
          editorState: mockEditorState,
          index: 1,
        },
      },
      {
        type: "session/resetNextCodeBlockToApplyIndex",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/pending",
        meta: {
          arg: [],
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/updateHistoryItemAtIndex",
        payload: {
          index: 1,
          updates: {
            contextItems: [],
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        },
      },
      {
        type: "chat/streamNormalInput/pending",
        meta: {
          arg: {
            legacySlashCommandData: undefined,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setSentToolList",
        payload: expect.anything(),
      },
      {
        type: "session/setAppliedRulesAtIndex",
        payload: {
          appliedRules: [],
          index: 1,
        },
      },
      {
        type: "session/setActive",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: {
          kind: "out-of-context",
          detail: "Not enough context available for this request",
        },
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "session/dropTrailingEmptyAssistant",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/fulfilled",
        meta: {
          arg: [],
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamNormalInput/fulfilled",
        meta: {
          arg: {
            legacySlashCommandData: undefined,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "session/saveCurrent/pending",
        meta: {
          arg: {
            generateTitle: true,
            openNewSession: false,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/update/pending",
        meta: {
          arg: expect.objectContaining({
            history: expect.any(Array),
            sessionId: "session-123",
            title: "Hello",
            workspaceDirectory: "",
          }),
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/updateSessionMetadata",
        payload: {
          sessionId: "session-123",
          title: "Hello",
        },
      },
      {
        type: "session/refreshMetadata/pending",
        meta: {
          arg: {},
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setIsSessionMetadataLoading",
        payload: false,
      },
      {
        type: "session/setAllSessionMetadata",
        payload: [],
      },
      {
        type: "session/refreshMetadata/fulfilled",
        meta: {
          arg: expect.objectContaining({}),
          requestId: expect.any(String),
          requestStatus: expect.any(String),
        },
        payload: [],
      },
      {
        type: "session/update/fulfilled",
        meta: {
          arg: expect.objectContaining({
            history: expect.any(Array),
            sessionId: "session-123",
            title: "Hello",
            workspaceDirectory: "",
          }),
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "session/saveCurrent/fulfilled",
        meta: {
          arg: {
            generateTitle: true,
            openNewSession: false,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
    ]);

    // Verify IDE messenger was called for compilation but not streaming
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: [
            {
              text: "Hello",
              type: "text",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              text: "Hello, please help me with this code",
              type: "text",
            },
          ],
        },
      ],
      options: {},
    });
    expect(chatSpy).not.toHaveBeenCalled();

    // Verify final state shows error condition
    const finalState = mockStore.getState();
    expect(finalState).toEqual({
      ...initialState,
      session: {
        ...initialState.session,
        sentToolList: expect.anything(),
        title: "Hello",
        history: [
          {
            contextItems: [],
            message: {
              content: "Hello",
              id: "1",
              role: "user",
            },
          },
          {
            appliedRules: [],
            contextItems: [],
            editorState: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Hello, please help me with this code",
                    },
                  ],
                },
              ],
            },
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        ],
        streamAborter: expect.any(AbortController),
        inlineErrorMessage: {
          kind: "out-of-context",
          detail: "Not enough context available for this request",
        },
      },
    });
  });

  it("shows the prompt size and the window when the prompt still does not fit", async () => {
    const error =
      "Not enough context. This prompt does not fit the model's context window. The prompt is about 90000 tokens and the window is 32768 tokens. Change the context length in Models → Configure → Context & cost.";
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    const mockStore = createMockStore(initialState);
    const requestSpy = vi.spyOn(mockStore.mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(mockStore.mockIdeMessenger, "llmStreamChat");
    requestSpy.mockImplementation(async (message, data) => {
      if (message === "llm/compileChat") {
        return { done: true, status: "error", error };
      }
      return await new MockIdeMessenger().request(message, data);
    });

    unwrapResult(
      await mockStore.dispatch(
        streamResponseThunk({
          editorState: mockEditorState,
          modifiers: mockModifiers,
        }) as any,
      ),
    );

    const state = mockStore.getState() as RootState;
    const shown = state.session.inlineErrorMessage;
    expect(shown).toEqual({ kind: "out-of-context", detail: error });
    const detail = typeof shown === "object" ? shown.detail : "";
    expect(detail).toContain("90000");
    expect(detail).toContain("32768");
    expect(detail).toContain("Context & cost");
    expect(chatSpy).not.toHaveBeenCalled();
    expect(state.session.history.at(-1)?.message.role).toBe("user");
  });

  it("should throw error for other compilation errors", async () => {
    const initialState = getRootStateWithClaude();
    initialState.session.history = [
      {
        message: { id: "1", role: "user", content: "Hello" },
        contextItems: [],
      },
    ];
    const mockStore = createMockStore(initialState);
    const mockIdeMessenger = mockStore.mockIdeMessenger;
    const requestSpy = vi.spyOn(mockIdeMessenger, "request");
    const chatSpy = vi.spyOn(mockIdeMessenger, "llmStreamChat");

    // Mock compilation failure with generic error
    requestSpy.mockImplementation(async (message, data) => {
      if (message === "llm/compileChat") {
        return {
          done: true,
          status: "error",
          error: "Model configuration is invalid",
        };
      } else {
        return await mockIdeMessenger.request(message, data);
      }
    });

    // Execute thunk and expect it to be rejected
    const result = await mockStore.dispatch(
      streamResponseThunk({
        editorState: mockEditorState,
        modifiers: mockModifiers,
      }) as any,
    );

    // Verify thunk completed successfully but shows error dialog
    expect(result.type).toBe("chat/streamResponse/fulfilled");

    // Verify exact action sequence for compilation error with dialog
    const dispatchedActions = savedAfterFailure(mockStore.getActions());
    expect(dispatchedActions).toEqual([
      {
        type: "chat/streamResponse/pending",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "chat/streamWrapper/pending",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/submitEditorAndInitAtIndex",
        payload: {
          editorState: mockEditorState,
          index: 1,
        },
      },
      {
        type: "session/resetNextCodeBlockToApplyIndex",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/pending",
        meta: {
          arg: [],
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/updateHistoryItemAtIndex",
        payload: {
          index: 1,
          updates: {
            contextItems: [],
            message: {
              content: "Hello, please help me with this code",
              id: "mock-uuid-123",
              role: "user",
            },
          },
        },
      },
      {
        type: "chat/streamNormalInput/pending",
        meta: {
          arg: {
            legacySlashCommandData: undefined,
          },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setSentToolList",
        payload: expect.anything(),
      },
      {
        type: "session/setAppliedRulesAtIndex",
        payload: {
          appliedRules: [],
          index: 1,
        },
      },
      {
        type: "session/setActive",
        payload: undefined,
      },
      {
        type: "session/setInlineErrorMessage",
        payload: undefined,
      },
      {
        type: "symbols/updateFromContextItems/fulfilled",
        meta: {
          arg: [],
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamNormalInput/rejected",
        meta: {
          aborted: false,
          arg: {
            legacySlashCommandData: undefined,
          },
          condition: false,
          rejectedWithValue: false,
          requestId: expect.any(String),
          requestStatus: "rejected",
        },
        payload: undefined,
        error: {
          message: "Model configuration is invalid",
          name: "Error",
          stack: expect.any(String),
        },
      },
      {
        type: "session/recordRequestFailure",
        payload: expect.objectContaining({ kind: "other" }),
      },
      {
        type: "chat/cancelStream/pending",
        meta: {
          arg: { loop: "error", detail: expect.any(String) },
          requestId: expect.any(String),
          requestStatus: "pending",
        },
        payload: undefined,
      },
      {
        type: "session/setInactive",
        payload: undefined,
      },
      {
        type: "session/abortStream",
        payload: undefined,
      },
      {
        type: "session/clearDanglingMessages",
        payload: "failed",
      },
      {
        type: "chat/cancelStream/fulfilled",
        meta: {
          arg: { loop: "error", detail: expect.any(String) },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "ui/setDialogMessage",
        payload: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "Model configuration is invalid",
            }),
          }),
        }),
      },
      {
        type: "ui/setShowDialog",
        payload: true,
      },
      {
        type: "chat/streamWrapper/fulfilled",
        meta: {
          arg: expect.any(Function),
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
      {
        type: "chat/streamResponse/fulfilled",
        meta: {
          arg: {
            editorState: mockEditorState,
            modifiers: mockModifiers,
          },
          requestId: expect.any(String),
          requestStatus: "fulfilled",
        },
        payload: undefined,
      },
    ]);

    // Verify IDE messenger was called for compilation but not streaming
    expect(requestSpy).toHaveBeenCalledWith("llm/compileChat", {
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Hello, please help me with this code",
            },
          ],
        },
      ],
      options: {},
    });
    expect(chatSpy).not.toHaveBeenCalled();

    // Verify final state shows error dialog and inactive streaming
    const finalState = mockStore.getState();
    expect(finalState).toEqual({
      ...initialState,
      session: {
        ...initialState.session,
        sentToolList: expect.anything(),
        // the failed turn was saved, which titles the session
        title: "Hello",
        streamAborter: expect.any(AbortController),
        mainEditorContentTrigger: mockEditorState, // Editor content that triggered the request
        // The failed request is noted for the session
        promptCache: {
          ...initialState.session.promptCache,
          failures: [expect.objectContaining({ kind: "other" })],
        },
      },
      ui: {
        ...initialState.ui,
        showDialog: true, // Error dialog is shown
        dialogMessage: expect.objectContaining({
          props: expect.objectContaining({
            error: expect.objectContaining({
              message: "Model configuration is invalid",
            }),
          }),
        }),
      },
    });
  });
});
