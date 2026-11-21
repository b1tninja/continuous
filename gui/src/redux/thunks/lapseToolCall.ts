import { createAsyncThunk } from "@reduxjs/toolkit";
import { modelNote } from "core/tools/permissions/decisionTimer";

import { errorToolCall } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById } from "../util";

import { callToolById } from "./callToolById";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

/**
 * A decision timer's window ran out with no answer, and the proposal applies.
 *
 * For an ask the proposal is a refusal, as the policy does when nobody can
 * answer: the audit trail records it as the system's decision, never the
 * person's, and the model is told that nobody answered and that the command
 * was not judged unsafe (decisionTimer.ts modelNote).
 *
 * For a heads-up on a call the policy allowed, the proposal is to run it, so
 * the call runs as the policy allowed. Nobody objected.
 *
 * Does nothing unless the call is still waiting and its timer is still running,
 * so a click that lands just before the window ends, or a second tick, is safe.
 */
export const lapseToolCallThunk = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>(
  "chat/lapseToolCall",
  async ({ toolCallId }, { dispatch, getState, extra }) => {
    const toolCall = findToolCallById(getState().session.history, toolCallId);
    const timer = toolCall?.askTimer;
    if (!toolCall || toolCall.status !== "generated" || !timer || timer.kept) {
      return;
    }

    const resolved =
      timer.proposed === "allow"
        ? ({ outcome: "default-applied", final: "allow" } as const)
        : ({ outcome: "default-applied", final: "refuse" } as const);
    void extra.ideMessenger.request("audit/timer", {
      callId: toolCallId,
      resolved,
      held: { proposed: timer.proposed, seconds: timer.seconds },
    });

    if (resolved.final === "allow") {
      void dispatch(callToolById({ toolCallId, isAutoApproved: true }));
      return;
    }

    const note =
      modelNote(resolved, toolCall.toolCall.function.name, timer.seconds) ?? "";
    dispatch(
      errorToolCall({
        toolCallId,
        output: [
          {
            icon: "problems",
            name: "No answer in time",
            description: `No answer within ${timer.seconds} s, so it was refused`,
            content: note,
            hidden: false,
          },
        ],
      }),
    );
    void dispatch(streamResponseAfterToolCall({ toolCallId }));
  },
);
