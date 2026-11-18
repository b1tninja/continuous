import type { Session, SessionPromptCache } from "../index.js";
import { withoutPrompts } from "./promptLogs.js";

/** Where a forked session came from. */
export interface ForkedFrom {
  sessionId: string;
  /** The last history item the fork kept; absent when it kept all of them. */
  index?: number;
}

export interface ForkSessionOptions {
  /** The new session's ID. */
  sessionId: string;
  /**
   * The last history item to keep (inclusive). Absent keeps the whole
   * history, which is "Fork session"; a number is "Fork from here".
   */
  upTo?: number;
  /**
   * The cache record to give the fork instead of the parent's: the GUI knows
   * from its ledger when the entry at an earlier fork point was last read and
   * how big it is, so a fork from an earlier message does not show the
   * parent's (newer, larger) entry as its own.
   */
  promptCache?: SessionPromptCache;
}

/** The title a fork gets: the parent's, marked. */
export function forkTitle(title: string): string {
  return title.endsWith(" (fork)") ? title : `${title} (fork)`;
}

/**
 * A copy of `parent` as a new session, per the copy table in
 * plans/research/session-forking-and-cache.md section 6.3:
 *
 * - the history up to the fork point, unchanged, so the fork's requests start
 *   with the same bytes as the parent's and can read its prompt cache;
 * - the mode and the chat model, which pick the system prompt, the tools and
 *   the model: a change to any of them would rebuild the cache;
 * - the task plan, as a copy (it is sent at the tail of each request, and in
 *   Agent mode its presence decides whether the task list tool is offered);
 * - the cache record, so the fork can tell whether its cache is warm; the
 *   request count restarts, the Auto escalation (a property of the person's
 *   pace) is kept.
 *
 * Not copied: the plan file (both sessions writing one file would conflict;
 * the fork gets its own when it writes one), the loop and its request (its
 * workers and worktrees belong to the parent), queued messages (typed for the
 * parent), file checkpoints (they describe the workspace both share, so a
 * restore in one would undo the other's edits) and usage (cost belongs to
 * the session that spent it). Permission levels are not session data: they
 * stay with the window or the CLI process that set them.
 *
 * Pure: it does not save anything.
 */
export function forkSession(
  parent: Session,
  options: ForkSessionOptions,
): Session {
  const end =
    options.upTo === undefined
      ? parent.history.length
      : Math.max(0, Math.min(options.upTo + 1, parent.history.length));
  const kept = end < parent.history.length;
  const cache = options.promptCache ?? parent.promptCache;

  const fork: Session = {
    sessionId: options.sessionId,
    title: forkTitle(parent.title),
    workspaceDirectory: parent.workspaceDirectory,
    // A deep copy: the parent's items may be frozen (the GUI's store) and
    // must not be shared with a session that will grow on its own. Prompts
    // are dropped before the copy: a fork is a new session, and each prompt
    // repeats the conversation before it (promptLogs.ts)
    history: structuredClone(withoutPrompts(parent.history.slice(0, end))),
    forkedFrom: {
      sessionId: parent.sessionId,
      ...(kept && { index: end - 1 }),
    },
  };
  if (parent.mode) fork.mode = parent.mode;
  if (parent.chatModelTitle !== undefined) {
    fork.chatModelTitle = parent.chatModelTitle;
  }
  if (parent.taskPlan?.items.length) {
    fork.taskPlan = structuredClone(parent.taskPlan);
  }
  if (cache?.lastRequestAt !== undefined) {
    fork.promptCache = {
      lastRequestAt: cache.lastRequestAt,
      ...(cache.lastInputTokens !== undefined && {
        lastInputTokens: cache.lastInputTokens,
      }),
      ...(cache.lastTtl && { lastTtl: cache.lastTtl }),
      ...(cache.escalated && {
        escalated: true,
        ...(cache.escalatedBy && { escalatedBy: cache.escalatedBy }),
      }),
    };
  }
  return fork;
}
