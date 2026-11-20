import { createAsyncThunk } from "@reduxjs/toolkit";
import { modelNote } from "core/tools/permissions/decisionTimer";

import { errorToolCall } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById } from "../util";

import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

/**
 * A decision timer's window ran out with no answer: the ask is refused, as the
 * policy does when nobody can answer. The audit trail records it as the system's
 * decision, never the person's, and the model is told that nobody answered and
 * that the command was not judged unsafe (decisionTimer.ts modelNote).
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

    const resolved = { outcome: "default-applied", final: "refuse" } as const;
    void extra.ideMessenger.request("audit/timer", {
      callId: toolCallId,
      resolved,
      held: { proposed: timer.proposed, seconds: timer.seconds },
    });

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
