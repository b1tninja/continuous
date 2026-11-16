import type { ModelDescription } from "core";
import type { CompactionPlan } from "core/util/compactionPlan";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import type { CompactionPrefix } from "../../util/compactionPrefix";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  applyPreparedSummary,
  setCompactionLoading,
  setCompactionPlan,
} from "../slices/sessionSlice";
import type { AppThunkDispatch, RootState, ThunkExtrasType } from "../store";
import { buildChatRequest } from "../util/buildChatRequest";
import {
  currentCompactionPlan,
  forceAtTokens,
  isLocalModel,
  usablePreparedCompaction,
  withQuotedRequest,
} from "./prepareCompaction";
import { checkpointSession } from "./session";

/**
 * Compaction between tool rounds (plans/research/cache-friendly-context-trimming.md
 * section 6.5, row C117).
 *
 * The forced-path hold (util/compactionHold.ts) waits only for the person's
 * own message from the chat input. An agent loop sends its next request after
 * every tool result with nobody asked, and the background summary
 * (prepareCompaction.ts) waits for 10 s with nothing running, which a loop
 * never gives it. So a long loop crossed the force threshold between two tool
 * rounds and C101 dropped the oldest block in silence: everything after the
 * head read again, about 70 s for 320k tokens on the owner's Strata.
 *
 * Now, before the request that follows a tool result (and before a loop's or
 * a resumed turn's message, which are never held either), a prompt at the
 * force threshold, or one already being pruned, compacts instead:
 *
 *  - a summary ready for the current plan is saved at once, no request;
 *  - otherwise, on a local server, the summary is made now, as Compact now
 *    makes it, from the last request's own prompt, which the server still
 *    holds: no re-read, about 6k tokens of output. "Generating conversation
 *    summary" shows where it goes, and Stop stops it with the turn;
 *  - on a cloud provider, where the summary costs money, only a ready one is
 *    used (budgets are C114).
 *
 * Nothing asks: the loop goes on, on `[head][summary][tail]`, which is one
 * read of the summary and the tail instead of the whole conversation, and
 * stays well under the force threshold for a long while. When no summary can
 * be had (planned compaction off, the plan's hold answered Continue anyway, no
 * boundary, the request failed) the block drop stays the fallback.
 */
export type ToolRoundCompaction =
  "none" | "applied-prepared" | "summarized" | "aborted" | "failed";

export interface ToolRoundCompactionNeed {
  plan: CompactionPlan;
  model: ModelDescription;
  /** A summary ready for the plan, saved with no request. */
  prepared?: { index: number; summary: string };
}

/**
 * Whether the next request, carrying `newTokens` more than the history, would
 * be cut by the block drop, and a compaction could stand in for it.
 */
export function toolRoundCompactionNeed(
  state: RootState,
  newTokens = 0,
): ToolRoundCompactionNeed | undefined {
  const model = selectSelectedChatModel(state);
  if (!model) return undefined;
  // Undefined with planned compaction off, below the prepare threshold, or
  // with nothing before the tail to summarise
  const plan = currentCompactionPlan(state);
  if (!plan) return undefined;
  // The person chose the drop for this plan at the hold
  if (state.session.compactionHoldContinued === plan.id) return undefined;
  const total = plan.tokens.total + Math.max(0, newTokens);
  if (!state.session.isPruned && total < forceAtTokens(plan, model)) {
    return undefined;
  }
  const prepared = usablePreparedCompaction(
    state,
    state.session.history.length - 1,
  );
  return { plan, model, ...(prepared && { prepared }) };
}

/**
 * The prompt of the request that produced the newest answer: the history up
 * to that answer, built as it was sent. The server still holds it, so a
 * summary request that starts with it reads nothing again. Not after a pruned
 * request, whose messages differ from the history.
 */
export function lastRequestPrefix(
  state: RootState,
): CompactionPrefix | undefined {
  if (state.session.isPruned) return undefined;
  const history = state.session.history;
  // At the start of a turn the newest item is the empty answer the reply
  // will stream into; the request before it made the one before that
  let answer = history.length - 1;
  const newest = history[answer]?.message;
  if (
    newest?.role === "assistant" &&
    !newest.toolCalls?.length &&
    !renderChatMessage(newest).trim()
  ) {
    answer--;
  }
  while (answer >= 0 && history[answer].message.role !== "assistant") answer--;
  if (answer <= 0) return undefined;
  try {
    const request = buildChatRequest(state, history.slice(0, answer));
    return {
      messages: request.messages,
      options: request.completionOptions,
    };
  } catch {
    return undefined;
  }
}

/**
 * At a tool-round boundary (or the start of a turn nobody is asked about):
 * compacts as `need` (from `toolRoundCompactionNeed`) says. `signal` is the
 * turn's: Stop aborts the summary, and the turn ends as Stop always ends it.
 * Callers check the need first, so a round with nothing to do stays
 * synchronous.
 */
export async function compactAtToolRound(args: {
  need: ToolRoundCompactionNeed;
  dispatch: AppThunkDispatch;
  getState: () => RootState;
  extra: ThunkExtrasType;
  signal?: AbortSignal;
}): Promise<ToolRoundCompaction> {
  const { need, dispatch, getState, extra, signal } = args;
  if (need.prepared) {
    dispatch(applyPreparedSummary(need.prepared));
    void checkpointSession(getState, extra.ideMessenger);
    return "applied-prepared";
  }
  // A cloud summary costs money; only a ready one is used (C114)
  if (!isLocalModel(need.model)) return "none";

  const { plan } = need;
  const index = plan.spanEnd - 1;
  const state = getState();
  const sessionId = state.session.id;
  const prefix = lastRequestPrefix(state);
  const requestId = uuidv4();
  const onAbort = () => extra.ideMessenger.post("abort", undefined, requestId);
  signal?.addEventListener("abort", onAbort);
  dispatch(setCompactionPlan(plan));
  dispatch(setCompactionLoading({ index, loading: true }));
  try {
    // Core reads the span's last message from the saved session
    await checkpointSession(getState, extra.ideMessenger);
    if (signal?.aborted) return "aborted";
    const response = await extra.ideMessenger.request(
      "conversation/summarize",
      { sessionId, index, prefix, requestId },
    );
    if (signal?.aborted) return "aborted";
    const content =
      response.status === "success" ? response.content : undefined;
    if (!content || !("summary" in content) || !content.summary.trim()) {
      return content && "aborted" in content && content.aborted
        ? "aborted"
        : "failed";
    }
    // Nothing should move the span during the request, but if it did the
    // summary describes another one
    const after = getState();
    if (
      after.session.id !== sessionId ||
      currentCompactionPlan(after)?.id !== plan.id
    ) {
      return "failed";
    }
    dispatch(
      applyPreparedSummary({
        index,
        summary: withQuotedRequest(after, plan, content.summary),
      }),
    );
    void checkpointSession(getState, extra.ideMessenger);
    return "summarized";
  } catch {
    return "failed";
  } finally {
    signal?.removeEventListener("abort", onAbort);
    dispatch(setCompactionLoading({ index, loading: false }));
  }
}
