import { useEffect, useState } from "react";

import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { lapseToolCallThunk } from "../../../../redux/thunks/lapseToolCall";
import { startToolTimersThunk } from "../../../../redux/thunks/startToolTimers";

/** How often a running countdown redraws and checks for the end of its window. */
const TICK_MS = 250;

/**
 * Runs the decision timers (core decisionTimer.ts) for the waiting asks: starts
 * a window on each one that should have it, redraws once a quarter second
 * while any is running, and refuses the ones whose window has ended. The time
 * is returned so a row can show how much is left.
 *
 * Nothing here runs while no ask is waiting or no window is set, and a
 * countdown the person stopped (Keep waiting) is never touched again.
 */
export function useToolTimers(): number {
  const dispatch = useAppDispatch();
  const pending = useAppSelector(selectPendingToolCalls);
  const configured = useAppSelector((s) => {
    const t = s.ui.policyExtras?.timer;
    return !!t && Object.keys(t).length > 0;
  });
  const [now, setNow] = useState(() => Date.now());

  const ids = pending.map((p) => p.toolCallId).join(",");
  useEffect(() => {
    if (configured && ids) void dispatch(startToolTimersThunk());
  }, [configured, ids, dispatch]);

  const running = pending.some((p) => p.askTimer && !p.askTimer.kept);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(handle);
  }, [running]);

  useEffect(() => {
    for (const p of pending) {
      const t = p.askTimer;
      if (!t || t.kept) continue;
      if (t.startedAt + t.seconds * 1000 <= now) {
        void dispatch(lapseToolCallThunk({ toolCallId: p.toolCallId }));
      }
    }
  }, [now, pending, dispatch]);

  return now;
}
