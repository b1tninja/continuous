import type { JSONContent } from "@tiptap/core";
import type { ModelDescription } from "core";
import { describe, expect, it, vi } from "vitest";
import {
  continueAfterCompactionHold,
  setPreparedCompaction,
} from "../redux/slices/sessionSlice";
import type { RootState } from "../redux/store";
import { currentCompactionPlan } from "../redux/thunks/prepareCompaction";
import { streamResponseThunk } from "../redux/thunks/streamResponse";
import { compactionHoldFor, draftTokens } from "./compactionHold";
import { createMockStore, getEmptyRootState } from "./test/mockStore";

vi.mock("../redux/util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));
vi.mock(
  "../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "Next",
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
};

/** `exchanges` of about 7.2k tokens each, in a 100k window. */
function stateWith(
  exchanges: number,
  model: ModelDescription = strata,
): RootState {
  const state = getEmptyRootState();
  state.session.id = "s1";
  state.session.mode = "chat";
  state.session.history = Array.from({ length: exchanges }, (_, t) => [
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

const text = (s: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: s }] }],
});

describe("compactionHoldFor", () => {
  it("holds past the force threshold (85% of the window less core's 5% headroom on a local server) and not before", () => {
    // 72%: prepared, not forced
    expect(compactionHoldFor(stateWith(10), 0)).toBeUndefined();
    // 79% with a big message pushing it past 85%
    expect(compactionHoldFor(stateWith(11), 0)).toBeUndefined();
    const big = compactionHoldFor(stateWith(11), 6_500);
    expect(big?.totalTokens).toBeGreaterThanOrEqual(85_000);
    // 86%
    const hold = compactionHoldFor(stateWith(12), 10)!;
    // Where core's block drop starts: 85% of 100k / 1.05
    expect(hold.forceAtTokens).toBe(80_952);
    expect(hold.plan.state).toBe("force");
    expect(hold.rereadTokens).toBe(
      hold.plan.tokens.span + hold.plan.tokens.tail + 10,
    );
  });

  it("does not hold when a pre-warmed summary is ready: it is applied instead", () => {
    const state = stateWith(12);
    const plan = currentCompactionPlan(state)!;
    state.session.preparedCompaction = {
      sessionId: "s1",
      planId: plan.id,
      spanStart: plan.spanStart,
      spanEnd: plan.spanEnd,
      status: "ready",
      summary: "S",
      prewarm: { status: "done" },
    };
    expect(compactionHoldFor(state, 0)).toBeUndefined();
    // ...unless the person said Not now to it
    state.session.preparedCompaction.dismissed = true;
    expect(compactionHoldFor(state, 0)).toMatchObject({ prepared: true });
  });

  it("holds with a summary ready but not pre-warmed, offering it at once", () => {
    const state = stateWith(12);
    const plan = currentCompactionPlan(state)!;
    state.session.preparedCompaction = {
      sessionId: "s1",
      planId: plan.id,
      spanStart: plan.spanStart,
      spanEnd: plan.spanEnd,
      status: "ready",
      summary: "S",
    };
    expect(compactionHoldFor(state, 0)).toMatchObject({ prepared: true });
    expect(compactionHoldFor(stateWith(12), 0)).toMatchObject({
      prepared: false,
    });
  });

  it("does not hold again for a plan answered with Continue anyway", () => {
    const state = stateWith(12);
    state.session.compactionHoldContinued = currentCompactionPlan(state)!.id;
    expect(compactionHoldFor(state, 0)).toBeUndefined();
  });

  it("does not hold with planned compaction off", () => {
    const state = stateWith(12, {
      ...strata,
      contextManagement: { plannedCompaction: false },
    });
    expect(compactionHoldFor(state, 0)).toBeUndefined();
  });

  it("counts a draft at four characters a token", () => {
    expect(draftTokens(text("x".repeat(400)))).toBe(100);
    expect(draftTokens(undefined)).toBe(0);
  });
});

