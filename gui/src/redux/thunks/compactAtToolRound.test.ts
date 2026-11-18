import { createAsyncThunk } from "@reduxjs/toolkit";
import type { ChatHistoryItem, ModelDescription } from "core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { setPreparedCompaction } from "../slices/sessionSlice";
import type { AppThunkDispatch, RootState } from "../store";
import {
  compactAtToolRound,
  lastRequestPrefix,
  toolRoundCompactionNeed,
} from "./compactAtToolRound";
import { currentCompactionPlan, forceAtTokens } from "./prepareCompaction";
import { buildChatRequest } from "../util/buildChatRequest";
import { streamResponseThunk } from "./streamResponse";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

vi.mock("../util/getBaseSystemMessage", () => ({
  getBaseSystemMessage: vi.fn(() => "You are a helpful assistant."),
}));

/** What streamNormalInput saw when the loop's next request went out. */
const nextRequests: { history: ChatHistoryItem[]; isPruned: boolean }[] = [];
vi.mock("./streamNormalInput", () => ({
  streamNormalInput: createAsyncThunk(
    "chat/streamNormalInput",
    async (_: unknown, { getState }) => {
      const state = getState() as RootState;
      nextRequests.push({
        history: state.session.history,
        isPruned: !!state.session.isPruned,
      });
    },
  ),
}));

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "Next item",
      legacyCommandWithInput: undefined,
    })),
  }),
);

afterEach(() => {
  nextRequests.length = 0;
});

const strata: ModelDescription = {
  title: "Qwen on Strata",
  model: "qwen3-coder",
  provider: "openai",
  underlyingProviderName: "openai",
  apiBase: "http://127.0.0.1:8086/v1",
  contextLength: 100_000,
};

const cloud: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-5-5",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  contextManagement: { plannedCompaction: true },
  contextLength: 100_000,
};

/**
 * An agent loop: one request, then `rounds` tool rounds of a call and a
 * result of about 4k tokens, with the last round's result still to come
 * (`open`) or already in.
 */
function loopState(
  rounds: number,
  model: ModelDescription = strata,
  { open = false } = {},
): RootState {
  const state = getEmptyRootState();
  state.session.id = "s1";
  state.session.mode = "agent";
  const history: any[] = [
    {
      message: { id: "u0", role: "user", content: "Fix the failing tests." },
      contextItems: [],
    },
  ];
  for (let r = 0; r < rounds; r++) {
    const id = `c${r}`;
    const last = r === rounds - 1;
    history.push({
      message: {
        id: `a${r}`,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id,
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
        ],
      },
      contextItems: [],
      toolCallStates: [
        {
          toolCallId: id,
          toolCall: {
            id,
            type: "function",
            function: { name: "read_file", arguments: "{}" },
          },
          status: "done",
          parsedArgs: {},
          output: [
            {
              name: "file",
              description: "file",
              content: `${r} ${"r".repeat(16_000)}`,
            },
          ],
        },
      ],
    });
    if (!(open && last)) {
      history.push({
        message: {
          id: `t${r}`,
          role: "tool",
          content: `${r} ${"r".repeat(16_000)}`,
          toolCallId: id,
        },
        contextItems: [],
      });
    }
  }
  state.session.history = history;
  state.config.config = {
    ...state.config.config,
    selectedModelByRole: {
      ...state.config.config.selectedModelByRole,
      chat: model,
    },
  };
  return state;
}

function setup(state: RootState) {
  const messenger = new MockIdeMessenger();
  const store = createMockStore(state, messenger);
  const posts: [string, unknown, string | undefined][] = [];
  vi.spyOn(messenger, "post").mockImplementation(((
    type: string,
    data: unknown,
    id?: string,
  ) => {
    posts.push([type, data, id]);
  }) as any);
  const calls: any[] = [];
  let answer = async (_data: any): Promise<unknown> => ({
    summary: "The loop read the tests and fixed two of them.",
  });
  messenger.responseHandlers["conversation/summarize"] = (async (data: any) => {
    calls.push(data);
    return answer(data);
  }) as any;
  messenger.responseHandlers["history/save"] = (async () => undefined) as any;
  const getState = () => store.getState() as RootState;
  const dispatch = store.dispatch as AppThunkDispatch;
  return {
    store,
    messenger,
    getState,
    dispatch,
    posts,
    calls,
    answerWith(fn: (data: any) => Promise<unknown>) {
      answer = fn;
    },
    run(signal?: AbortSignal) {
      const need = toolRoundCompactionNeed(getState());
      if (!need) return Promise.resolve("none" as const);
      return compactAtToolRound({
        need,
        dispatch,
        getState,
        extra: { ideMessenger: messenger } as any,
        signal,
      });
    },
  };
}

