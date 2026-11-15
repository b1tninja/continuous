import { createAsyncThunk } from "@reduxjs/toolkit";
import type { ModelDescription } from "core";
import { computeContextBreakdown } from "core/llm/contextBreakdown";
import { isLocalApiBase } from "core/llm/localServers";
import {
  COMPACTION_THRESHOLDS,
  type CompactionPlan,
  firstAfterSummary,
  isCompactionPlan,
  planCompaction,
  type PlanCompactionInput,
} from "core/util/compactionPlan";
import { renderChatMessage } from "core/util/messageContent";
import { useEffect } from "react";
import { useStore } from "react-redux";
import { v4 as uuidv4 } from "uuid";
import {
  type CompactionPrefix,
  compactionPrefix,
} from "../../util/compactionPrefix";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  type PreparedCompaction,
  setCompactionPlan,
  setPreparedCompaction,
} from "../slices/sessionSlice";
import type { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { buildChatRequest } from "../util/buildChatRequest";
import { describeChatRequest } from "../util/describeChatRequest";

/**
 * Planned compaction in the IDE (plans/research/cache-friendly-context-trimming.md
 * section 6.2, row C105).
 *
 * Once the conversation crosses the prepare threshold, the planner
 * (core/util/compactionPlan.ts) fixes a boundary. After PREPARE_IDLE_MS with
 * nothing streaming and no typing, the summary of the span before it is made
 * with the existing compaction request ("conversation/summarize", the same
 * path as Compact) as a separate request: nothing in the chat changes. Typing,
 * sending or a tool call aborts it, and it is tried again at the next idle.
 * The result is kept on the session (`preparedCompaction`) for its plan id,
 * and "Compact now" saves it at once (util/compactConversation.ts).
 *
 * The compacted turns stay in the saved session: a summary is stored on the
 * span's last item and only changes what is sent (constructMessages).
 */

/** How long nothing must happen before the summary is made. */
export const PREPARE_IDLE_MS = 10_000;

/** Providers that run on this machine when no apiBase is configured. */
const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llama.cpp",
  "llamafile",
  "lemonade",
]);

/** A server on this machine or network (decision D3's "local"). */
export function isLocalModel(model: ModelDescription): boolean {
  if (model.apiBase) return isLocalApiBase(model.apiBase);
  return LOCAL_PROVIDERS.has(model.provider);
}

/**
 * `contextManagement.plannedCompaction` (D6). Unset, it is on for a local
 * server and off for cloud providers, where the background summary costs
 * money (the cloud slice is C109/C114).
 */
export function plannedCompactionEnabled(model: ModelDescription): boolean {
  return model.contextManagement?.plannedCompaction ?? isLocalModel(model);
}

/** A ratio from estimate to the provider's count outside this is not used. */
const MAX_SCALE = 2;

/**
 * The planner's input from the session: each item's size and the head's,
 * estimated the way the context meter estimates them and scaled to the
 * provider's count for the last request. Undefined when planned compaction is
 * off, or there is no model or window.
 */
export function compactionPlanInput(
  state: RootState,
): Omit<PlanCompactionInput, "previous"> | undefined {
  const model = selectSelectedChatModel(state);
  if (!model || !plannedCompactionEnabled(model)) return undefined;
  const window = model.contextLength;
  if (!window || window <= 0) return undefined;

  const history = state.session.history;
  const start = firstAfterSummary(history);
  const estimates = history.map((item, i) =>
    i < start
      ? 0
      : computeContextBreakdown({ segments: [], history: [item] })
          .estimatedTokens,
  );
  let head = 0;
  try {
    for (const segment of describeChatRequest(state)) {
      if (segment.region !== "history") head += segment.tokens;
    }
  } catch {
    // No request can be built: only the history is counted
  }

  // The provider's count of the last request, when it is close enough to the
  // estimate to describe this conversation (after a compaction it does not)
  const last = state.session.usage?.lastRequest;
  const estimated = head + estimates.reduce((a, b) => a + b, 0);
  const ratio =
    last && estimated > 0
      ? (last.inputTokens + last.outputTokens) / estimated
      : 1;
  const factor = ratio >= 1 / MAX_SCALE && ratio <= MAX_SCALE ? ratio : 1;

  return {
    history,
    itemTokens: estimates.map((t) => Math.round(t * factor)),
    headTokens: Math.round(head * factor),
    window,
    thresholds: isLocalModel(model)
      ? COMPACTION_THRESHOLDS.local
      : COMPACTION_THRESHOLDS.cloud,
    modelKey: `${model.provider}/${model.model}`,
  };
}

