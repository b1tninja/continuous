import { createAsyncThunk } from "@reduxjs/toolkit";
import { BuiltInToolNames } from "core/tools/builtIn";
import { findResumableTurn } from "../../util/resumeTurn";
import {
  selectPendingToolCalls,
  selectToolCallsByStatus,
} from "../selectors/selectToolCalls";
import { cancelToolCall } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { logToolUsage } from "../util";
import { cancelStream } from "./cancelStream";
import { chooseLoopMode, resumeLoopThunk, stopLoopThunk } from "./loop";
import { resumeTurn } from "./resumeTurn";

/*
 * The Command Palette's actions on the chat (NI13). Each is what its button
 * does, so a command and the button cannot drift apart, and answers whether
 * there was anything to act on, for the extension to say so when not.
 */

/**
 * The Stop button: running terminal commands are killed and the reply is
 * cancelled (LumpToolbar's "Stop" and "Stop Terminal").
 */
export const stopResponseThunk = createAsyncThunk<
  boolean,
  undefined,
  ThunkApiType
>("palette/stopResponse", async (_, { dispatch, getState, extra }) => {
  const state = getState();
  const terminals = selectToolCallsByStatus(state, "calling").filter(
    (call) =>
      call.toolCall?.function?.name === BuiltInToolNames.RunTerminalCommand,
  );
  await Promise.all(
    terminals.map(async (call) => {
      try {
        await extra.ideMessenger.request("process/killTerminalProcess", {
          toolCallId: call.toolCallId,
        });
        dispatch(cancelToolCall({ toolCallId: call.toolCallId }));
        logToolUsage(call, false, true, extra.ideMessenger);
      } catch (error) {
        console.error(
          `Failed to cancel terminal command ${call.toolCallId}:`,
          error,
        );
      }
    }),
  );
  const streaming = getState().session.isStreaming;
  if (streaming) await dispatch(cancelStream());
  return terminals.length > 0 || streaming;
});

/** Resume under a stopped, failed or interrupted turn (ResumeResponse). */
export const resumeResponseThunk = createAsyncThunk<
  boolean,
  undefined,
  ThunkApiType
>("palette/resumeResponse", async (_, { dispatch, getState }) => {
  const state = getState();
  if (
    state.session.isStreaming ||
    selectPendingToolCalls(state).length > 0 ||
    !findResumableTurn(state.session.history)
  ) {
    return false;
  }
  await dispatch(resumeTurn());
  return true;
});

export type StartLoopResult = "resumed" | "chosen" | "running";

/**
 * Start Loop: a stopped loop that can go on is resumed (the loop strip's
 * Resume); otherwise Loop is picked in the mode picker, and the plan the next
 * message presents starts it. A loop already going is left alone.
 */
export const startLoopFromPaletteThunk = createAsyncThunk<
  StartLoopResult,
  undefined,
  ThunkApiType
>("palette/startLoop", async (_, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (loop && loop.status !== "stopped") return "running";
  if (loop && loop.stopReason !== "done") {
    await dispatch(resumeLoopThunk());
    return "resumed";
  }
  await dispatch(chooseLoopMode());
  return "chosen";
});

/** The loop strip's Stop: after the running item, or the wave's workers now. */
export const stopLoopFromPaletteThunk = createAsyncThunk<
  boolean,
  undefined,
  ThunkApiType
>("palette/stopLoop", async (_, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (!loop || loop.status === "stopped" || loop.stopRequested) return false;
  await dispatch(stopLoopThunk());
  return true;
});
