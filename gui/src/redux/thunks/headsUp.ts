import type { PolicyLevels } from "core/tools/permissions/policy";
import { levelOfCall } from "core/tools/permissions/approval";
import { propose } from "core/tools/permissions/decisionTimer";

import { setToolCallTimer } from "../slices/sessionSlice";
import type { RootState } from "../store";

/**
 * A heads-up on calls the policy allows (core decisionTimer.ts): at a level with
 * a window in `levels.headsUp`, an allowed call is not run at once. It is left
 * waiting with a countdown, "Runs in 5 s unless you answer", and the person can
 * deny it or run it now. When the window ends it runs.
 *
 * Returns the ids of the calls held, so the caller leaves them out of what it
 * runs now. A call that is held waits the way an ask waits, in the same
 * toolbar. The windows of calls shown together share one reading of the clock.
 *
 * Not held: no window at the call's level, IDGAF, and an unattended Loop run
 * (nobody is looking at a countdown).
 */
export function holdForHeadsUp(
  state: RootState,
  dispatch: (action: ReturnType<typeof setToolCallTimer>) => unknown,
  allowed: ReadonlyArray<{
    source?: string;
    toolCallState: {
      toolCallId: string;
      parsedArgs?: unknown;
      tool?: unknown;
      toolCall: { function: { name: string } };
    };
  }>,
): Set<string> {
  const held = new Set<string>();
  const headsUp = state.ui.policyExtras?.headsUp;
  if (!headsUp || Object.keys(headsUp).length === 0) return held;
  const attended = !state.session.loop?.current;
  const now = Date.now();
  const levels: PolicyLevels = state.ui.policyLevels;

  for (const { source, toolCallState } of allowed) {
    let found;
    try {
      found = levelOfCall(
        { levels },
        toolCallState.toolCall.function.name,
        toolCallState.tool as never,
        { parsedArgs: toolCallState.parsedArgs as never },
      );
    } catch {
      continue;
    }
    if (!found) continue;
    const proposal = propose(
      { policy: "allowedWithoutPermission", source },
      {
        attended,
        level: found.level as never,
        settings: {},
        headsUp,
        now,
      },
    );
    if (!proposal) continue;
    dispatch(
      setToolCallTimer({
        toolCallId: toolCallState.toolCallId,
        timer: {
          startedAt: proposal.startedAt,
          seconds: proposal.seconds,
          proposed: "allow",
        },
      }),
    );
    held.add(toolCallState.toolCallId);
  }
  return held;
}