describe("toolRoundCompactionNeed", () => {
  it("is due once the loop reaches the point where core drops the oldest block", () => {
    // 15 rounds of about 4.1k: 62%, no plan yet
    expect(toolRoundCompactionNeed(loopState(15))).toBeUndefined();
    // 18 rounds: past the 70% plan, still under the drop
    const preparing = loopState(18);
    expect(currentCompactionPlan(preparing)?.state).toBe("prepare");
    expect(toolRoundCompactionNeed(preparing)).toBeUndefined();
    // 21 rounds: at 85% of the window less core's headroom
    const state = loopState(21);
    const need = toolRoundCompactionNeed(state)!;
    expect(need.plan.tokens.total).toBeGreaterThanOrEqual(
      forceAtTokens(need.plan, strata),
    );
    expect(need.prepared).toBeUndefined();
  });

  it("plans the cut at a tool round, since the loop is a single request", () => {
    const { plan } = toolRoundCompactionNeed(loopState(21))!;
    const history = loopState(21).session.history;
    expect(history[plan.spanEnd].message.role).toBe("assistant");
    expect(history[plan.spanEnd - 1].message.role).toBe("tool");
    expect(plan.quoteFirstUser).toBe(0);
  });

  it("is due below the threshold when the last request was already pruned", () => {
    const state = loopState(18);
    state.session.isPruned = true;
    expect(toolRoundCompactionNeed(state)).toBeDefined();
  });

  it("is not due after Continue anyway at the hold for the same plan", () => {
    const state = loopState(21);
    state.session.compactionHoldContinued = currentCompactionPlan(state)!.id;
    expect(toolRoundCompactionNeed(state)).toBeUndefined();
  });

  it("is not due with planned compaction off", () => {
    const state = loopState(21, {
      ...strata,
      contextManagement: { plannedCompaction: false },
    });
    expect(toolRoundCompactionNeed(state)).toBeUndefined();
  });
});

describe("lastRequestPrefix", () => {
  it("is the prompt of the request that made the newest answer", () => {
    const state = loopState(21);
    const prefix = lastRequestPrefix(state)!;
    const full = buildChatRequest(state);
    // It ends with the previous round's result, before the newest call and
    // its result
    expect(prefix.messages.length).toBe(full.messages.length - 2);
    expect(prefix.messages).toEqual(full.messages.slice(0, -2));
    expect(JSON.stringify(prefix.messages.at(-1))).toContain("19 r");
    expect(prefix.messages[0].role).toBe("system");
  });

  it("is not used after a pruned request", () => {
    const state = loopState(21);
    state.session.isPruned = true;
    expect(lastRequestPrefix(state)).toBeUndefined();
  });
});

