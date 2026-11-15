import type { JSONContent } from "@tiptap/core";
import type { ModelDescription } from "core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { dismissPreparedCompaction } from "../slices/sessionSlice";
import type { AppThunkDispatch, RootState } from "../store";
import {
  type CompactionPreparer,
  PREPARE_IDLE_MS,
  startCompactionPreparer,
} from "./prepareCompaction";
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
      content: "Next, the docs.",
      legacyCommandWithInput: undefined,
    })),
  }),
);

const strata: ModelDescription = {
  title: "Qwen on Strata",
  model: "qwen3-coder",
  provider: "openai",
  underlyingProviderName: "openai",
  apiBase: "http://127.0.0.1:8086/v1",
  contextLength: 100_000,
  // Off by default this release (DEFAULT_PREWARM), so the tests turn it on
  contextManagement: { prewarm: "local" },
};

const editorState: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Next, the docs." }] },
  ],
};

/** Ten exchanges of about 3.6k tokens per message: 72% of a 100k window. */
function stateWith(model: ModelDescription = strata): RootState {
  const state = getEmptyRootState();
  state.session.id = "s1";
  state.session.mode = "chat";
  state.session.history = Array.from({ length: 10 }, (_, t) => [
    {
      message: {
        id: `u${t}`,
        role: "user",
        content: `${t} ${"q".repeat(14_400)}`,
      },
      contextItems: [],
    },
    {
      message: {
        id: `a${t}`,
        role: "assistant",
        content: `${t} ${"a".repeat(14_400)}`,
      },
      contextItems: [],
    },
  ]).flat() as any;
  state.config.config = {
    ...state.config.config,
    selectedModelByRole: {
      ...state.config.config.selectedModelByRole,
      chat: model,
    },
  };
  return state;
}

type Answer = (data: any) => Promise<unknown>;

function setup(model: ModelDescription = strata) {
  const store = createMockStore(stateWith(model));
  const messenger = store.mockIdeMessenger;
  const posts: [string, unknown, string | undefined][] = [];
  vi.spyOn(messenger, "post").mockImplementation(((
    type: string,
    data: unknown,
    id?: string,
  ) => {
    posts.push([type, data, id]);
  }) as any);
  messenger.responseHandlers["conversation/summarize"] = (async () => ({
    summary: "The summary.",
  })) as any;
  const prewarms: any[] = [];
  let answer: Answer = async () => ({
    status: "sent",
    server: "strata",
    pinMessages: 2,
    durationMs: 12_500,
  });
  messenger.responseHandlers["llm/prewarm"] = (async (data: any) => {
    prewarms.push(data);
    return answer(data);
  }) as any;
  const compiles: any[] = [];
  messenger.responseHandlers["llm/compileChat"] = (async (data: any) => {
    compiles.push(data);
    return {
      compiledChatMessages: data.messages,
      didPrune: false,
      contextPercentage: 0.3,
    };
  }) as any;
  messenger.llmStreamChat = vi.fn(async function* () {
    return undefined;
  }) as any;
  const getState = () => store.getState() as RootState;
  const preparer = startCompactionPreparer({
    getState,
    dispatch: store.dispatch as AppThunkDispatch,
    subscribe: store.subscribe,
  });
  return {
    store,
    getState,
    preparer,
    posts,
    prewarms,
    compiles,
    answerWith(fn: Answer) {
      answer = fn;
    },
  };
}

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

let preparer: CompactionPreparer | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  preparer?.stop();
  preparer = undefined;
  vi.useRealTimers();
});

async function untilPrewarm(
  t: ReturnType<typeof setup>,
  status: "done" | "skipped" | "running",
) {
  await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
  await vi.waitFor(() =>
    expect(t.getState().session.preparedCompaction?.prewarm?.status).toBe(
      status,
    ),
  );
}

