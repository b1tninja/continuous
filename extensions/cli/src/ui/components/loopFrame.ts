import type { LoopState } from "core/index.js";

/**
 * The loop's state as the round prompt box shows it: one border colour, and an
 * icon and word in the top-border label so colour is never the only cue (and
 * NO_COLOR still reads). Ink draws one colour per border, so this is the
 * terminal twin of the webview's gradient loop frame: blue is running, yellow
 * waiting on the person, red a failed item being repaired, green finished,
 * gray stopped. It only maps state to presentation; it changes no behaviour.
 */
export type LoopFrameState =
  "running" | "waiting" | "failed" | "finished" | "stopped";

export const LOOP_FRAME_COLORS: Record<LoopFrameState, string> = {
  running: "blue",
  waiting: "yellow",
  failed: "red",
  finished: "green",
  stopped: "gray",
};

/** One terminal cell each, so the corners line up whatever the state. */
export const LOOP_FRAME_ICONS: Record<LoopFrameState, string> = {
  running: "●",
  waiting: "‖",
  failed: "✕",
  finished: "✓",
  stopped: "■",
};

export function loopFrameState(loop: LoopState): LoopFrameState {
  if (loop.status === "stopped") {
    return loop.stopReason === "done" ? "finished" : "stopped";
  }
  const open = loop.questions.some((q) => !q.answerId);
  if (loop.status === "waiting" || loop.status === "awaiting_plan" || open) {
    return "waiting";
  }
  const repairing =
    loop.status === "replanning" || loop.current?.kind === "replan";
  if (repairing && loop.items.some((i) => i.status === "failed")) {
    return "failed";
  }
  return "running";
}

export interface LoopFrameInfo {
  state: LoopFrameState;
  color: string;
  icon: string;
  label: string;
}

export function loopFrameInfo(loop: LoopState): LoopFrameInfo {
  const state = loopFrameState(loop);
  const skipped = loop.items.filter((i) => i.skipped).length;
  const done = loop.items.filter((i) => i.status === "done").length - skipped;
  const progress = `${done}/${loop.items.length}`;
  const round = `R${loop.round}/${loop.budget.maxRounds}`;
  let word: string;
  switch (state) {
    case "running":
      word = `Running · ${progress} · ${round}`;
      break;
    case "waiting":
      word = `Waiting for you · ${progress} · ${round}`;
      break;
    case "failed": {
      const failed = loop.items.find((i) => i.status === "failed");
      word = `Item ${failed?.id ?? ""} failed · repairing · ${round}`;
      break;
    }
    case "finished":
      word = `Done · ${progress}`;
      break;
    default:
      word = `Stopped · ${progress} · ${round}`;
  }
  return {
    state,
    color: LOOP_FRAME_COLORS[state],
    icon: LOOP_FRAME_ICONS[state],
    label: word,
  };
}

/** `╭─ ● Running · 6/12 ───╮`, `columns` cells wide, cut with an ellipsis if it must be. */
export function loopFrameTop(info: LoopFrameInfo, columns: number): string {
  const width = Math.max(8, columns);
  let text = `${info.icon} ${info.label}`;
  const room = width - 6; // "╭─ " + " " + "╮" and one rule cell
  if (text.length > room) text = `${text.slice(0, Math.max(1, room - 1))}…`;
  const rule = "─".repeat(Math.max(1, width - 5 - text.length));
  return `╭─ ${text} ${rule}╮`;
}
