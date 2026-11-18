import { useRef } from "react";

import { getSessionLoop } from "../../session.js";
import { escapeEvents } from "../../util/cli.js";

import { classifyCtrlC, type PendingConfirm } from "./useInterruptConfirm.js";

interface ExitGuardOptions {
  confirm: { open: (kind: PendingConfirm) => void };
  /** The prompt's text now */
  text: () => string;
  isWaitingForResponse: boolean;
  isCompacting: boolean;
  onInterrupt?: () => void;
  exit: () => void;
}

/**
 * Ctrl+C and Ctrl+D never act on their own while it would cost something
 * (the owner's rule):
 *
 * - Ctrl+C with text typed asks to clear it (as a shell's Ctrl+C clears the
 *   line); on an empty prompt while the agent works it asks to stop.
 * - While idle a second Ctrl+C within a second still exits (index.ts). While
 *   a turn, a tool call, compaction or a loop runs, the second press asks
 *   "Exit and stop the agent?" instead, and a held key's auto-repeat is never
 *   a second press.
 * - Ctrl+D exits at once only when nothing runs and nothing is typed.
 *
 * The handlers answer true when they took the key (no signal, no exit).
 */
export function useExitGuards(options: ExitGuardOptions) {
  const { confirm, text, isWaitingForResponse, isCompacting, onInterrupt } =
    options;
  const lastCtrlC = useRef(0);

  const isWorkRunning = () =>
    isWaitingForResponse ||
    isCompacting ||
    getSessionLoop()?.status === "running";

  const handleCtrlC = (): boolean => {
    const busy = isWorkRunning();
    const now = Date.now();
    const press = classifyCtrlC(lastCtrlC.current, now);
    if (busy && press === "repeat") return true;
    lastCtrlC.current = now;
    if (busy && press === "second") {
      confirm.open("exit");
      return true;
    }
    if (text().trim()) {
      confirm.open("clear");
    } else if ((isWaitingForResponse || isCompacting) && onInterrupt) {
      confirm.open("stop");
    }
    return busy;
  };

  const handleCtrlD = (): boolean => {
    if (!isWorkRunning() && !text().trim()) return false;
    confirm.open("exit");
    return true;
  };

  /** Exit confirmed: the turn is stopped first, so its partial reply is saved. */
  const exitNow = () => {
    if (isWaitingForResponse || isCompacting) {
      escapeEvents.emit("user-escape");
      onInterrupt?.();
    }
    options.exit();
    void import("../../util/exit.js").then(({ gracefulExit }) =>
      gracefulExit(0),
    );
  };

  return { handleCtrlC, handleCtrlD, exitNow };
}
