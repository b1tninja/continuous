import { createAsyncThunk } from "@reduxjs/toolkit";
import { levelOfCall } from "core/tools/permissions/approval";
import { propose } from "core/tools/permissions/decisionTimer";

import { setToolCallTimer } from "../slices/sessionSlice";
import { selectPendingToolCalls } from "../selectors/selectToolCalls";
import { ThunkApiType } from "../store";

/**
 * Starts the decision timer on each waiting ask that has none yet and is one
 * a window may answer. The window starts when the call is first shown here, and
 * all the waiting asks run side by side, so a turn adds at most the longest
 * window to the gap before the next request to the model (turnBudget.ts).
 *
 * Asks a rule or a guard raised (policySource: an ask rule, a protected path,
 * a floor, a taint or egress guard) are left to wait. A call with no source is
 * the tool's own setting.
 */
export const startToolTimersThunk = createAsyncThunk<void, void, ThunkApiType>(
  "chat/startToolTimers",
  async (_, { dispatch, getState }) => {
    const state = getState();
    const settings = state.ui.policyExtras?.timer;
    if (!settings || Object.keys(settings).length === 0) return;

    // One reading for the whole pass, so asks shown together share a clock
    const now = Date.now();
    for (const call of selectPendingToolCalls(state)) {
      if (call.askTimer) continue;
      let found;
      try {
        found = levelOfCall(
          { levels: state.ui.policyLevels },
          call.toolCall.function.name,
          call.tool,
          { parsedArgs: call.parsedArgs },
        );
      } catch {
        continue;
      }
      if (!found) continue;
      const proposal = propose(
        {
          policy: "allowedWithPermission",
          source: call.policySource ?? "tool-setting",
        },
        {
          attended: true,
          level: found.level as never,
          settings,
          now,
        },
      );
      if (!proposal) continue;
      dispatch(
        setToolCallTimer({
          toolCallId: call.toolCallId,
          timer: {
            startedAt: proposal.startedAt,
            seconds: proposal.seconds,
            proposed: proposal.proposed,
          },
        }),
      );
    }
  },
);
