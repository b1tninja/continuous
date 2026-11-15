import { renderHook } from "@testing-library/react";
import type { ModelDescription } from "core";
import { createElement, type PropsWithChildren } from "react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { useCompactConversation } from "../../util/compactConversation";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  setActive,
  setInactive,
  updateHistoryItemAtIndex,
} from "../slices/sessionSlice";
import type { AppThunkDispatch, RootState } from "../store";
import {
  type CompactionPreparer,
  currentCompactionPlan,
  isLocalModel,
  plannedCompactionEnabled,
  PREPARE_IDLE_MS,
  startCompactionPreparer,
  usablePreparedCompaction,
} from "./prepareCompaction";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));

const strata: ModelDescription = {
  title: "Qwen on Strata",
  model: "qwen3-coder",
  provider: "openai",
  underlyingProviderName: "openai",
  apiBase: "http://127.0.0.1:8086/v1",
  contextLength: 100_000,
};

/** Ten exchanges of about 3.6k tokens per message: 72% of a 100k window. */
function stateWith(
  model: ModelDescription = strata,
  firstRequest = "x".repeat(14_400),
): RootState {
  const state = getEmptyRootState();
  state.session.id = "s1";
  state.session.mode = "chat";
  state.session.history = Array.from({ length: 10 }, (_, t) => [
    {
      message: {
        id: `u${t}`,
        role: "user",
        content: t === 0 ? firstRequest : `${t} ${"q".repeat(14_400)}`,
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

type Summarize = (data: any) => Promise<unknown>;

function setup(opts: { model?: ModelDescription; firstRequest?: string } = {}) {
  const messenger = new MockIdeMessenger();
  const store = createMockStore(
    stateWith(opts.model, opts.firstRequest),
    messenger,
  );
  const posts: [string, unknown, string | undefined][] = [];
  vi.spyOn(messenger, "post").mockImplementation(((
    type: string,
    data: unknown,
    id?: string,
  ) => {
    posts.push([type, data, id]);
  }) as any);
  const calls: any[] = [];
  let answer: Summarize = async () => ({ summary: "The summary." });
  messenger.responseHandlers["conversation/summarize"] = (async (data: any) => {
    calls.push(data);
    return answer(data);
  }) as any;
  const compactCalls: any[] = [];
  messenger.responseHandlers["conversation/compact"] = (async (data: any) => {
    compactCalls.push(data);
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
    messenger,
    getState,
    preparer,
    posts,
    calls,
    compactCalls,
    answerWith(fn: Summarize) {
      answer = fn;
    },
  };
}

/** A summary request that waits until the test lets it answer. */
function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** As long as the message it replaces, so the context stays past the threshold. */
const EDITED = `0 ${"e".repeat(14_400)}`;

let preparer: CompactionPreparer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  preparer?.stop();
  preparer = undefined;
  vi.useRealTimers();
});

describe("planned compaction: settings", () => {
  it.each([
    { name: "local, unset", model: strata, on: true },
    {
      name: "local, off",
      model: { ...strata, contextManagement: { plannedCompaction: false } },
      on: false,
    },
    {
      name: "ollama with no apiBase",
      model: { ...strata, provider: "ollama", apiBase: undefined },
      on: true,
    },
    {
      name: "cloud, unset",
      model: { ...strata, provider: "anthropic", apiBase: undefined },
      on: false,
    },
    {
      name: "cloud, on",
      model: {
        ...strata,
        provider: "anthropic",
        apiBase: "https://api.anthropic.com/v1",
        contextManagement: { plannedCompaction: true },
      },
      on: true,
    },
  ])("$name: on is $on", ({ model, on }) => {
    expect(plannedCompactionEnabled(model as ModelDescription)).toBe(on);
  });

  it("uses the local thresholds for a local server, the cloud ones otherwise", () => {
    expect(isLocalModel(strata)).toBe(true);
    expect(currentCompactionPlan(stateWith())?.state).toBe("prepare");
    // 72% is under the cloud prepare threshold (75%)
    const cloud = {
      ...strata,
      apiBase: "https://api.example.com/v1",
      contextManagement: { plannedCompaction: true },
    };
    expect(currentCompactionPlan(stateWith(cloud))).toBeUndefined();
  });

  it("the off switch: no plan and no summary request", async () => {
    const t = setup({
      model: { ...strata, contextManagement: { plannedCompaction: false } },
    });
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS * 3);
    expect(t.calls).toHaveLength(0);
    expect(t.getState().session.compactionPlan).toBeUndefined();
  });
});

describe("planned compaction: the background summary", () => {
  it("is made after 10 s of idle, for the plan's span, and kept on the session", async () => {
    const t = setup();
    preparer = t.preparer;
    const plan = t.getState().session.compactionPlan!;
    expect(plan.state).toBe("prepare");

    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS - 1);
    expect(t.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      sessionId: "s1",
      index: plan.spanEnd - 1,
    });
    expect(t.calls[0].requestId).toEqual(expect.any(String));
    // A local server caches any prefix: the conversation's own request is sent
    expect(t.calls[0].prefix.messages[0].role).toBe("system");

    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    expect(t.getState().session.preparedCompaction).toMatchObject({
      planId: plan.id,
      spanEnd: plan.spanEnd,
      summary: "The summary.",
    });
    // The chat itself is untouched
    expect(
      t.getState().session.history.some((h) => h.conversationSummary),
    ).toBe(false);
    // Not asked again for the same plan
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS * 3);
    t.preparer.noteActivity();
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    expect(t.calls).toHaveLength(1);
  });

  it("quotes a short first request word for word above the summary", async () => {
    // Without the long first request the rest is 68% of 100k: a 95k window
    const t = setup({
      model: { ...strata, contextLength: 95_000 },
      firstRequest: "Port the parser to Rust.",
    });
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    expect(t.getState().session.preparedCompaction?.summary).toBe(
      "The conversation began with this request, quoted word for word:\n\nPort the parser to Rust.\n\nThe summary.",
    );
  });

  it("waits while a reply is streaming, and starts 10 s after it ends", async () => {
    const t = setup();
    preparer = t.preparer;
    t.store.dispatch(setActive());
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS * 3);
    expect(t.calls).toHaveLength(0);
    t.store.dispatch(setInactive());
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    expect(t.calls).toHaveLength(1);
  });

  it("typing restarts the wait", async () => {
    const t = setup();
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS - 1_000);
    t.preparer.noteActivity();
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS - 1);
    expect(t.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toHaveLength(1);
  });

  it.each([
    {
      name: "typing",
      act: (t: ReturnType<typeof setup>) => t.preparer.noteActivity(),
      resume: () => {},
    },
    {
      name: "a message sent (streaming starts)",
      act: (t: ReturnType<typeof setup>) => t.store.dispatch(setActive()),
      resume: (t: ReturnType<typeof setup>) => t.store.dispatch(setInactive()),
    },
  ])(
    "$name aborts a running summary, discards it, and retries at the next idle",
    async ({ act, resume }) => {
      const t = setup();
      preparer = t.preparer;
      const first = deferred();
      t.answerWith(() => first.promise);
      await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
      expect(t.calls).toHaveLength(1);
      const { requestId } = t.calls[0];
      expect(t.getState().session.preparedCompaction?.status).toBe("running");

      act(t);
      expect(t.posts).toContainEqual(["abort", undefined, requestId]);
      expect(t.getState().session.preparedCompaction).toBeUndefined();
      // The aborted request ends; whatever it carried is not kept
      first.resolve({ summary: "partial", aborted: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.getState().session.preparedCompaction).toBeUndefined();

      t.answerWith(async () => ({ summary: "Second try." }));
      resume(t);
      await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
      expect(t.calls).toHaveLength(2);
      expect(t.calls[1].requestId).not.toBe(requestId);
      await vi.waitFor(() =>
        expect(t.getState().session.preparedCompaction?.summary).toBe(
          "Second try.",
        ),
      );
    },
  );

  it("a failed summary is not retried until something happens", async () => {
    const t = setup();
    preparer = t.preparer;
    t.answerWith(async () => ({ error: "connection refused", aborted: false }));
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS * 5);
    expect(t.calls).toHaveLength(1);
    expect(t.getState().session.preparedCompaction).toBeUndefined();
    t.preparer.noteActivity();
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    expect(t.calls).toHaveLength(2);
  });

  it("is dropped when the span is edited, and made again for the new plan", async () => {
    const t = setup();
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    const oldId = t.getState().session.preparedCompaction!.planId;
    const last = t.getState().session.history.length - 1;
    expect(usablePreparedCompaction(t.getState(), last)).toBeDefined();

    t.store.dispatch(
      updateHistoryItemAtIndex({
        index: 1,
        updates: {
          message: { id: "a0", role: "assistant", content: EDITED } as any,
        },
      }),
    );
    expect(t.getState().session.preparedCompaction).toBeUndefined();
    expect(usablePreparedCompaction(t.getState(), last)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    expect(t.getState().session.preparedCompaction!.planId).not.toBe(oldId);
  });

  it("a summary whose span changed while it was made is discarded", async () => {
    const t = setup();
    preparer = t.preparer;
    const pending = deferred();
    t.answerWith(() => pending.promise);
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    t.store.dispatch(
      updateHistoryItemAtIndex({
        index: 1,
        updates: {
          message: { id: "a0", role: "assistant", content: EDITED } as any,
        },
      }),
    );
    pending.resolve({ summary: "Describes the old span." });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.getState().session.preparedCompaction?.summary).not.toBe(
      "Describes the old span.",
    );
  });

  it("an edit in the tail keeps the prepared summary", async () => {
    const t = setup();
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    const last = t.getState().session.history.length - 1;
    t.store.dispatch(
      updateHistoryItemAtIndex({
        index: last,
        updates: {
          message: { id: "a9", role: "assistant", content: EDITED } as any,
        },
      }),
    );
    expect(t.getState().session.preparedCompaction?.status).toBe("ready");
    expect(usablePreparedCompaction(t.getState(), last)).toBeDefined();
  });
});

