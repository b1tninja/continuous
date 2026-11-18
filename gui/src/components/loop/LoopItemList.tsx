import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import type {
  LoopCheckResult,
  LoopItemModel,
  LoopParallelRun,
  LoopState,
  TaskItem,
  TaskPlan,
} from "core";
import { describeBreach } from "core/util/itemBudget";
import {
  blockingDependencies,
  LOOP_AUTONOMY,
  unmetDependencies,
} from "core/util/loopMode";
import { formatCostAmount } from "core/util/costOf";
import { costMarkOf, dollarBudgetNote, itemCostNow } from "core/util/loopCost";
import { formatDuration, formatTokenCount } from "core/util/loopUsage";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  runLoopItemAgainThunk,
  skipLoopItemThunk,
} from "../../redux/thunks/loop";
import { stopLoopWorker } from "../../util/subagents/loopWorkers";

const BUTTON =
  "shrink-0 cursor-pointer rounded border border-solid border-border bg-transparent px-2 py-1 text-xs text-foreground hover:bg-input";

function statusLabel(loop: LoopState, itemId: string): string {
  const state = loop.items.find((i) => i.id === itemId);
  if (!state) return "";
  if (state.skipped) return "skipped";
  if (state.again && state.status === "pending") return "to run again";
  switch (state.status) {
    case "checking":
      return loop.current?.kind === "check" && loop.current.itemId === itemId
        ? "checking"
        : "check waits";
    case "running":
      return loop.parallel?.some((r) => r.itemId === itemId)
        ? "running in parallel"
        : "running";
    case "pending":
    case "redo":
    case "done":
    case "waiting":
    case "failed":
      return state.status;
  }
}

/** What the item comes after, while it waits for it: "after 1" or "blocked on 1". */
function dependencyLabel(
  loop: LoopState,
  taskPlan: TaskPlan,
  task: TaskItem,
): string | undefined {
  const state = loop.items.find((i) => i.id === task.id);
  if (state?.status !== "pending" && state?.status !== "redo") return;
  if (state.skipped) return;
  const blocked = blockingDependencies(loop, taskPlan, task);
  if (blocked.length) return `blocked on ${blocked.join(", ")}`;
  const unmet = unmetDependencies(loop, taskPlan, task);
  return unmet.length ? `after ${unmet.join(", ")}` : undefined;
}

const CHECK_LABEL: Record<LoopCheckResult["status"], string> = {
  passed: "check passed",
  failed: "check failed",
  refused: "check not run",
};

/** The item's check and its last result, with a failure's output. */
function CheckLine({
  task,
  check,
}: {
  task: TaskItem;
  check?: LoopCheckResult;
}) {
  if (!task.check && !check) return null;
  const shownCheck = maskCommandForDisplay(task.check ?? check?.command ?? "");
  return (
    <div
      data-testid={`loop-check-${task.id}`}
      className="ml-3 min-w-0 text-2xs text-description"
    >
      <div className="truncate" title={shownCheck}>
        check: <code>{shownCheck}</code>
        {check && (
          <span
            data-testid={`loop-check-result-${task.id}`}
            className={check.status === "failed" ? "text-error" : undefined}
          >
            {" "}
            · {CHECK_LABEL[check.status]}
            {check.status === "refused" && check.output
              ? `: ${maskCommandForDisplay(check.output)}`
              : ""}
          </span>
        )}
      </div>
      {check?.status === "failed" && check.output && (
        <pre
          data-testid={`loop-check-output-${task.id}`}
          className="m-0 max-h-16 overflow-auto break-words whitespace-pre-wrap"
        >
          {maskCommandForDisplay(check.output.trim())}
        </pre>
      )}
    </div>
  );
}

/** The files the to-do declares (TaskItem.files): what a parallel run may change. */
function FilesLine({ task }: { task: TaskItem }) {
  if (!task.files?.length) return null;
  return (
    <div
      data-testid={`loop-files-${task.id}`}
      className="ml-3 min-w-0 truncate text-2xs text-description"
      title="The files this item changes; items with disjoint files may run at the same time"
    >
      files: <code>{task.files.join(", ")}</code>
    </div>
  );
}

