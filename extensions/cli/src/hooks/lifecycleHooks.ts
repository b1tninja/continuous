/**
 * Call sites for the lifecycle events: session start and end, the end of an
 * assistant turn, a notice that the person is needed, and compaction. Each
 * wraps its `fire*` helper so a caller needs one line and a hook can never
 * throw into the code that fired it.
 *
 * A `Stop` hook that blocks continues the turn, at most
 * MAX_STOP_CONTINUATIONS times in a row (runTurnWithStopHooks). What is not
 * done yet, and said so rather than silently ignored: a `PreCompact` hook that
 * asks to block is logged, not obeyed, and `SessionStart` context is not added
 * to the conversation.
 */

import { notifyPerson } from "../notify/attention.js";
import { logger } from "../util/logger.js";

import {
  fireNotification,
  firePreCompact,
  fireSessionEnd,
  fireSessionStart,
  fireStop,
} from "./fireHook.js";
import type { HookEventResult, SessionEndReason } from "./types.js";
import type { SessionStartSource } from "./types.js";

/** How long exit waits for SessionEnd hooks. Claude Code's budget is the same. */
export const SESSION_END_BUDGET_MS = 1500;

let sessionEnded = false;

/** Runs a hook call; a failure is logged and never reaches the caller. */
async function safely(
  what: string,
  run: () => Promise<HookEventResult>,
): Promise<HookEventResult | undefined> {
  try {
    return await run();
  } catch (error) {
    logger.warn(`${what} hooks failed`, error);
    return undefined;
  }
}

export async function runSessionStartHooks(
  source: SessionStartSource,
  model?: string,
): Promise<void> {
  sessionEnded = false;
  await safely("SessionStart", () => fireSessionStart(source, model));
}

/**
 * Runs once per process however many exit paths call it, and waits at most
 * SESSION_END_BUDGET_MS, so a slow hook cannot keep the CLI from exiting.
 */
export async function runSessionEndHooks(
  reason: SessionEndReason,
  budgetMs: number = SESSION_END_BUDGET_MS,
): Promise<void> {
  if (sessionEnded) return;
  sessionEnded = true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([
      safely("SessionEnd", () => fireSessionEnd(reason)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many times in a row a Stop hook can send the assistant back to work
 * before the turn ends anyway (D4). The count starts again with the person's
 * next message. Claude Code's cap is 8 and resets when a tool is called
 * (code.claude.com/docs/en/hooks, "Stop input"); this one is lower and resets
 * only on the person, so a hook that never stops blocking costs at most three
 * extra replies per message.
 */
export const MAX_STOP_CONTINUATIONS = 3;

/** What the assistant is told when a Stop hook sends it back to work. */
export function stopHookFeedback(reason: string | undefined): string {
  return `Stop hook feedback:\n${reason?.trim() || "A Stop hook asked you to continue."}`;
}

/** The notice when the cap ends a turn a Stop hook wanted to continue. */
export function stopHookCapNotice(reason: string | undefined): string {
  const why = reason?.trim() ? ` Its last reason: ${reason.trim()}` : "";
  return `A Stop hook asked the assistant to continue ${MAX_STOP_CONTINUATIONS + 1} times in a row, so the turn ended after ${MAX_STOP_CONTINUATIONS} continuations. Send a message to go on.${why}`;
}

export interface StopHookLoop {
  /** Runs one assistant turn over the current history; returns its final text. */
  runTurn: () => Promise<string | undefined>;
  /**
   * Adds the hook's feedback to the conversation as the next user turn.
   * Returning false means it could not, and the turn ends there.
   */
  addUserMessage: (text: string) => unknown;
  /** Shows the person the cap notice. */
  notice: (text: string) => void;
  /** The person cancelled the turn: Stop hooks do not run after that. */
  cancelled?: () => boolean;
}

/**
 * One message from the person: runs the turn, then the Stop hooks, and while
 * a Stop hook blocks (exit 2 or `decision: "block"`) adds its reason as the
 * next user turn and runs again, at most MAX_STOP_CONTINUATIONS times. The
 * count lives in this call, so it starts again with every message the person
 * sends. `stop_hook_active` is true on the Stop events of a continuation.
 * Returns the last turn's text.
 */
export async function runTurnWithStopHooks(
  loop: StopHookLoop,
): Promise<string | undefined> {
  let response = await loop.runTurn();
  for (let continuations = 0; ; continuations++) {
    if (loop.cancelled?.()) return response;
    const last = response;
    const result = await safely("Stop", () =>
      fireStop(last, continuations > 0),
    );
    if (!result?.blocked) return response;
    if (continuations >= MAX_STOP_CONTINUATIONS) {
      logger.warn(
        `Stop hook continuation cap (${MAX_STOP_CONTINUATIONS}) reached; the turn ended.`,
      );
      loop.notice(stopHookCapNotice(result.blockReason));
      return response;
    }
    logger.info(
      `A Stop hook asked the assistant to continue (${continuations + 1} of ${MAX_STOP_CONTINUATIONS}).`,
    );
    if (loop.addUserMessage(stopHookFeedback(result.blockReason)) === false) {
      logger.warn(
        "A Stop hook asked the assistant to continue, but there is no history to add its reason to; the turn ended.",
      );
      return response;
    }
    response = await loop.runTurn();
  }
}

/** The person is needed (an approval is waiting). Does not wait for hooks. */
export function notifyAttention(
  message: string,
  notificationType: string,
  title?: string,
): void {
  void safely("Notification", () =>
    fireNotification(message, notificationType, title),
  );
  // The bell or an OS notice, when the person turned them on (GAP9). The
  // tool's name is the end of the message ("Approval needed for <tool>").
  if (notificationType === "permission_prompt") {
    const tool = /^Approval needed for (.+)$/.exec(message)?.[1] ?? "";
    notifyPerson({ kind: "approval", tool });
  }
}

export async function runPreCompactHooks(trigger: "manual" | "auto") {
  const result = await safely("PreCompact", () => firePreCompact(trigger));
  if (result?.blocked) {
    logger.warn(
      "A PreCompact hook asked to block compaction; blocking is not supported yet, so it went ahead.",
    );
  }
}

/** For tests. */
export function resetSessionEndForTests(): void {
  sessionEnded = false;
}
