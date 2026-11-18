import { stopLoop } from "core/util/loopMode.js";

import {
  commitLoop,
  getSessionLoop,
  interruptRunningLoop,
} from "./loopSession.js";

/**
 * A run limit (--max-budget-usd, --max-turns, --max-duration) ends the
 * process: a loop the session still holds is marked stopped with the limit as
 * its reason, so it is not left "running" in the saved session and a resume
 * says why it ended. Returns whether a loop was stopped.
 */
export function stopLoopForRunLimit(detail: string): boolean {
  const loop = getSessionLoop();
  if (!loop || loop.status === "stopped") return false;
  // A running item or wave: its workers are aborted and its items go back to pending
  interruptRunningLoop(detail);
  // A loop between steps or waiting on the person has nothing to interrupt
  const after = getSessionLoop();
  if (after && after.status !== "stopped") {
    commitLoop(stopLoop(after, "stopped", detail));
  }
  return true;
}