/**
 * An item running as a worker of a parallel wave: its worktree, the model it
 * runs on, and a Stop for this worker alone (its item runs again later).
 */
function WorkerLine({
  task,
  run,
  model,
}: {
  task: TaskItem;
  run: LoopParallelRun;
  model?: LoopItemModel;
}) {
  return (
    <div
      data-testid={`loop-worker-${task.id}`}
      className="ml-3 flex min-w-0 items-center gap-1 text-2xs text-description"
    >
      <span className="min-w-0 flex-1 truncate" title={run.worktree}>
        in its own worktree{run.worktree ? `: ${run.worktree}` : ""}
        {model?.title ? ` · ${model.title}` : ""}
      </span>
      <button
        type="button"
        data-testid={`loop-worker-stop-${task.id}`}
        className={BUTTON}
        title="Stop this worker; its changes are dropped and the item runs again later"
        onClick={() => stopLoopWorker(task.id)}
      >
        Stop
      </button>
    </div>
  );
}

/**
 * The model the to-do names (TaskItem.model) and, once a run started, the one
 * it went to when that was not it: the item's own model is not configured.
 */
function ModelLine({ task, model }: { task: TaskItem; model?: LoopItemModel }) {
  if (!task.model) return null;
  return (
    <div
      data-testid={`loop-model-${task.id}`}
      className="ml-3 min-w-0 truncate text-2xs text-description"
      title={model?.fallbackReason ?? "The model this item runs with"}
    >
      model: {task.model}
      {model?.fallbackReason && (
        <span
          data-testid={`loop-model-fallback-${task.id}`}
          className="text-warning"
        >
          {" "}
          · not configured, ran on {model.title}
        </span>
      )}
    </div>
  );
}

/**
 * The item's own budget (TaskItem.budget) with what its runs used and what is
 * left of it; shown when the item has one. An item that ran over says so.
 */
function BudgetLine({
  task,
  state,
  loop,
}: {
  task: TaskItem;
  state: LoopState["items"][number];
  loop: LoopState;
}) {
  const sessionUsage = useAppSelector((s) => s.session.usage);
  const budget = task.budget;
  if (!budget && !state.overBudget) return null;
  const parts: string[] = [];
  const tokens = state.usage?.tokens ?? 0;
  const minutes = (state.usage?.ms ?? 0) / 60_000;
  if (budget?.tokens !== undefined) {
    parts.push(
      `${formatTokenCount(tokens)} of ${formatTokenCount(budget.tokens)} tokens, ${formatTokenCount(Math.max(0, budget.tokens - tokens))} left`,
    );
  }
  if (budget?.minutes !== undefined) {
    parts.push(
      `${formatDuration(minutes * 60_000)} of ${budget.minutes}m, ${formatDuration(Math.max(0, budget.minutes - minutes) * 60_000)} left`,
    );
  }
  if (budget?.turns !== undefined) parts.push(`${budget.turns} turns a run`);
  const cost = itemCostNow(loop, task.id, costMarkOf(sessionUsage));
  if (budget?.usd !== undefined && typeof cost === "number") {
    parts.push(
      `${formatCostAmount(cost)} of ${formatCostAmount(budget.usd)}, ${formatCostAmount(Math.max(0, budget.usd - cost))} left`,
    );
  }
  const costNote = dollarBudgetNote(budget, cost);
  if (costNote) parts.push(costNote);
  return (
    <div
      data-testid={`loop-budget-${task.id}`}
      className="ml-3 min-w-0 truncate text-2xs text-description"
      title="The item's own budget and what is left of it"
    >
      budget: {parts.join(" · ")}
      {state.extensions ? ` · extended ${state.extensions}×` : ""}
      {state.overBudget && (
        <span
          data-testid={`loop-over-budget-${task.id}`}
          className="text-error"
        >
          {" "}
          · {describeBreach(state.overBudget)}
        </span>
      )}
    </div>
  );
}

