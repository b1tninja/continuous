import type { LoopState, Usage } from "core/index.js";
import {
  itemBudgetNoteDue,
  itemBudgetStatus,
  overBudgetReport,
  type BreachKind,
  type ItemBudgetBreach,
} from "core/util/itemBudget.js";
import { loopBudgetStop, stopLoop } from "core/util/loopMode.js";

import { services } from "../services/index.js";
import { getSessionLoop, getSessionTaskPlan } from "../session.js";

import {
  CLI_LOOP_TOOL_NAMES,
  commitLoop,
  sessionCostMark,
  sessionTokens,
} from "./loopSession.js";

function counted(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

/**
 * Usage added between two session totals. Cached tokens stay in the
 * details, so the budget can subtract them the same way as an inline run.
 */
export function usageSince(baseline: Usage, current: Usage): Usage {
  const cached = Math.max(
    0,
    counted(current.promptTokensDetails?.cachedTokens) -
      counted(baseline.promptTokensDetails?.cachedTokens),
  );
  const written = Math.max(
    0,
    counted(current.promptTokensDetails?.cacheWriteTokens) -
      counted(baseline.promptTokensDetails?.cacheWriteTokens),
  );
  return {
    promptTokens: Math.max(
      0,
      counted(current.promptTokens) - counted(baseline.promptTokens),
    ),
    completionTokens: Math.max(
      0,
      counted(current.completionTokens) - counted(baseline.completionTokens),
    ),
    ...((cached || written) && {
      promptTokensDetails: {
        ...(cached ? { cachedTokens: cached } : {}),
        ...(written ? { cacheWriteTokens: written } : {}),
      },
    }),
  };
}

/**
 * An item run's request loop: stop the loop when the token or time budget
 * is already spent, so one item cannot keep requesting past it. Between
 * items, decideNext checks the same budget. Returns whether it stopped.
 */
export function stopLoopItemOverBudget(now = new Date()): boolean {
  const loop = getSessionLoop();
  if (!loop || loop.status === "stopped" || loop.current?.kind !== "item") {
    return false;
  }
  const stop = loopBudgetStop(loop, { now, sessionTokens: sessionTokens() });
  if (!stop) return false;
  commitLoop(stopLoop(loop, stop.reason, stop.detail, stop.budget));
  return true;
}

/** Model requests the running item has made so far in this run. */
export function itemRunTurns(loop: LoopState): number {
  const current = loop.current;
  if (!current) return 0;
  try {
    return services.chatHistory
      .getHistory()
      .slice(current.historyIndex)
      .filter((h) => h.message.role === "assistant").length;
  } catch {
    return 0;
  }
}

/** The running item and where it stands against its own budget now. */
function runningItemStatus(
  loop: LoopState,
  now: Date,
  told?: readonly BreachKind[],
) {
  const current = loop.current;
  if (!current || current.kind !== "item" || current.report) return undefined;
  const item = getSessionTaskPlan()?.items.find((t) => t.id === current.itemId);
  if (!item?.budget) return undefined;
  return itemBudgetStatus(loop, item, {
    sessionTokens: sessionTokens(),
    costMark: sessionCostMark(),
    now,
    turns: itemRunTurns(loop),
    told,
  });
}

/** The item's own limit the running item has gone over (not reported yet), if any. */
export function itemOverBudget(
  loop: LoopState,
  now = new Date(),
): ItemBudgetBreach | undefined {
  const status = runningItemStatus(loop, now);
  return status?.state === "over"
    ? { which: status.which, used: status.used, limit: status.limit }
    : undefined;
}

/**
 * Between two model requests of an item's run: ends the run over its item's
 * own budget (turns, tokens or time), its work kept, as the IDE does. The run
 * is recorded as over budget with its report; the caller ends the turn and the
 * driver goes on to the next item. Returns whether it ended the run.
 */
export function endItemRunOverBudget(now = new Date()): boolean {
  const loop = getSessionLoop();
  if (!loop || loop.status === "stopped" || !loop.current) return false;
  const breach = itemOverBudget(loop, now);
  if (!breach) return false;
  commitLoop({
    ...loop,
    current: {
      ...loop.current,
      overBudget: breach,
      report: overBudgetReport(breach),
    },
  });
  return true;
}

/**
 * The 80% note for the batch of tool results just made: once per limit per
 * run, recorded on the run. The caller appends it to the last tool result
 * (never the system prompt, which would break the cached prefix).
 */
export function itemBudgetNoteNow(now = new Date()): string | undefined {
  const loop = getSessionLoop();
  if (!loop?.current) return undefined;
  const status = runningItemStatus(loop, now, loop.current.budgetWarned);
  if (!status) return undefined;
  const due = itemBudgetNoteDue(status, CLI_LOOP_TOOL_NAMES.finishItem);
  if (!due) return undefined;
  commitLoop({
    ...loop,
    current: {
      ...loop.current,
      budgetWarned: [...(loop.current.budgetWarned ?? []), due.kind],
    },
  });
  return due.note;
}
