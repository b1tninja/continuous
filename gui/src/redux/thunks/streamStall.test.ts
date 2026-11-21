import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STALL_AFTER_FIRST_CHUNK_MS } from "../../util/streamDeadline";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));
vi.mock("uuid", () => ({ v4: vi.fn(() => "mock-uuid-123") }));
vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "Hello",
      legacyCommandWithInput: undefined,
    })),
  }),
);

/**
 * A model stream that is open and sends nothing. Before, the turn showed
 * "Generating…" until the connection timed out two hours later. Now it ends
 * after the limit, the person's message and what arrived are kept, and the turn
 * is marked so Resume is offered.
 */
const editorState: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};
const modifiers: InputModifiers = { useCodebase: false, noContext: true };

const claude = {
  title: "Claude",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  underlyingProviderName: "anthropic",
} as never;

function rootState(): RootState {
  const state = getEmptyRootState();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: claude,
        },
      },
    },
  };
}

/** A stream that yields the given chunks and then stays open until aborted. */
function stallingStream(chunks: string[]) {
  return async function* (_msg: unknown, signal: AbortSignal) {
    for (const text of chunks) yield [{ role: "assistant", content: text }];
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve());
    });
    return undefined;
  };
}

function setup(stream: unknown) {
  const mock = createMockStore(rootState());
  mock.mockIdeMessenger.responses["llm/compileChat"] = {
    compiledChatMessages: [{ role: "user", content: "Hello" }],
    didPrune: false,
    contextPercentage: 0.5,
  };
  vi.spyOn(mock.mockIdeMessenger, "llmStreamChat").mockImplementation(
    stream as never,
  );
  return mock;
}

const state = (store: ReturnType<typeof setup>) =>
  (store.getState() as RootState).session;
const assistantText = (store: ReturnType<typeof setup>) =>
  state(store)
    .history.filter((h) => h.message.role === "assistant")
    .map((h) => String(h.message.content))
    .join("");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a model stream that goes silent", () => {
  it("ends the turn after the limit, keeping the message and what arrived", async () => {
    const store = setup(stallingStream(["Let me look at"]));
    const done = store.dispatch(
      streamResponseThunk({ editorState, modifiers }) as never,
    );
    await vi.advanceTimersByTimeAsync(STALL_AFTER_FIRST_CHUNK_MS + 1_000);
    await done;
    expect(state(store).isStreaming).toBe(false);
    const first = state(store).history[0];
    expect(first?.message.role).toBe("user");
    expect(assistantText(store)).toContain("Let me look at");
  });

  it("marks the turn failed so Resume is offered", async () => {
    const store = setup(stallingStream(["partial"]));
    const done = store.dispatch(
      streamResponseThunk({ editorState, modifiers }) as never,
    );
    await vi.advanceTimersByTimeAsync(STALL_AFTER_FIRST_CHUNK_MS + 1_000);
    await done;
    expect(state(store).history.some((h) => h.interrupted === "failed")).toBe(
      true,
    );
  });

  it("does not end a stream that keeps sending", async () => {
    const store = setup(async function* (_m: unknown, signal: AbortSignal) {
      for (let i = 0; i < 6; i++) {
        yield [{ role: "assistant", content: `part ${i} ` }];
        await new Promise((r) => setTimeout(r, STALL_AFTER_FIRST_CHUNK_MS / 2));
        if (signal.aborted) return undefined;
      }
      return undefined;
    });
    const done = store.dispatch(
      streamResponseThunk({ editorState, modifiers }) as never,
    );
    // far longer than the limit, but never silent for the limit
    await vi.advanceTimersByTimeAsync(STALL_AFTER_FIRST_CHUNK_MS * 4);
    await done;
    expect(state(store).history.some((h) => h.interrupted === "failed")).toBe(
      false,
    );
    expect(assistantText(store)).toContain("part 5");
  });

  it("a stream that sends nothing at all gets the longer first-chunk limit", async () => {
    const store = setup(stallingStream([]));
    const done = store.dispatch(
      streamResponseThunk({ editorState, modifiers }) as never,
    );
    // past the after-first-chunk limit: still waiting for a first chunk
    await vi.advanceTimersByTimeAsync(STALL_AFTER_FIRST_CHUNK_MS + 5_000);
    expect(state(store).isStreaming).toBe(true);
    // past the before-first-chunk limit: ended
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await done;
    expect(state(store).isStreaming).toBe(false);
  });
});
