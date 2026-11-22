import { createAsyncThunk } from "@reduxjs/toolkit";
import { modelNote } from "core/tools/permissions/decisionTimer";
import { refusalText } from "core/tools/refusalText";

import {
  cancelToolCall as cancelToolCallAction,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById } from "../util";

import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const cancelToolCallThunk = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>(
  "chat/cancelToolCall",
  async ({ toolCallId }, { dispatch, getState, extra }) => {
    const state = getState();
    // A call the decision timer was holding: the person declined it inside the
    // window. The trail records it with the timer's outcome.
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
              // The same line with or without a timer: the person declined
              content:
                (timer &&
                  declined &&
                  modelNote(
                    declined,
                    held?.toolCall.function.name ?? "the call",
                    timer.seconds,
                  )) ||
                refusalText.declined(
                  held?.toolCall.function.name ?? "the call",
                ),
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
