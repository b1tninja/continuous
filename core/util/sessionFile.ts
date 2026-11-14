import type { Session } from "../index.js";
import { withoutPrompts } from "./promptLogs.js";

/**
 * Past this many bytes a session file is large enough to slow every save and
 * load: each save rewrites the whole file on the extension host's thread, and
 * the webview holds the whole session in memory. A session of normal length
 * is a few MB; the 432 MB one that ran the webview out of memory was mostly
 * old prompt logs (plans/research/prompt-logs-and-session-storage.md, STOR8).
 */
export const SESSION_FILE_BUDGET_BYTES = 50 * 1024 * 1024;

/** A save slower than this is logged, with the file's size. */
export const SLOW_SESSION_SAVE_MS = 1000;

/**
 * The session as it is written: the keys in a fixed order (id, title and
 * workspace first, then the history) and optional parts only when present.
 * No prompt is written: each repeats the conversation before it, so keeping
 * them made the file grow with the square of its length (promptLogs.ts).
 */
export function orderSession(session: Session): Session {
  const ordered: Session = {
    sessionId: session.sessionId,
    title: session.title,
    workspaceDirectory: session.workspaceDirectory,
    history: withoutPrompts(session.history),
  };
  if (session.mode) {
    ordered.mode = session.mode;
  }
  if (session.chatModelTitle !== undefined) {
    ordered.chatModelTitle = session.chatModelTitle;
  }
  if (session.usage !== undefined) {
    ordered.usage = session.usage;
  }
  if (session.promptCache !== undefined) {
    ordered.promptCache = session.promptCache;
  }
  if (session.checkpoints?.length) {
    ordered.checkpoints = session.checkpoints;
  }
  if (session.taskPlan?.items.length) {
    ordered.taskPlan = session.taskPlan;
  }
  if (session.planFile) {
    ordered.planFile = session.planFile;
  }
  if (session.queuedMessages?.length) {
    ordered.queuedMessages = session.queuedMessages;
  }
  if (session.loop) {
    ordered.loop = session.loop;
  }
  if (session.loopRequested) {
    ordered.loopRequested = true;
  }
  if (session.forkedFrom) {
    ordered.forkedFrom = session.forkedFrom;
  }
  return ordered;
}

/** The exact text of a session file. */
export function serializeSession(session: Session): string {
  return JSON.stringify(orderSession(session), undefined, 2);
}

/** "640 bytes", "812 KB", "3.4 MB", "432 MB": one decimal below 10 MB. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

export function isOverSessionBudget(
  bytes: number | undefined,
  budget: number = SESSION_FILE_BUDGET_BYTES,
): boolean {
  return bytes !== undefined && bytes >= budget;
}

/** The line logged when a save passes the budget. */
export function sessionBudgetWarning(
  sessionId: string,
  bytes: number,
  budget: number = SESSION_FILE_BUDGET_BYTES,
  storage: "json" | "log" = "json",
): string {
  if (storage === "log") {
    return `Session ${sessionId} takes ${formatFileSize(bytes)} on disk (its log and stored outputs), past the ${formatFileSize(budget)} session budget: opening it reads all of it, and the chat window holds all of it in memory. Start a new session to keep working quickly.`;
  }
  return `Session ${sessionId} file is ${formatFileSize(bytes)}, past the ${formatFileSize(budget)} session budget: every save rewrites it whole, so saving and opening it get slower. Start a new session to keep working quickly.`;
}
