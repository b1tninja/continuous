import type { LoopState } from "core";
import { useEffect, useRef } from "react";
import { announce } from "../a11y/announcer";
import { getLoopVisualState } from "./loopVisualState";

/**
 * Says the loop's state changes through the webview's one polite live region
 * (components/a11y): the tray adds no live region of its own, so nothing is
 * read twice. State changes only, no progress chatter.
 */
export function describeLoopChange(
  before: { state: string; open: number; awaitingPlan: boolean } | undefined,
  loop: LoopState,
  open: number,
): string | undefined {
  const state = getLoopVisualState(loop);
  const awaitingPlan = loop.status === "awaiting_plan";
  if (!before) return undefined;
  if (awaitingPlan && !before.awaitingPlan) {
    return "Loop waiting for you: new plan to accept";
  }
  if (open > before.open) {
    return `${open} question${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you`;
  }
  if (state === before.state) return undefined;
  switch (state) {
    case "failed": {
      const id = loop.current?.itemId;
      return id ? `Item ${id} failed, repairing` : "Loop failed";
    }
    case "finished": {
      const done = loop.items.filter((i) => i.status === "done" && !i.skipped);
      return `Loop finished, ${done.length} of ${loop.items.length} done`;
    }
    case "stopped":
      return "Loop stopped";
    case "running":
      return before.state === "waiting" ? "Loop running again" : undefined;
    default:
      return undefined;
  }
}

export function useLoopAnnouncements(
  loop: LoopState | undefined,
  open: number,
) {
  const before = useRef<
    { state: string; open: number; awaitingPlan: boolean } | undefined
  >(undefined);
  useEffect(() => {
    if (!loop) {
      before.current = undefined;
      return;
    }
    const text = describeLoopChange(before.current, loop, open);
    if (text) announce(text);
    before.current = {
      state: getLoopVisualState(loop),
      open,
      awaitingPlan: loop.status === "awaiting_plan",
    };
  }, [loop, open]);
}