describe("the send path", () => {
  function store(exchanges = 12) {
    const s = createMockStore(stateWith(exchanges));
    const compiles: unknown[] = [];
    s.mockIdeMessenger.responseHandlers["llm/compileChat"] = (async (
      data: any,
    ) => {
      compiles.push(data);
      return {
        compiledChatMessages: data.messages,
        didPrune: false,
        contextPercentage: 0.9,
      };
    }) as any;
    s.mockIdeMessenger.llmStreamChat = vi.fn(async function* () {
      return undefined;
    }) as any;
    return { s, compiles, state: () => s.getState() as RootState };
  }

  it("holds the person's message before a forced re-read and sends nothing", async () => {
    const { s, compiles, state } = store();
    const length = state().session.history.length;
    await s.dispatch(
      streamResponseThunk({
        editorState: text("Next"),
        modifiers: { useCodebase: false, noContext: true },
        holdBeforeForcedReread: true,
      }) as any,
    );
    expect(state().session.compactionHold).toMatchObject({
      planId: currentCompactionPlan(state())!.id,
      editorState: text("Next"),
    });
    expect(state().session.history).toHaveLength(length);
    expect(compiles).toHaveLength(0);
  });

  it("never holds a message that did not ask for it (a loop, a resumed turn)", async () => {
    const { s, compiles, state } = store();
    await s.dispatch(
      streamResponseThunk({
        editorState: text("Next"),
        modifiers: { useCodebase: false, noContext: true },
      }) as any,
    );
    expect(state().session.compactionHold).toBeUndefined();
    expect(compiles).toHaveLength(1);
  });

  it("Continue anyway sends, and the plan is not held again", async () => {
    const { s, compiles, state } = store();
    const planId = currentCompactionPlan(state())!.id;
    s.dispatch(continueAfterCompactionHold(planId));
    await s.dispatch(
      streamResponseThunk({
        editorState: text("Next"),
        modifiers: { useCodebase: false, noContext: true },
        holdBeforeForcedReread: true,
      }) as any,
    );
    expect(state().session.compactionHold).toBeUndefined();
    expect(compiles).toHaveLength(1);
  });

  it("applies a pre-warmed summary at the turn instead of holding", async () => {
    const { s, compiles, state } = store();
    const plan = currentCompactionPlan(state())!;
    s.dispatch(
      setPreparedCompaction({
        sessionId: "s1",
        planId: plan.id,
        spanStart: plan.spanStart,
        spanEnd: plan.spanEnd,
        status: "ready",
        summary: "The summary.",
        prewarm: { status: "done" },
      }),
    );
    const length = state().session.history.length;
    await s.dispatch(
      streamResponseThunk({
        editorState: text("Next"),
        modifiers: { useCodebase: false, noContext: true },
        holdBeforeForcedReread: true,
      }) as any,
    );
    expect(state().session.compactionHold).toBeUndefined();
    const item = state().session.history[plan.spanEnd - 1];
    expect(item.conversationSummary).toBe("The summary.");
    // The length before the person's message was added
    expect(item.conversationSummaryHistoryLength).toBe(length);
    expect(compiles).toHaveLength(1);
  });

  it.each([
    {
      name: "a local server without a pre-warm",
      model: strata,
      applies: false,
    },
    {
      name: "a cloud provider, which writes the cache anyway",
      model: {
        ...strata,
        apiBase: "https://api.example.com/v1",
        contextManagement: { plannedCompaction: true },
      },
      applies: true,
    },
  ])(
    "at 79% (prepared, below force), $name: applied at the next turn is $applies",
    async ({ model, applies }) => {
      const s = createMockStore(stateWith(11, model));
      s.mockIdeMessenger.responseHandlers["llm/compileChat"] = (async (
        data: any,
      ) => ({
        compiledChatMessages: data.messages,
        didPrune: false,
        contextPercentage: 0.8,
      })) as any;
      s.mockIdeMessenger.llmStreamChat = vi.fn(async function* () {
        return undefined;
      }) as any;
      const state = () => s.getState() as RootState;
      const plan = currentCompactionPlan(state())!;
      s.dispatch(
        setPreparedCompaction({
          sessionId: "s1",
          planId: plan.id,
          spanStart: plan.spanStart,
          spanEnd: plan.spanEnd,
          status: "ready",
          summary: "The summary.",
        }),
      );
      await s.dispatch(
        streamResponseThunk({
          editorState: text("Next"),
          modifiers: { useCodebase: false, noContext: true },
          holdBeforeForcedReread: true,
        }) as any,
      );
      expect(state().session.compactionHold).toBeUndefined();
      expect(state().session.history.some((h) => h.conversationSummary)).toBe(
        applies,
      );
    },
  );
});
