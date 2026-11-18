import { BaseSessionMetadata } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { parseDate } from "../../components/History/util";
import { sessionBelongsToWorkspace } from "../../util/sessionWorkspace";

export const RECENT_SESSIONS_LIMIT = 5;

/**
 * Whether the session restored from the last run is worth showing a loading
 * view for. A session keeps the placeholder title until it is first saved, so
 * a persisted placeholder means the chat was empty and there is nothing to
 * wait for.
 */
export function expectsSessionToResume(
  persistedTitle: string | undefined,
): boolean {
  const title = persistedTitle?.trim();
  return !!title && title !== NEW_SESSION_TITLE;
}

/**
 * Whether the webview, starting up, will reopen the session it had open, so
 * the resuming view goes up before the first paint. The stored session is
 * shared by every window: one of another workspace is not reopened here
 * (thunks/session.ts restoreWorkspaceSession), so it gets no resuming view.
 * A stored session without a folder on record (persisted before the folder
 * was kept) gets none either; it still loads, as before.
 */
export function expectsStartupResume(input: {
  persistedTitle: string | undefined;
  sessionWorkspaceDirectory: string | undefined;
  workspaceDirs: string[];
}): boolean {
  if (!expectsSessionToResume(input.persistedTitle)) return false;
  if (input.sessionWorkspaceDirectory === undefined) return false;
  return sessionBelongsToWorkspace(
    input.sessionWorkspaceDirectory,
    input.workspaceDirs,
  );
}

/**
 * The title to show while `loadingSessionId` is loading: its saved metadata if
 * the list has arrived, otherwise the persisted title of the current session.
 */
export function getResumingTitle(
  loadingSessionId: string,
  currentSessionId: string,
  currentTitle: string,
  allSessionMetadata: BaseSessionMetadata[],
): string | undefined {
  const fromMetadata = allSessionMetadata.find(
    (m) => m.sessionId === loadingSessionId,
  )?.title;
  if (fromMetadata?.trim()) {
    return fromMetadata;
  }
  if (
    loadingSessionId === currentSessionId &&
    expectsSessionToResume(currentTitle)
  ) {
    return currentTitle;
  }
  return undefined;
}

/**
 * The most recent sessions, newest first, leaving out the one being loaded.
 * Sessions with an unreadable date sort last.
 */
export function selectRecentSessions(
  allSessionMetadata: BaseSessionMetadata[],
  excludeSessionId: string | undefined,
  limit: number = RECENT_SESSIONS_LIMIT,
): BaseSessionMetadata[] {
  if (limit <= 0) {
    return [];
  }
  const time = (m: BaseSessionMetadata) => {
    const t = parseDate(m.dateCreated).getTime();
    return isNaN(t) ? -Infinity : t;
  };
  return allSessionMetadata
    .filter((m) => m.sessionId !== excludeSessionId)
    .map((m) => ({ m, t: time(m) }))
    .sort((a, b) => (a.t === b.t ? 0 : b.t > a.t ? 1 : -1))
    .slice(0, limit)
    .map(({ m }) => m);
}
