import { createAsyncThunk } from "@reduxjs/toolkit";
import { modelNote } from "core/tools/permissions/decisionTimer";

import {
  cancelToolCall as cancelToolCallAction,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById } from "../util";

import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

const DEFAULT_USER_REJECTION_MESSAGE = `The user skipped the tool call.
If the tool call is optional or non-critical to the main goal, skip it and continue with the next step.
If the tool call is essential, try an alternative approach.
If no alternatives exist, offer to pause here.`;

export const cancelToolCallThunk = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>(
  "chat/cancelToolCall",
  async ({ toolCallId }, { dispatch, getState, extra }) => {
    const state = getState();
    // A call the decision timer was holding: the person declined it inside the
    // window. The trail records it with the timer's outcome, and the model is
    // told the person declined, not the generic text below.
    const held = findToolCallById(state.session.history, toolCallId);
    const timer =
      held?.askTimer && !held.askTimer.kept ? held.askTimer : undefined;
    const declined = timer
      ? ({
          outcome: timer.proposed === "refuse" ? "confirmed" : "overridden",
          final: "refuse",
        } as const)
      : undefined;
    if (timer && declined) {
      void extra.ideMessenger.request("audit/timer", {
        callId: toolCallId,
        resolved: declined,
        held: { proposed: timer.proposed, seconds: timer.seconds },
      });
    } else {
      // The audit trail records that the person refused a call that asked
      void extra.ideMessenger.request("audit/answer", {
        callId: toolCallId,
        approved: false,
      });
    }
    const continueAfterToolRejection =
      state.config.config.ui?.continueAfterToolRejection;

    if (continueAfterToolRejection) {
      // Update tool call output with rejection message
      dispatch(
        updateToolCallOutput({
          toolCallId,
          contextItems: [
            {
              icon: "problems",
              name: "Tool Call Rejected",
              description: "User skipped the tool call",
              content:
                (timer &&
                  declined &&
                  modelNote(
                    declined,
                    held?.toolCall.function.name ?? "the call",
                    timer.seconds,
                  )) ||
                DEFAULT_USER_REJECTION_MESSAGE,
              hidden: true,
            },
          ],
        }),
      );
    }

    // Dispatch the actual cancel action
    dispatch(cancelToolCallAction({ toolCallId }));

    void dispatch(streamResponseAfterToolCall({ toolCallId }));
  },
);