/** The plan for the session as it stands, keeping the stored boundary. */
export function currentCompactionPlan(
  state: RootState,
): CompactionPlan | undefined {
  const input = compactionPlanInput(state);
  if (!input) return undefined;
  const result = planCompaction({
    ...input,
    previous: state.session.compactionPlan,
  });
  return isCompactionPlan(result) ? result : undefined;
}

/**
 * The prepared summary "Compact now" can save at once: ready, made for the
 * current plan, and asked for either as the whole conversation (Compact now)
 * or at the plan's own boundary. Returns where to store it.
 */
export function usablePreparedCompaction(
  state: RootState,
  index: number,
): { index: number; summary: string } | undefined {
  const prepared = state.session.preparedCompaction;
  if (prepared?.status !== "ready" || prepared.summary === undefined) {
    return undefined;
  }
  if (prepared.sessionId !== state.session.id) return undefined;
  const plan = currentCompactionPlan(state);
  if (!plan || plan.id !== prepared.planId) return undefined;
  const last = state.session.history.length - 1;
  if (index !== last && index !== plan.spanEnd - 1) return undefined;
  return { index: plan.spanEnd - 1, summary: prepared.summary };
}

/**
 * The summary request's prefix: the conversation's own last request, so the
 * server reads it from its prompt cache instead of the history being read
 * again. A local server caches any prefix; a cloud provider only while its
 * cache is warm, which compactionPrefix checks. Not sent after a pruned
 * request, whose messages differ from the history.
 */
function summaryPrefix(
  state: RootState,
  model: ModelDescription,
): CompactionPrefix | undefined {
  if (state.session.isPruned) return undefined;
  if (!isLocalModel(model)) {
    return compactionPrefix(
      state,
      state.session.history.length - 1,
      Date.now(),
    );
  }
  try {
    const request = buildChatRequest(state);
    return {
      messages: request.messages,
      options: request.completionOptions,
    };
  } catch {
    return undefined;
  }
}

/** Decision in section 6.1: a short first request is quoted word for word. */
function withQuotedRequest(
  state: RootState,
  plan: CompactionPlan,
  summary: string,
): string {
  if (plan.quoteFirstUser === undefined) return summary;
  const first = state.session.history[plan.quoteFirstUser];
  const text = first ? renderChatMessage(first.message).trim() : "";
  if (!text) return summary;
  return `The conversation began with this request, quoted word for word:\n\n${text}\n\n${summary}`;
}

/**
 * Where the pre-warm of `[head][summary][tail]` plugs in (C106): called once
 * when a summary is ready. Nothing for now.
 */
export function prewarmPreparedCompaction(_args: {
  plan: CompactionPlan;
  prepared: PreparedCompaction;
  dispatch: AppThunkDispatch;
  getState: () => RootState;
}): void {}

export type PrepareCompactionResult =
  | "ready"
  | "already-prepared"
  | "no-plan"
  | "busy"
  | "aborted"
  | "stale"
  | "failed";

/**
 * Makes the summary of the current plan's span, unless it is already made.
 * `signal` aborts the request; the partial result is discarded.
 */
export const prepareCompaction = createAsyncThunk<
  PrepareCompactionResult,
  { signal?: AbortSignal } | undefined,
  ThunkApiType
