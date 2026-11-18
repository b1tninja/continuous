import type { LoopState } from "core";

/**
 * The one colour language of Loop mode. The status line, the plan tree and the
 * gradient frame all read their state from here, so a loop looks the same
 * everywhere: an icon, a word and a colour per state, and never the colour
 * alone.
 */
export type LoopVisualState =
  "running" | "waiting" | "failed" | "finished" | "stopped";

/** Stop reasons that mean the loop ended because something went wrong. */
const FAILED_STOPS: ReadonlyArray<string> = [
  "error",
  "failures",
  "replan_failed",
];

/**
 * Where a loop is, in the five states a person can tell apart at a glance:
 * - finished: stopped because every item is done
 * - failed: stopped by an error, or running while a failed item is being
 *   repaired (fix forward), which goes back to running once the repair lands
 * - stopped: stopped for any other reason (by the person, a budget, a pause)
 * - waiting: a plan or an answer is waiting for the person
 * - running: an item, a check or a re-plan is working
 */
export function getLoopVisualState(
  loop: Pick<LoopState, "status" | "stopReason" | "items" | "current">,
): LoopVisualState {
  if (loop.status === "stopped") {
    if (loop.stopReason === "done") return "finished";
    if (loop.stopReason && FAILED_STOPS.includes(loop.stopReason)) {
      return "failed";
    }
    return "stopped";
  }
  if (loop.status === "waiting" || loop.status === "awaiting_plan") {
    return "waiting";
  }
  const repairing = loop.current?.kind === "replan" && loop.current.itemId;
  if (
    repairing &&
    loop.items.some((i) => i.id === repairing && i.status === "failed")
  ) {
    return "failed";
  }
  return "running";
}

export type LoopStateIconName = "check" | "dot" | "pause" | "cross" | "stop";

export interface LoopVisualStyle {
  /** Which glyph LoopStateIcon draws */
  icon: LoopStateIconName;
  /** The word that always goes with the colour */
  word: string;
  /** Text and glyph colour (a Tailwind token class) */
  text: string;
  /** Solid fill, for a dot or a progress bar */
  fill: string;
  /** Edge colour, for a tile or a frame */
  border: string;
}

export const LOOP_VISUAL: Record<LoopVisualState, LoopVisualStyle> = {
  running: {
    icon: "dot",
    word: "Running",
    text: "text-link",
    fill: "bg-link",
    border: "border-link",
  },
  waiting: {
    icon: "pause",
    word: "Waiting for you",
    text: "text-warning",
    fill: "bg-warning",
    border: "border-warning",
  },
  failed: {
    icon: "cross",
    word: "Failed",
    text: "text-error",
    fill: "bg-error",
    border: "border-error",
  },
  finished: {
    icon: "check",
    word: "Done",
    text: "text-success",
    fill: "bg-success",
    border: "border-success",
  },
  stopped: {
    icon: "stop",
    word: "Stopped",
    text: "text-description",
    fill: "bg-description",
    border: "border-description",
  },
};
