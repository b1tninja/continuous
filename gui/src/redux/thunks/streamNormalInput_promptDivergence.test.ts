/**
 * The divergence reporter: for a local server, each request's parts are
 * compared with the previous request's, and a cache miss names the first
 * part that changed (core/llm/promptDivergence.ts). The debug line carries
 * positions and sizes only.
 */
import { JSONContent } from "@tiptap/core";
import { ModelDescription } from "core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { requestPartsMemory } from "../../util/promptPartsMemory";
import { updateHistoryItemAtIndex } from "../slices/sessionSlice";
import { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({ resolveEditorContent: vi.fn() }),
);
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";

const SECRET = "private words of the person";

const STRATA: ModelDescription = {
  title: "Strata Qwen",
  model: "qwen3.8-flash-next-nvfp4-uncensored",
  provider: "openai",
  underlyingProviderName: "openai",
  apiBase: "http://127.0.0.1:8086/v1/",
  capabilities: { tools: false },
};

const doc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

function setup() {
  const state = getEmptyRootState();
  state.session.id = "s-div";
  state.session.mode = "chat";
  state.session.history = [
    {
      message: { id: "u1", role: "user", content: `First. ${SECRET}` },
      contextItems: [],
    },
    {
      message: { id: "a1", role: "assistant", content: "Answer." },
      contextItems: [],
    },
  ] as RootState["session"]["history"];
  state.config.config = {
    ...state.config.config,
    selectedModelByRole: {
      ...state.config.config.selectedModelByRole,
      chat: STRATA,
    },
  };
  const store = createMockStore(state);
  store.mockIdeMessenger.responseHandlers["llm/compileChat"] = async (
    data: any,
  ) => ({
    compiledChatMessages: data.messages,
    didPrune: false,
    didAge: false,
    contextPercentage: 0.5,
  });
  const replies: { usage: any; serverCache?: any }[] = [];
  store.mockIdeMessenger.llmStreamChat = vi.fn(async function* () {
    const r = replies.shift()!;
    yield [{ role: "assistant", content: "OK." }];
    yield [{ role: "assistant", content: "", usage: r.usage }];
    return {
      prompt: "",
      completion: "OK.",
      modelTitle: STRATA.title,
      modelProvider: "openai",
      ...(r.serverCache && { serverCache: r.serverCache }),
    };
  }) as any;
  const send = (text: string) =>
    store.dispatch(
      streamResponseThunk({
        editorState: doc(text),
        modifiers: { useCodebase: false, noContext: true },
      }) as any,
    );
  return {
    store,
    replies,
    send,
    getState: () => store.getState() as RootState,
  };
}

beforeEach(() => {
  requestPartsMemory.forget();
  vi.mocked(resolveEditorContent).mockImplementation(
    async ({ editorState }: any) => ({
      selectedContextItems: [],
      selectedCode: [],
      content: editorState.content[0].content[0].text,
      legacyCommandWithInput: undefined,
    }),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("the cache-miss notice names what changed", () => {
  it("names the first user message when it changed and the server reused little", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const s = setup();
    s.replies.push({
      usage: {
        promptTokens: 400_000,
        completionTokens: 50,
        promptTokensDetails: { cachedTokens: 399_000 },
      },
    });
    await s.send("Second.");
    // Something rewrites the first message before the next request
    s.store.dispatch(
      updateHistoryItemAtIndex({
        index: 0,
        updates: {
          message: { id: "u1", role: "user", content: `Changed. ${SECRET}` },
        },
      }),
    );
    s.replies.push({
      usage: {
        promptTokens: 400_400,
        completionTokens: 50,
        promptTokensDetails: { cachedTokens: 16_384 },
      },
    });
    await s.send("Third.");

    const miss = s.getState().session.promptCache?.lastMiss;
    expect(miss?.readTokens).toBe(16_384);
    expect(miss?.causes[0]).toBe(
      "message 2 (your first message) changed: a user message",
    );
    // The ledger names it too
    const ledger = s.getState().session.promptCache?.ledger ?? [];
    expect(JSON.stringify(ledger.at(-1))).toContain("your first message");

    const lines = debug.mock.calls.map((c) => c.join(" "));
    const line = lines.find((l) => l.includes("[prompt cache]"));
    expect(line).toContain("(user #1)");
    expect(line).toContain("reused 16384 of 400400 tokens");
    for (const l of lines) {
      expect(l).not.toContain(SECRET);
      expect(l).not.toContain("Changed.");
    }
  });

  it("says the server dropped its cache when the prompt only grew", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const s = setup();
    s.replies.push({
      usage: {
        promptTokens: 400_000,
        completionTokens: 50,
        promptTokensDetails: { cachedTokens: 399_000 },
      },
    });
    await s.send("Second.");
    s.replies.push({
      usage: {
        promptTokens: 400_400,
        completionTokens: 50,
        promptTokensDetails: { cachedTokens: 16_384 },
      },
    });
    await s.send("Third.");
    expect(s.getState().session.promptCache?.lastMiss?.causes[0]).toMatch(
      /only grew/,
    );
  });

  it("uses Strata's own record when the usage had no cached count", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const s = setup();
    s.replies.push({
      usage: { promptTokens: 400_000, completionTokens: 50 },
      serverCache: { promptTokens: 400_000, reused: 399_000 },
    });
    await s.send("Second.");
    expect(s.getState().session.promptCache?.lastMiss).toBeUndefined();
    s.replies.push({
      usage: { promptTokens: 400_400, completionTokens: 50 },
      serverCache: { promptTokens: 400_400, reused: 16_384 },
    });
    await s.send("Third.");
    expect(s.getState().session.promptCache?.lastMiss).toMatchObject({
      readTokens: 16_384,
      expectedTokens: 400_000,
    });
  });
});