/**
 * Whether the loop shows what each item's runs used: once a budget was set
 * here (`applied`), or when its limits differ from its level's own.
 */
export function loopShowsUsage(loop: LoopState, applied: boolean): boolean {
  const preset = LOOP_AUTONOMY[loop.autonomy ?? "auto"].budget;
  return (
    applied ||
    loop.budget.maxRounds !== preset.maxRounds ||
    loop.budget.maxTokens !== preset.maxTokens ||
    loop.budget.maxWallMs !== preset.maxWallMs
  );
}

/**
 * The loop's to-dos, one line each with its status, and Skip or Run again where
 * they apply; under an item its worker, check, files, budget and model. Every
 * decision is core's (skipItem, runItemAgain); a refusal goes to `onResult`.
 */
export function LoopItemList({
  loop,
  taskPlan,
  showUsage,
  onResult,
}: {
  loop: LoopState;
  taskPlan: TaskPlan;
  /** Show what each item's runs used */
  showUsage: boolean;
  onResult: (result: { ok: boolean; error?: string }) => void;
}) {
  const dispatch = useAppDispatch();
  const report = onResult;
  return (
    <ul className="m-0 mt-1 max-h-48 list-none overflow-y-auto p-0">
      {taskPlan.items.map((task) => {
        const state = loop.items.find((i) => i.id === task.id);
        if (!state) return null;
        const checkRunning =
          loop.current?.kind === "check" && loop.current.itemId === task.id;
        const canSkip =
          state.status !== "running" &&
          state.status !== "done" &&
          !checkRunning;
        const canAgain = state.status === "done" || state.status === "failed";
        const dependency = dependencyLabel(loop, taskPlan, task);
        const worker = loop.parallel?.find((r) => r.itemId === task.id);
        return (
          <li key={task.id} className="min-w-0">
            <div
              data-testid={`loop-item-${task.id}`}
              className="flex min-w-0 items-center gap-1"
            >
              <span
                className="min-w-0 flex-1 truncate text-foreground"
                title={`${task.id}. ${task.text}`}
              >
                {task.id}. {task.text}
              </span>
              {dependency && (
                <span
                  data-testid={`loop-after-${task.id}`}
                  className="shrink-0 text-description"
                >
                  {dependency}
                </span>
              )}
              <span className="shrink-0 text-description">
                {statusLabel(loop, task.id)}
              </span>
              {showUsage && state.attempts > 0 && (
                <span
                  data-testid={`loop-runs-${task.id}`}
                  className="shrink-0 text-description"
                >
                  {state.attempts} run{state.attempts === 1 ? "" : "s"}
                  {state.usage
                    ? ` · ${formatTokenCount(state.usage.tokens)} tokens${
                        state.usage.cost !== undefined
                          ? ` · ${formatCostAmount(state.usage.cost)}`
                          : ""
                      } · ${formatDuration(state.usage.ms)}`
                    : ""}
                </span>
              )}
              {canSkip && (
                <button
                  type="button"
                  data-testid={`loop-skip-${task.id}`}
                  className={BUTTON}
                  onClick={async () =>
                    report(await dispatch(skipLoopItemThunk(task.id)).unwrap())
                  }
                >
                  Skip
                </button>
              )}
              {canAgain && (
                <button
                  type="button"
                  data-testid={`loop-again-${task.id}`}
                  className={BUTTON}
                  onClick={async () =>
                    report(
                      await dispatch(runLoopItemAgainThunk(task.id)).unwrap(),
                    )
                  }
                >
                  Run again
                </button>
              )}
            </div>
            {worker && (
              <WorkerLine task={task} run={worker} model={state.model} />
            )}
            <CheckLine task={task} check={state.check} />
            <FilesLine task={task} />
            <BudgetLine task={task} state={state} loop={loop} />
            <ModelLine task={task} model={state.model} />
          </li>
        );
      })}
    </ul>
  );
}