>("session/prepareCompaction", async (args, { dispatch, getState, extra }) => {
  const state = getState();
  if (state.session.isStreaming) return "busy";
  const model = selectSelectedChatModel(state);
  const plan = currentCompactionPlan(state);
  if (!model || !plan) return "no-plan";
  const existing = state.session.preparedCompaction;
  if (existing?.planId === plan.id && existing.sessionId === state.session.id) {
    return existing.status === "ready" ? "already-prepared" : "busy";
  }

  const requestId = uuidv4();
  const sessionId = state.session.id;
  const running: PreparedCompaction = {
    sessionId,
    planId: plan.id,
    spanStart: plan.spanStart,
    spanEnd: plan.spanEnd,
    status: "running",
    requestId,
  };
  dispatch(setCompactionPlan(plan));
  dispatch(setPreparedCompaction(running));

  const signal = args?.signal;
  const onAbort = () => extra.ideMessenger.post("abort", undefined, requestId);
  signal?.addEventListener("abort", onAbort);
  const clearRunning = () => {
    const now = getState().session.preparedCompaction;
    if (now?.requestId === requestId && now.status === "running") {
      dispatch(setPreparedCompaction(undefined));
    }
  };
  try {
    const response = await extra.ideMessenger.request(
      "conversation/summarize",
      {
        sessionId,
        index: plan.spanEnd - 1,
        prefix: summaryPrefix(state, model),
        requestId,
      },
    );
    if (signal?.aborted) {
      clearRunning();
      return "aborted";
    }
    const content =
      response.status === "success" ? response.content : undefined;
    if (!content || !("summary" in content) || !content.summary.trim()) {
      clearRunning();
      return content && "aborted" in content && content.aborted
        ? "aborted"
        : "failed";
    }
    // The span changed while the summary was made: it describes another one
    const after = getState();
    const stillPlan = currentCompactionPlan(after);
    if (after.session.id !== sessionId || stillPlan?.id !== plan.id) {
      clearRunning();
      return "stale";
    }
    const prepared: PreparedCompaction = {
      ...running,
      status: "ready",
      summary: withQuotedRequest(after, plan, content.summary),
      preparedAt: Date.now(),
    };
    dispatch(setPreparedCompaction(prepared));
    prewarmPreparedCompaction({ plan, prepared, dispatch, getState });
    return "ready";
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
});

export interface CompactionPreparerStore {
  getState: () => RootState;
  dispatch: AppThunkDispatch;
  subscribe: (listener: () => void) => () => void;
}

export interface CompactionPreparer {
  /** Typing or another sign the person is active: abort, wait again. */
  noteActivity(): void;
  stop(): void;
}

/** A reply streaming, or a tool running: the server is the chat's. */
export function chatIsBusy(state: RootState): boolean {
  if (state.session.isStreaming) return true;
  const last = state.session.history[state.session.history.length - 1];
  return !!last?.toolCallStates?.some((t) => t.status === "calling");
}

/**
 * Watches the session: keeps the plan current while the chat is not busy, and
 * runs prepareCompaction after `idleMs` of quiet. Streaming, a running tool,
 * typing, or a change to the plan aborts a running summary; the next quiet
 * period tries again. A summary that failed is not retried until something
 * happens, so a server that is down is not asked every ten seconds.
 */
export function startCompactionPreparer(
  store: CompactionPreparerStore,
  idleMs = PREPARE_IDLE_MS,
): CompactionPreparer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | undefined;
  let seen: { history: unknown; busy: boolean; model: unknown; id: string } = {
    history: undefined,
    busy: false,
    model: undefined,
    id: "",
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    timer = setTimeout(() => void fire(), idleMs);
  };
  /** Aborts the running summary and forgets it, so the next idle can retry. */
  const cancel = () => {
    if (!running) return;
    running.abort();
    running = undefined;
    if (store.getState().session.preparedCompaction?.status === "running") {
      store.dispatch(setPreparedCompaction(undefined));
    }
  };

  const fire = async () => {
    timer = undefined;
    if (running || chatIsBusy(store.getState())) return;
    const mine = new AbortController();
    running = mine;
    try {
      await store.dispatch(prepareCompaction({ signal: mine.signal }));
    } finally {
      if (running === mine) running = undefined;
    }
  };

  /** Keeps the stored plan current and drops a summary made for another. */
  const refreshPlan = () => {
    const state = store.getState();
    const plan = currentCompactionPlan(state);
    const stored = state.session.compactionPlan;
    if (
      plan?.id !== stored?.id ||
      plan?.state !== stored?.state ||
      plan?.tokens.total !== stored?.tokens.total
    ) {
      store.dispatch(setCompactionPlan(plan));
    }
    const prepared = store.getState().session.preparedCompaction;
    if (prepared && prepared.planId !== plan?.id) {
      // The span was edited, or the plan applied or gone
      cancel();
      store.dispatch(setPreparedCompaction(undefined));
    }
  };

  const onChange = () => {
    const state = store.getState();
    const now = {
      history: state.session.history,
      busy: chatIsBusy(state),
      model: selectSelectedChatModel(state),
      id: state.session.id,
    };
    if (
      now.history === seen.history &&
      now.busy === seen.busy &&
      now.model === seen.model &&
      now.id === seen.id
    ) {
      return;
    }
    seen = now;
    if (now.busy) {
      cancel();
      clearTimer();
      return;
    }
    refreshPlan();
    schedule();
  };

  const unsubscribe = store.subscribe(onChange);
  onChange();

  return {
    noteActivity() {
      cancel();
      if (!chatIsBusy(store.getState())) schedule();
    },
    stop() {
      unsubscribe();
      cancel();
      clearTimer();
    },
  };
}

/**
 * Mounts planned compaction for the chat: the preparer, with key presses and
 * pastes anywhere in the chat window as activity.
 */
export function usePlannedCompaction(): void {
  const store = useStore<RootState>();
  useEffect(() => {
    const preparer = startCompactionPreparer({
      getState: store.getState,
      dispatch: store.dispatch as AppThunkDispatch,
      subscribe: store.subscribe,
    });
    const onActivity = () => preparer.noteActivity();
    window.addEventListener("keydown", onActivity, true);
    window.addEventListener("paste", onActivity, true);
    return () => {
      window.removeEventListener("keydown", onActivity, true);
      window.removeEventListener("paste", onActivity, true);
      preparer.stop();
    };
  }, [store]);
}
