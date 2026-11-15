import { createAsyncThunk } from "@reduxjs/toolkit";
import { BuiltInToolNames } from "core/tools/builtIn";
import { selectCurrentToolCalls } from "../selectors/selectToolCalls";
import { setInterruptConfirm, type InterruptAction } from "../slices/uiSlice";
import type { RootState, ThunkApiType } from "../store";
import { stopResponseThunk } from "./paletteCommands";

/*
 * No single key stops running work (NI1, NI8; the owner's rule): Esc on an
 * empty input, Ctrl+L, the palette's Stop Response, New Session, opening a
 * session from History and switching tabs ask first while the agent works.
 * The question (components/InterruptConfirm) confirms with Enter and keeps
 * going with Esc, so the key that opened it, held or pressed again, cannot
 * answer yes. Nothing is asked when nothing runs, and there is no "don't ask
 * again": a switch with nothing running asks nothing, and the unsent draft
 * goes with the input (NI5), so the only remaining case is running work.
 */

/** What the agent is doing now, or undefined when it is idle. */
export interface RunningWork {
  streaming: boolean;
  /** Tool calls waiting for the person's approval */
  awaitingApproval: number;
  /** Tool calls running now, a terminal command for one */
  running: number;
  /** A loop is running (between items too) */
  loop: boolean;
}

export function selectRunningWork(state: RootState): RunningWork | undefined {
  const calls = selectCurrentToolCalls(state);
  const work: RunningWork = {
    streaming: state.session.isStreaming,
    awaitingApproval: calls.filter((c) => c.status === "generated").length,
    running: calls.filter((c) => c.status === "calling").length,
    loop: state.session.loop?.status === "running",
  };
  return work.streaming || work.awaitingApproval || work.running || work.loop
    ? work
    : undefined;
}

/** Whether Stop has something to act on: a reply or a terminal command. */
export function selectCanStop(state: RootState): boolean {
  return (
    state.session.isStreaming ||
    selectCurrentToolCalls(state).some(
      (c) =>
        c.status === "calling" &&
        c.toolCall?.function?.name === BuiltInToolNames.RunTerminalCommand,
    )
  );
}

/** Whether the question for `action` still has a reason to be open. */
export function isInterruptStillNeeded(
  state: RootState,
  action: InterruptAction,
): boolean {
  return action === "stop" ? selectCanStop(state) : !!selectRunningWork(state);
}

/** The open question's answer, by its id; settled once. */
const waiting = new Map<number, (confirmed: boolean) => void>();
let lastId = 0;

/**
 * Asks before `action` stops running work, and resolves to the answer; true
 * at once when nothing runs. While a question is open another one is not
 * asked and resolves false: the open one decides, so pressing the key that
 * opened it again (or holding it) does nothing.
 */
export const confirmInterrupt = createAsyncThunk<
  boolean,
  InterruptAction,
  ThunkApiType
>("interrupt/confirm", async (action, { dispatch, getState }) => {
  const state = getState();
  if (!isInterruptStillNeeded(state, action)) return true;
  if (state.ui.interruptConfirm) return false;
  const id = ++lastId;
  const answer = new Promise<boolean>((resolve) => waiting.set(id, resolve));
  dispatch(setInterruptConfirm({ id, action }));
  return answer;
});

/** The person answered question `id` (or it closed: false). */
export const answerInterruptConfirm = createAsyncThunk<
  void,
  { id: number; confirmed: boolean },
  ThunkApiType
>("interrupt/answer", async ({ id, confirmed }, { dispatch, getState }) => {
  if (getState().ui.interruptConfirm?.id === id) {
    dispatch(setInterruptConfirm(undefined));
  }
  const resolve = waiting.get(id);
  waiting.delete(id);
  resolve?.(confirmed);
});

/**
 * Stop from a key (Esc on an empty input, the Stop button reached with the
 * keyboard, the palette's Stop Response): asks, then stops as the button
 * does. The reply keeps what it wrote and is marked stopped for Resume; the
 * input keeps its text. Resolves whether it stopped.
 */
export const askToStopResponse = createAsyncThunk<
  boolean,
  undefined,
  ThunkApiType
>("interrupt/askToStop", async (_, { dispatch, getState }) => {
  if (!selectCanStop(getState())) return false;
  const confirmed = await dispatch(confirmInterrupt("stop")).unwrap();
  if (!confirmed) return false;
  return dispatch(stopResponseThunk()).unwrap();
});

/**
 * Before a session switch (Ctrl+L, New Session, a History entry, a tab):
 * when work runs, asks, and on yes stops it the way Stop does, so the session
 * is saved with its reply marked stopped and Resume works when it is opened
 * again. Resolves whether the switch may go ahead.
 */
export const confirmSessionSwitch = createAsyncThunk<
  boolean,
  Exclude<InterruptAction, "stop">,
  ThunkApiType
>("interrupt/confirmSwitch", async (action, { dispatch, getState }) => {
  if (!selectRunningWork(getState())) return true;
  const confirmed = await dispatch(confirmInterrupt(action)).unwrap();
  if (!confirmed) return false;
  await dispatch(stopResponseThunk());
  return true;
});