describe("planned compaction: Compact now", () => {
  it("uses the prepared summary when its plan is current, at the plan's boundary", async () => {
    const t = setup();
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    const plan = t.getState().session.compactionPlan!;
    const last = t.getState().session.history.length - 1;
    expect(usablePreparedCompaction(t.getState(), last)).toEqual({
      index: plan.spanEnd - 1,
      summary: "The summary.",
    });
    // Compacting at the boundary itself uses it too; elsewhere it does not
    expect(
      usablePreparedCompaction(t.getState(), plan.spanEnd - 1),
    ).toBeDefined();
    expect(usablePreparedCompaction(t.getState(), 3)).toBeUndefined();
  });

  it("does not use a summary still being made", async () => {
    const t = setup();
    preparer = t.preparer;
    t.answerWith(() => deferred().promise);
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    const last = t.getState().session.history.length - 1;
    expect(t.getState().session.preparedCompaction?.status).toBe("running");
    expect(usablePreparedCompaction(t.getState(), last)).toBeUndefined();
  });

  function compactHook(t: ReturnType<typeof setup>) {
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(
        IdeMessengerProvider,
        { messenger: t.messenger },
        createElement(Provider, { store: t.store as any }, children),
      );
    return renderHook(() => useCompactConversation(), { wrapper }).result
      .current;
  }

  it("saves the prepared summary with no second summary request", async () => {
    const t = setup();
    preparer = t.preparer;
    await vi.advanceTimersByTimeAsync(PREPARE_IDLE_MS);
    await vi.waitFor(() =>
      expect(t.getState().session.preparedCompaction?.status).toBe("ready"),
    );
    const plan = t.getState().session.compactionPlan!;
    const compact = compactHook(t);
    const last = t.getState().session.history.length - 1;
    t.messenger.responseHandlers["history/load"] = (async () => ({
      ...t.getState().session,
      history: t.getState().session.history,
    })) as any;
    await expect(compact(last)).resolves.toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.compactCalls).toEqual([
      { index: plan.spanEnd - 1, sessionId: "s1", summary: "The summary." },
    ]);
  });

  it("without a prepared summary, compacts as before", async () => {
    const t = setup({
      model: { ...strata, contextManagement: { plannedCompaction: false } },
    });
    preparer = t.preparer;
    const compact = compactHook(t);
    const last = t.getState().session.history.length - 1;
    await expect(compact(last)).resolves.toBe(true);
    expect(t.compactCalls).toHaveLength(1);
    expect(t.compactCalls[0]).toMatchObject({ index: last, sessionId: "s1" });
    expect(t.compactCalls[0].summary).toBeUndefined();
  });
});