describe("compactAtToolRound", () => {
  it("makes the summary from the warm prompt and saves it at the plan's boundary", async () => {
    const t = setup(loopState(21));
    const plan = currentCompactionPlan(t.getState())!;
    expect(await t.run()).toBe("summarized");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({
      sessionId: "s1",
      index: plan.spanEnd - 1,
    });
    expect(JSON.stringify(t.calls[0].prefix.messages.at(-1))).toContain("19 r");
    const history = t.getState().session.history;
    expect(history[plan.spanEnd - 1].conversationSummary).toContain(
      "fixed two of them",
    );
    // The first request is quoted word for word at the top
    expect(history[plan.spanEnd - 1].conversationSummary).toContain(
      "Fix the failing tests.",
    );
    // Every item is kept; the loading line is gone
    expect(history).toHaveLength(43);
    expect(t.getState().session.compactionLoading).toEqual({});
    // Well under the drop now
    expect(toolRoundCompactionNeed(t.getState())).toBeUndefined();
  });

  it("saves a ready summary with no request", async () => {
    const state = loopState(21);
    const plan = currentCompactionPlan(state)!;
    const t = setup(state);
    t.dispatch(
      setPreparedCompaction({
        sessionId: "s1",
        planId: plan.id,
        spanStart: plan.spanStart,
        spanEnd: plan.spanEnd,
        status: "ready",
        summary: "Prepared earlier.",
        // Put off with Not now at 70%: at the drop it is still the better way
        dismissed: true,
      }),
    );
    expect(await t.run()).toBe("applied-prepared");
    expect(t.calls).toHaveLength(0);
    expect(
      t.getState().session.history[plan.spanEnd - 1].conversationSummary,
    ).toBe("Prepared earlier.");
  });

  it("on a cloud provider uses only a ready summary, and never asks for one", async () => {
    // Cloud drops at 90% of the window
    const t = setup(loopState(23, cloud));
    expect(toolRoundCompactionNeed(t.getState())).toBeDefined();
    expect(await t.run()).toBe("none");
    expect(t.calls).toHaveLength(0);
  });

  it("stops with Stop: nothing is saved and the request is aborted", async () => {
    const t = setup(loopState(21));
    const stop = new AbortController();
    t.answerWith(async () => {
      stop.abort();
      return { error: "aborted", aborted: true };
    });
    expect(await t.run(stop.signal)).toBe("aborted");
    const requestId = t.calls[0].requestId;
    expect(t.posts).toContainEqual(["abort", undefined, requestId]);
    expect(
      t.getState().session.history.some((h) => h.conversationSummary),
    ).toBe(false);
    expect(t.getState().session.compactionLoading).toEqual({});
  });

  it("leaves the drop as the fallback when the summary fails", async () => {
    const t = setup(loopState(21));
    t.answerWith(async () => ({ error: "server gone", aborted: false }));
    expect(await t.run()).toBe("failed");
    expect(
      t.getState().session.history.some((h) => h.conversationSummary),
    ).toBe(false);
  });
});

describe("the tool loop compacts instead of dropping (C117)", () => {
  it("saves the summary before the request that follows the tool result", async () => {
    const t = setup(loopState(21, strata, { open: true }));
    await t.dispatch(streamResponseAfterToolCall({ toolCallId: "c20" }));
    expect(t.calls).toHaveLength(1);
    expect(nextRequests).toHaveLength(1);
    const sent = nextRequests[0].history;
    // The tool result went in, then the summary, then the request
    expect(sent.at(-1)?.message.role).toBe("tool");
    expect(sent.some((h) => h.conversationSummary)).toBe(true);
  });

  it("goes straight on below the threshold, with no summary request", async () => {
    const t = setup(loopState(12, strata, { open: true }));
    await t.dispatch(streamResponseAfterToolCall({ toolCallId: "c11" }));
    expect(t.calls).toHaveLength(0);
    expect(nextRequests).toHaveLength(1);
    expect(nextRequests[0].history.some((h) => h.conversationSummary)).toBe(
      false,
    );
  });

  it("does not send the next request after Stop during the summary", async () => {
    const t = setup(loopState(21, strata, { open: true }));
    t.answerWith(async () => {
      t.getState().session.streamAborter.abort();
      return { error: "aborted", aborted: true };
    });
    await t.dispatch(streamResponseAfterToolCall({ toolCallId: "c20" }));
    expect(nextRequests).toHaveLength(0);
  });

  it("compacts a loop's next message too, which is never held", async () => {
    const t = setup(loopState(21));
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Next item" }] },
      ],
    };
    await t.dispatch(
      streamResponseThunk({
        editorState: doc,
        modifiers: { useCodebase: false, noContext: true },
      }),
    );
    expect(t.getState().session.compactionHold).toBeUndefined();
    expect(t.calls).toHaveLength(1);
    expect(nextRequests).toHaveLength(1);
    // The summary request started with the previous request's prompt,
    // before the new message
    expect(JSON.stringify(t.calls[0].prefix)).not.toContain("Next item");
    const sent = nextRequests[0].history;
    expect(sent.at(-2)?.message.role).toBe("user");
    expect(sent.some((h) => h.conversationSummary)).toBe(true);
  });
});
