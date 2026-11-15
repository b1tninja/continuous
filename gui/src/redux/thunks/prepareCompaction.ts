import { createAsyncThunk, createNextState } from "@reduxjs/toolkit";
import type { ModelDescription } from "core";
import { computeContextBreakdown } from "core/llm/contextBreakdown";
import { prewarmAllowed, prewarmSetting } from "core/llm/localPrewarm";
import { isLocalApiBase } from "core/llm/localServers";
import {
  COMPACTION_THRESHOLDS,
  type CompactionPlan,
  firstAfterSummary,
  isCompactionPlan,
  planCompaction,
  type PlanCompactionInput,
} from "core/util/compactionPlan";
import {
  type CompactionPlanSizes,
  planSizesFrom,
} from "core/util/compactionEstimate";
import { renderChatMessage } from "core/util/messageContent";
import { useEffect } from "react";
import { useStore } from "react-redux";
import { v4 as uuidv4 } from "uuid";
import {
  type CompactionPrefix,
  compactionPrefix,
} from "../../util/compactionPrefix";
import {
  INITIAL_PROMPT_CACHE_STATE,
  resolvePromptCache,
} from "../../util/promptCache";
import { selectSelectedChatModel } from "../slices/configSlice";
import { selectCacheSetting } from "../selectors/selectCacheSetting";
import {
  applyPreparedSummary,
  applySummaryToSession,
  type PreparedCompaction,
  setCompactionPlan,
  setPreparedCompaction,
} from "../slices/sessionSlice";
import type {
  AppThunkDispatch,
  RootState,
  ThunkApiType,
  ThunkExtrasType,
} from "../store";
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
  return measuredConversation(state);
}

/**
 * The sizes Compact now works with (C107's estimate): the current plan's, or
 * with no plan (below the prepare threshold, or planned compaction off)
 * everything after the newest summary as the span and no tail, which is what
 * Compact now summarises then. Undefined with no model or window.
 */
export function compactionSizes(
  state: RootState,
): CompactionPlanSizes | undefined {
  const plan = currentCompactionPlan(state);
  if (plan) {
    return planSizesFrom({
      headTokens: plan.tokens.head,
      spanTokens: plan.tokens.span,
      tailTokens: plan.tokens.tail,
    });
  }
  const input = measuredConversation(state);
  if (!input) return undefined;
  const span = input.itemTokens.reduce((a, b) => a + b, 0);
  return planSizesFrom({
    headTokens: input.headTokens,
    spanTokens: span,
    tailTokens: 0,
  });
}

/**
 * Each item's size and the head's, estimated as the context meter does and
 * scaled to the provider's count for the last request: on a local server
 * that count is the one C102's usage calibration learns from, so the plan
 * is sized in the server's tokens.
 */
