import { useEffect, useRef, useState } from "react";

/*
 * No single key stops a running turn or throws away typed text (NI8 in the
 * terminal, the owner's rule). Esc or Ctrl+C while the agent works asks
 * "Stop the response? enter to stop · esc to keep going"; Ctrl+C with text
 * typed asks "Clear the input? enter to clear · esc to keep it". Enter
 * answers yes, Esc no, and any other key closes the question and does what
 * it always does, so the key that opened it, pressed again or held, never
 * answers yes.
 */

export type PendingConfirm = "stop" | "clear" | "exit";

/**
 * Ctrl+C events closer together than this are a held key's auto-repeat, not
 * a second press: they never count toward the two-press exit.
 */
export const KEY_REPEAT_MS = 60;

/** How long after a first Ctrl+C a second one counts (the two-stage exit). */
export const DOUBLE_PRESS_MS = 1000;

/**
 * What a Ctrl+C is while work runs: a held key's repeat (ignored), the second
 * press of a double press (asks to exit) or a first press.
 */
export function classifyCtrlC(
  last: number,
  now: number,
): "repeat" | "second" | "first" {
  const gap = now - last;
  if (last && gap < KEY_REPEAT_MS) return "repeat";
  if (last && gap <= DOUBLE_PRESS_MS) return "second";
  return "first";
}

/**
 * An Enter this soon after the question opened does not answer it: one that
 * was already on its way (typed ahead) is not a decision.
 */
export const CONFIRM_ARM_MS = 300;

/** What the question says, as one line under the prompt. */
export const CONFIRM_TEXT: Record<PendingConfirm, string> = {
  stop: "Stop the response? enter to stop · esc to keep going (what it wrote so far and your text are kept)",
  clear: "Clear the input? enter to clear · esc to keep it (up brings it back)",
  exit: "Exit and stop the agent? enter to exit · esc to stay (the conversation so far is saved)",
};

export interface ConfirmKey {
  escape?: boolean;
  return?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
}

export type ConfirmKeyAction = "confirm" | "cancel" | "ignore" | "pass";

/**
 * What a key does while a question is open: Enter answers yes (not when it
 * comes too soon or with a modifier), Esc no, anything else closes the
 * question and goes on to its usual handling ("pass").
 */
export function confirmKeyAction(
  openedAt: number,
  now: number,
  key: ConfirmKey,
): ConfirmKeyAction {
  if (key.escape) return "cancel";
  if (key.return) {
    if (key.shift || key.meta || key.ctrl) return "ignore";
    return now - openedAt < CONFIRM_ARM_MS ? "ignore" : "confirm";
  }
  return "pass";
}

/**
 * The open question, if any. A stop question closes by itself when the turn
 * ends meanwhile: there is nothing left to stop.
 */
export function useInterruptConfirm(isWorking: boolean) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Keys can arrive faster than renders: the handler reads this, not state
  const pendingRef = useRef<PendingConfirm | null>(null);
  const openedAt = useRef(0);

  const set = (kind: PendingConfirm | null) => {
    pendingRef.current = kind;
    setPending(kind);
  };

  useEffect(() => {
    if (!isWorking && pendingRef.current === "stop") set(null);
  }, [isWorking, pending]);

  return {
    /** What the prompt shows */
    pending,
    /** What is open now, for a key handler */
    current: () => pendingRef.current,
    openedAt,
    open(kind: PendingConfirm) {
      openedAt.current = Date.now();
      set(kind);
    },
    close() {
      set(null);
    },
  };
}