describe("the pre-warm (C106)", () => {
  it("sends the request the next turn sends, up to the new message, byte for byte", async () => {
    const t = setup();
    preparer = t.preparer;
    await untilPrewarm(t, "done");
    expect(t.prewarms).toHaveLength(1);
    const warm = t.prewarms[0];
    const plan = t.getState().session.compactionPlan!;
    // [head][summary message][tail]
    expect(warm.messages[0].role).toBe("system");
    expect(warm.messages[1]).toEqual({
      role: "user",
      content: "Previous conversation summary:\n\nThe summary.",
    });
    expect(warm.liveTokens).toBe(plan.tokens.total);
    expect(warm.promptTokens).toBeLessThan(plan.tokens.total);

    // The next turn: the summary is saved first, then the message goes out
    preparer.stop();
    vi.useRealTimers();
    await t.store.dispatch(
      streamResponseThunk({
        editorState,
        modifiers: { useCodebase: false, noContext: true },
      }) as any,
    );
    expect(
      t.getState().session.history[plan.spanEnd - 1].conversationSummary,
    ).toBe("The summary.");
    expect(t.compiles).toHaveLength(1);
    const real = t.compiles[0];
    expect(real.messages).toHaveLength(warm.messages.length + 1);
    expect(JSON.stringify(real.messages.slice(0, warm.messages.length))).toBe(
      JSON.stringify(warm.messages),
    );
    expect(real.messages.at(-1)).toMatchObject({ role: "user" });
    // The same tools, reasoning and cache options
    expect(real.options).toEqual(warm.options);
  });

  it("is aborted by activity and sent again at the next idle", async () => {
    const t = setup();
    preparer = t.preparer;
    const first = deferred();
    t.answerWith(() => first.promise);
    await untilPrewarm(t, "running");
    const { requestId } = t.prewarms[0];
    t.preparer.noteActivity();
    expect(t.posts).toContainEqual(["abort", undefined, requestId]);
    first.resolve({ status: "skipped", reason: "aborted", detail: "Stopped" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.getState().session.preparedCompaction?.prewarm).toBeUndefined();
    // The summary itself is kept
    expect(t.getState().session.preparedCompaction?.status).toBe("ready");

    t.answerWith(async () => ({
      status: "sent",
      server: "strata",
      durationMs: 1,
    }));
    await untilPrewarm(t, "done");
    expect(t.prewarms).toHaveLength(2);
    expect(t.prewarms[1].requestId).not.toBe(requestId);
  });

  it("keeps why it was skipped and does not ask again", async () => {
    const t = setup();
    preparer = t.preparer;
    t.answerWith(async () => ({
      status: "skipped",
      reason: "low-memory",
      detail:
        "Strata reports about 4.3 GB of free memory and the pre-warm could need about 8.7 GB, so it was not sent",
    }));
    await untilPrewarm(t, "skipped");
    expect(t.getState().session.preparedCompaction?.prewarm?.detail).toMatch(
      /4\.3 GB/,
    );
    t.preparer.noteActivity();
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS * 2);
    expect(t.prewarms).toHaveLength(1);
  });

  it.each([
    {
      name: "prewarm off",
      model: { ...strata, contextManagement: { prewarm: "off" as const } },
    },
    {
      name: "a cloud model with prewarm always (no cloud pre-warm yet)",
      model: {
        ...strata,
        apiBase: "https://api.example.com/v1",
        contextLength: 90_000,
        contextManagement: {
          plannedCompaction: true,
          prewarm: "always" as const,
        },
      },
    },
  ])("is not sent with $name", async ({ model }) => {
    const t = setup(model);
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    expect(t.prewarms).toHaveLength(0);
  });

  it("is not sent with prewarm unset: off by default until the live check", async () => {
    const t = setup({ ...strata, contextManagement: undefined });
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    expect(t.prewarms).toHaveLength(0);
  });

  it("is sent with prewarm local and always on a local server", async () => {
    for (const prewarm of ["local", "always"] as const) {
      const t = setup({ ...strata, contextManagement: { prewarm } });
      preparer = t.preparer;
      await untilPrewarm(t, "done");
      expect(t.prewarms).toHaveLength(1);
      preparer.stop();
    }
  });

  it("Not now: the summary is not applied at the next turn", async () => {
    const t = setup();
    preparer = t.preparer;
    await untilPrewarm(t, "done");
    t.store.dispatch(dismissPreparedCompaction());
    preparer.stop();
    vi.useRealTimers();
    await t.store.dispatch(
      streamResponseThunk({
        editorState,
        modifiers: { useCodebase: false, noContext: true },
      }) as any,
    );
    expect(
      t.getState().session.history.some((h) => h.conversationSummary),
    ).toBe(false);
  });
});