function measuredConversation(
  state: RootState,
): Omit<PlanCompactionInput, "previous"> | undefined {
  const model = selectSelectedChatModel(state);
  if (!model) return undefined;
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
 * The session as it will be once `summary` is saved on item `index`: what
 * the next real request is built from (applySummaryToSession, the same
 * function the reducer runs).
 */
export function stateAfterCompaction(
  state: RootState,
  index: number,
  summary: string,
): RootState {
  return {
    ...state,
    session: createNextState(state.session, (draft) => {
      applySummaryToSession(draft as RootState["session"], index, summary);
    }),
  };
}

/**
 * The request the chat will send after the summary is saved, up to the
 * person's next message: buildChatRequest on that session, with the cache
 * options streamNormalInput adds. The task list goes after the next message,
 * so it is not part of it.
 */
export function compactedRequest(
  state: RootState,
  index: number,
  summary: string,
  now = Date.now(),
): CompactionPrefix | undefined {
  const after = stateAfterCompaction(state, index, summary);
  try {
    const request = buildChatRequest(after, after.session.history, now);
    const cache = resolvePromptCache(
      request.model,
      selectCacheSetting(after),
      after.session.promptCache ?? INITIAL_PROMPT_CACHE_STATE,
      now,
      after.session.mode,
    );
    return {
      messages: request.messages,
      options: { ...request.completionOptions, ...cache.options },
    };
  } catch {
    return undefined;
  }
}

/** A tool call waiting for approval or still running: the turn is not over. */
function turnUnfinished(state: RootState): boolean {
  const last = state.session.history[state.session.history.length - 1];
  return !!last?.toolCallStates?.some(
    (t) =>
      t.status === "generating" ||
      t.status === "generated" ||
      t.status === "calling",
  );
}

/** Rough tokens of a summary, before the provider has counted it. */
const summaryTokens = (summary: string) => Math.ceil(summary.length / 4);

/**
 * The pre-warm of `[head][summary][tail]` (C106): once a summary is ready and
 * the person is still idle, the compacted request is sent to the local
 * server with one output token (core/llm/localPrewarm.ts), so applying the
 * summary at the next turn re-reads nothing. Only for a local model and
 * `contextManagement.prewarm` other than "off". `signal` is the preparer's:
 * typing, sending or a tool call aborts it, and the next idle tries again.
 */
export async function prewarmPreparedCompaction(args: {
  plan: CompactionPlan;
  prepared: PreparedCompaction;
  dispatch: AppThunkDispatch;
  getState: () => RootState;
  extra: ThunkExtrasType;
  signal?: AbortSignal;
}): Promise<void> {
  const { plan, prepared, dispatch, getState, extra, signal } = args;
  const state = getState();
  const model = selectSelectedChatModel(state);
  if (!model || prepared.summary === undefined || prepared.dismissed) return;
  if (!prewarmAllowed(prewarmSetting(model), isLocalModel(model))) return;
  if (signal?.aborted || chatIsBusy(state) || turnUnfinished(state)) return;
  const request = compactedRequest(state, plan.spanEnd - 1, prepared.summary);
  if (!request) return;

  const requestId = uuidv4();
  const current = () => {
    const now = getState().session.preparedCompaction;
    return now?.planId === prepared.planId && now.status === "ready"
      ? now
      : undefined;
  };
  dispatch(
    setPreparedCompaction({
      ...prepared,
      prewarm: { status: "running", requestId },
    }),
  );
  const onAbort = () => extra.ideMessenger.post("abort", undefined, requestId);
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await extra.ideMessenger.request("llm/prewarm", {
      messages: request.messages,
      options: request.options,
      promptTokens:
        plan.tokens.head + summaryTokens(prepared.summary) + plan.tokens.tail,
      liveTokens: plan.tokens.total,
      requestId,
    });
    const now = current();
    if (!now || now.prewarm?.requestId !== requestId) return;
    const result = response.status === "success" ? response.content : undefined;
    if (signal?.aborted || result?.status !== "sent") {
      // Aborted: forgotten, so the next idle tries again. Skipped: kept with
      // why, so the notice can say it and it is not asked again.
      const skipped =
        !signal?.aborted &&
        result?.status === "skipped" &&
        result.reason !== "aborted";
      dispatch(
        setPreparedCompaction({
          ...now,
          prewarm:
            skipped && result?.status === "skipped"
              ? { status: "skipped", detail: result.detail }
              : undefined,
        }),
      );
      return;
    }
    dispatch(setPreparedCompaction({ ...now, prewarm: { status: "done" } }));
  } catch (e) {
    // The IDE could not be asked: as a skip, so it is not asked again
    const now = current();
    if (now?.prewarm?.requestId === requestId) {
      dispatch(
        setPreparedCompaction({
          ...now,
          prewarm: {
            status: "skipped",
            detail: e instanceof Error ? e.message : String(e),
          },
        }),
      );
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The prepared summary the next turn saves on its own, if any: ready for the
 * current plan, not put off with Not now, and either pre-warmed (the local
 * server already read the compacted prompt, so nothing is read again) or on
 * a cloud provider (where the next request writes the cache anyway). On a
 * local server without a pre-warm it waits instead, so nothing is re-read
 * unexpectedly at the prepare threshold: Compact now applies it, and so does
 * the forced-path hold's Compact now once the prompt reaches the force
 * threshold (util/compactionHold.ts).
 */
export function preparedAppliesAtTurn(
  state: RootState,
): { index: number; summary: string } | undefined {
  const prepared = state.session.preparedCompaction;
  if (!prepared || prepared.dismissed) return undefined;
  const model = selectSelectedChatModel(state);
  if (!model) return undefined;
  if (isLocalModel(model) && prepared.prewarm?.status !== "done") {
    return undefined;
  }
  return usablePreparedCompaction(state, state.session.history.length - 1);
}

/**
 * At the start of the person's next turn: the summary `preparedAppliesAtTurn`
 * names is saved, before their message is added (decision D3, "apply at the
 * next turn"). Returns whether it was applied.
 */
export function applyPreparedCompactionForTurn(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
): boolean {
  // A plain function, not a thunk: a turn with nothing to apply dispatches
  // nothing
  const usable = preparedAppliesAtTurn(getState());
  if (!usable) return false;
  dispatch(applyPreparedSummary(usable));
  return true;
}

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
    if (existing.status !== "ready") return "busy";
    // A pre-warm stopped by activity is tried again at the next idle
    if (!existing.prewarm) {
      await prewarmPreparedCompaction({
        plan,
        prepared: existing,
        dispatch,
        getState,
        extra,
        signal: args?.signal,
      });
    }
    return "already-prepared";
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
    await prewarmPreparedCompaction({
      plan,
      prepared,
      dispatch,
      getState,
      extra,
      signal,
    });
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
