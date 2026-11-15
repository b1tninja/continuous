import { BaseSessionMetadata } from "core";
import {
  groupSessionsByWorkspace,
  normalizeWorkspacePath,
  sessionMatchesWorkspace,
  WorkspaceSessionGroup,
} from "core/util/sessionWorkspace";
import { getPlatform } from ".";
import { parseDate } from "../components/History/util";

/**
 * The IDE side of core/util/sessionWorkspace.ts: which sessions belong to
 * the workspace this window has open. Workspace folders are the URIs the IDE
 * gives (`window.workspacePaths`, or the `getWorkspaceDirs` request); a
 * session's folder is a URI (saved by the IDE) or a path (saved by the CLI).
 */

/** File names compare without case on Windows and macOS. */
export function workspaceCaseInsensitive(): boolean {
  return getPlatform() !== "linux";
}

/** This window's workspace folders, as the webview was given them. */
export function currentWorkspaceDirs(): string[] {
  return (window.workspacePaths ?? []).filter(Boolean);
}

/**
 * The key `lastSessionIdByWorkspace` is stored under: the first workspace
 * folder, normalised; "" for a window with no folder open.
 */
export function workspaceKey(
  workspaceDirs: string[],
  caseInsensitive: boolean = workspaceCaseInsensitive(),
): string {
  const first = workspaceDirs.find((dir) => dir && dir.trim() !== "");
  return first ? normalizeWorkspacePath(first, caseInsensitive) : "";
}

/**
 * Whether a session belongs to the workspace: any of its folders, a folder
 * inside or around one (sessionMatchesWorkspace). A window with no folder
 * open owns the sessions saved without one.
 */
export function sessionBelongsToWorkspace(
  sessionDirectory: string | undefined,
  workspaceDirs: string[],
  caseInsensitive: boolean = workspaceCaseInsensitive(),
): boolean {
  const dirs = workspaceDirs.filter((dir) => dir && dir.trim() !== "");
  if (dirs.length === 0) return !sessionDirectory;
  return sessionMatchesWorkspace(sessionDirectory, dirs, { caseInsensitive });
}

/**
 * The History page's groups: this workspace first with its newest session on
 * top, then the other folders by their newest session, then "No folder".
 */
export function groupHistoryByWorkspace(
  sessions: BaseSessionMetadata[],
  workspaceDirs: string[],
  caseInsensitive: boolean = workspaceCaseInsensitive(),
): WorkspaceSessionGroup<BaseSessionMetadata>[] {
  return groupSessionsByWorkspace(sessions, {
    workspaceDirs,
    caseInsensitive,
    getDirectory: (s) => s.workspaceDirectory,
    getTime: (s) => parseDate(s.dateCreated).getTime(),
  });
}

/**
 * The sessions to try, in order, when this window reopens its last session:
 * 1. the last session of this workspace (`lastSessionIdByWorkspace`);
 * 2. the single `lastSessionId` kept before sessions were remembered per
 *    workspace, only when it is a session of this workspace (that value is
 *    shared by every window, so it may be another workspace's);
 * 3. the newest session of this workspace in the history list.
 */
export function lastSessionCandidates(input: {
  byWorkspace: Record<string, string> | undefined;
  legacyLastSessionId: string | undefined;
  sessions: BaseSessionMetadata[];
  workspaceDirs: string[];
  caseInsensitive?: boolean;
}): string[] {
  const caseInsensitive = input.caseInsensitive ?? workspaceCaseInsensitive();
  const belongs = (dir: string | undefined) =>
    sessionBelongsToWorkspace(dir, input.workspaceDirs, caseInsensitive);
  const candidates: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !candidates.includes(id)) candidates.push(id);
  };

  add(input.byWorkspace?.[workspaceKey(input.workspaceDirs, caseInsensitive)]);

  const legacy = input.legacyLastSessionId
    ? input.sessions.find((s) => s.sessionId === input.legacyLastSessionId)
    : undefined;
  if (legacy && belongs(legacy.workspaceDirectory)) add(legacy.sessionId);

  const newest = [...input.sessions]
    .filter((s) => belongs(s.workspaceDirectory))
    .sort(
      (a, b) =>
        parseDate(b.dateCreated).getTime() - parseDate(a.dateCreated).getTime(),
    )[0];
  add(newest?.sessionId);
  return candidates;
}

/** At most this many workspaces keep a last session id. */
export const MAX_REMEMBERED_WORKSPACES = 50;

/** `byWorkspace` with `key` set to `sessionId`, newest last, oldest dropped. */
export function rememberLastSession(
  byWorkspace: Record<string, string> | undefined,
  key: string,
  sessionId: string,
): Record<string, string> {
  const next: Record<string, string> = { ...(byWorkspace ?? {}) };
  delete next[key];
  next[key] = sessionId;
  const keys = Object.keys(next);
  for (const old of keys.slice(
    0,
    Math.max(0, keys.length - MAX_REMEMBERED_WORKSPACES),
  )) {
    delete next[old];
  }
  return next;
}
