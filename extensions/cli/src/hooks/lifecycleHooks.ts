/**
 * Call sites for the lifecycle events: session start and end, the end of an
 * assistant turn, a notice that the person is needed, and compaction. Each
 * wraps its `fire*` helper so a caller needs one line and a hook can never
 * throw into the code that fired it.
 *
 * What is not done yet, and said so rather than silently ignored: a `Stop` or
 * `PreCompact` hook that asks to continue or to block is logged, not obeyed,
 * and `SessionStart` context is not added to the conversation.
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

/** The end of an assistant turn. A request to keep going is logged only. */
export async function runStopHooks(lastAssistantMessage?: string) {
  const result = await safely("Stop", () => fireStop(lastAssistantMessage));
  if (result?.blocked) {
    logger.warn(
      "A Stop hook asked the assistant to continue; continuing is not supported yet, so the turn ended.",
    );
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
