import type { LoopState, TaskPlan } from "core";
import { isLoopPaused } from "core/util/loopMode";
import {
  formatDuration,
  formatTokenCount,
  type LoopUsage,
} from "core/util/loopUsage";
import {
  getLoopVisualState,
  LOOP_VISUAL,
  type LoopVisualState,
} from "./loopVisualState";

/** What the status line shows, worked out from the loop; pure, so it is tested alone. */
export interface LoopStripModel {
  state: LoopVisualState;
  /** The word beside the icon: more specific than the state's own word */
  word: string;
  done: number;
  total: number;
  round: number;
  /** 0: no limit */
  maxRounds: number;
  /** "7h 32m left", or "19m in" without a limit */
  time: string;
  /** "20M left", or "1.2M used" without a limit */
  tokens: string;
  /** What is running now, or undefined when nothing is */
  now?: string;
}

function itemText(taskPlan: TaskPlan | undefined, id: string): string {
  return taskPlan?.items.find((i) => i.id === id)?.text ?? `item ${id}`;
}

export function loopStripModel(
  loop: LoopState,
  taskPlan: TaskPlan | undefined,
  usage: LoopUsage,
): LoopStripModel {
  const state = getLoopVisualState(loop);
  const current = loop.current;
  let word: string = LOOP_VISUAL[state].word;
  if (state === "running") {
    if (loop.status === "replanning") word = "Re-planning";
    else if (current?.kind === "check") word = "Checking";
  } else if (state === "waiting") {
    word =
      loop.status === "awaiting_plan"
        ? "Plan waiting for you"
        : "Waiting for your answer";
  } else if (state === "failed") {
    word =
      current?.kind === "replan" && current.itemId
        ? `Item ${current.itemId} failed`
        : "Failed";
  } else if (state === "stopped" && isLoopPaused(loop)) {
    word = "Paused";
  }

  let now: string | undefined;
  if (current) {
    if (current.kind === "replan") {
      now = current.itemId
        ? `repairing item ${current.itemId} (${itemText(taskPlan, current.itemId)})`
        : "re-planning";
    } else if (current.itemId) {
      const text = itemText(taskPlan, current.itemId);
      now = current.kind === "check" ? `checking ${text}` : text;
    }
  }

  return {
    state,
    word,
    done: usage.items.done,
    total: usage.items.total,
    round: loop.round,
    maxRounds: loop.budget.maxRounds,
    time:
      usage.time.left === undefined
        ? `${formatDuration(usage.time.used)} in`
        : `${formatDuration(usage.time.left)} left`,
    tokens:
      usage.tokens.left === undefined
        ? `${formatTokenCount(usage.tokens.used)} used`
        : `${formatTokenCount(usage.tokens.left)} left`,
    now,
  };
}
