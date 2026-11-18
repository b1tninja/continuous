/**
 * Which saved sessions belong to the folder the person is working in, and the
 * order a session list shows them in. Shared by the CLI (`continuous ls`,
 * `--resume`) and the IDE (History page, reopening the last session), so
 * both sides agree on what "this workspace" means.
 *
 * Pure: no file system access. Anything that needs the disk (the git
 * top-level of a folder) is passed in by the caller.
 *
 * A session's `workspaceDirectory` is a file system path when the CLI saved
 * it (`process.cwd()`) and a URI when the IDE did (`file:///c%3A/repo`,
 * `vscode-remote://...`). Both are compared through `normalizeWorkspacePath`.
 */

/** Platforms whose default file systems compare names without case. */
export function isCaseInsensitivePlatform(platform: string | undefined) {
  return platform === "win32" || platform === "darwin";
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]+):\/\/([^/]*)(.*)$/;

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The folder as a path a person reads: a `file://` URI becomes its file
 * system path (`file:///c%3A/repo` is `c:/repo`), other URIs keep their
 * scheme and host. Separators are `/`.
 */
export function workspaceDisplayPath(dir: string): string {
  let text = dir.trim();
  const uri = SCHEME.exec(text);
  if (uri) {
    const [, scheme, authority, rest] = uri;
    const pathPart = safeDecode(rest.split(/[?#]/)[0]);
    if (scheme.toLowerCase() === "file") {
      text =
        authority && authority.toLowerCase() !== "localhost"
          ? `//${safeDecode(authority)}${pathPart}`
          : pathPart.replace(/^\/([a-zA-Z]:)/, "$1");
    } else {
      text = `${scheme.toLowerCase()}://${safeDecode(authority)}${pathPart}`;
    }
  }
  return text.replace(/\\/g, "/");
}

/**
 * A comparable form of a workspace folder: URIs turned into paths,
 * backslashes into slashes, `.` and `..` segments resolved, repeated and
 * trailing separators dropped, the drive letter lower-cased, and the whole
 * path lower-cased when the file system ignores case. Relative paths are
 * left relative: the caller resolves them against its own working folder.
 */
export function normalizeWorkspacePath(
  dir: string,
  caseInsensitive = false,
): string {
  const display = workspaceDisplayPath(dir);
  if (display === "") return "";

  // The part that `..` cannot climb above: a scheme and host, a UNC host and
  // share, a drive, or the root
  let prefix = "";
  let rest = display;
  const uri = /^([a-z][a-z0-9+.-]+:\/\/[^/]*)(.*)$/i.exec(display);
  const unc = /^(\/\/[^/]+\/[^/]+)(.*)$/.exec(display);
  const drive = /^([a-zA-Z]:)(.*)$/.exec(display);
  if (uri) {
    [, prefix, rest] = uri;
  } else if (unc) {
    [, prefix, rest] = unc;
  } else if (drive) {
    prefix = drive[1].toLowerCase();
    rest = drive[2];
  }
  const absolute = prefix !== "" || rest.startsWith("/");

  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  let result: string;
  if (prefix === "") {
    result = (absolute ? "/" : "") + parts.join("/");
  } else {
    result = `${prefix}/${parts.join("/")}`;
    if (parts.length > 0 || !drive) result = result.replace(/\/$/, "");
  }
  return caseInsensitive ? result.toLowerCase() : result;
}

/** Number of folder names below the root, drive, share or host. */
function depth(normalized: string): number {
  const rest = normalized
    .replace(/^[a-z][a-z0-9+.-]+:\/\/[^/]*/i, "")
    .replace(/^\/\/[^/]+\/[^/]+/, "")
    .replace(/^[a-z]:/i, "");
  return rest.split("/").filter(Boolean).length;
}

/** `inner` is `outer` or a folder below it (both normalised). */
function isWithin(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  const base = outer.endsWith("/") ? outer : `${outer}/`;
  return inner.startsWith(base);
}

export interface WorkspaceMatchOptions {
  /** Compare without case (Windows and macOS); see `isCaseInsensitivePlatform`. */
  caseInsensitive?: boolean;
  /**
   * The person's home folder, when known: it never counts as containing a
   * workspace, so a session started in `~` does not match every project.
   */
  homeDir?: string;
  /**
   * The git top-level of a folder (as stored, not normalised), when the
   * caller can find it; `undefined` outside a repository. Two folders in the
   * same repository match.
   */
  gitRootOf?: (dir: string) => string | undefined;
}

/**
 * Folders this shallow (a root, a drive, `/home/me`, `C:/Users/me`) are never
 * treated as containing a workspace: one would capture every project below it.
 */
const MIN_CONTAINER_DEPTH = 3;

/**
 * Whether a session saved in `sessionDir` belongs to the workspace made of
 * `workspaceDirs` (one folder for the CLI, every folder of a multi-root IDE
 * workspace). It does when, for any workspace folder:
 * - the two are the same folder;
 * - one contains the other, the containing one at least three levels deep
 *   and not the home folder (resuming from a subfolder of the repository);
 * - both are in the same git repository (`gitRootOf`).
 */
export function sessionMatchesWorkspace(
  sessionDir: string | undefined,
  workspaceDirs: string[],
  options: WorkspaceMatchOptions = {},
): boolean {
  if (!sessionDir || sessionDir.trim() === "") return false;
  const ci = options.caseInsensitive ?? false;
  const session = normalizeWorkspacePath(sessionDir, ci);
  if (session === "") return false;
  const home = options.homeDir
    ? normalizeWorkspacePath(options.homeDir, ci)
    : undefined;
  const canContain = (dir: string) =>
    dir !== home && depth(dir) >= MIN_CONTAINER_DEPTH;

  let sessionRoot: string | undefined | null = null;
  for (const raw of workspaceDirs) {
    if (!raw || raw.trim() === "") continue;
    const workspace = normalizeWorkspacePath(raw, ci);
    if (workspace === "") continue;
    if (workspace === session) return true;
    if (isWithin(workspace, session) && canContain(session)) return true;
    if (isWithin(session, workspace) && canContain(workspace)) return true;
    if (options.gitRootOf) {
      const workspaceRoot = options.gitRootOf(raw);
      if (workspaceRoot) {
        if (sessionRoot === null) {
          const found = options.gitRootOf(sessionDir);
          sessionRoot = found ? normalizeWorkspacePath(found, ci) : undefined;
        }
        if (
          sessionRoot !== undefined &&
          normalizeWorkspacePath(workspaceRoot, ci) === sessionRoot
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * A short name for a workspace folder: `~/...` below the home folder,
 * otherwise its last two folder names (`.../code/project`). The full path is
 * `workspaceDisplayPath`.
 */
export function shortWorkspaceLabel(dir: string, homeDir?: string): string {
  const display = workspaceDisplayPath(dir).replace(/\/+$/, "");
  if (display === "") return "No folder";
  if (homeDir) {
    const home = workspaceDisplayPath(homeDir).replace(/\/+$/, "");
    const ci = /^[a-zA-Z]:/.test(home);
    const a = ci ? display.toLowerCase() : display;
    const b = ci ? home.toLowerCase() : home;
    if (a === b) return "~";
    if (a.startsWith(`${b}/`)) return `~${display.slice(home.length)}`;
  }
  const parts = display.split("/").filter(Boolean);
  if (parts.length <= 2) return display;
  return `…/${parts.slice(-2).join("/")}`;
}

/** The group of sessions saved without a folder. */
export const NO_FOLDER_GROUP_KEY = "";
export const NO_FOLDER_LABEL = "No folder";

export interface WorkspaceSessionGroup<T> {
  /** Normalised folder; `NO_FOLDER_GROUP_KEY` for sessions without one. */
  key: string;
  /** Short name for the header (`shortWorkspaceLabel`). */
  label: string;
  /** Full folder path, for a tooltip or a second line. */
  path: string;
  /** The group of the workspace the person is in: always first when present. */
  isCurrent: boolean;
  /** Newest first. */
  sessions: T[];
}

export interface GroupSessionsOptions<T> extends WorkspaceMatchOptions {
  /** The folders of the workspace the person is in (none: no current group). */
  workspaceDirs: string[];
  getDirectory: (session: T) => string | undefined;
  /** When the session was last used, in ms; larger is newer. */
  getTime: (session: T) => number;
}

/**
 * Sessions grouped by workspace folder, in the order a list shows them:
 * 1. the current workspace's group (every matching session, whatever its
 *    exact subfolder), so its newest session is the very first row;
 * 2. the other folders, each ordered by its newest session;
 * 3. sessions with no folder, last.
 * Sessions inside a group are newest first; equal times keep input order.
 */
export function groupSessionsByWorkspace<T>(
  sessions: T[],
  options: GroupSessionsOptions<T>,
): WorkspaceSessionGroup<T>[] {
  const ci = options.caseInsensitive ?? false;
  const time = (s: T) => {
    const t = options.getTime(s);
    return Number.isFinite(t) ? t : 0;
  };
  const sorted = sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => time(b.session) - time(a.session) || a.index - b.index)
    .map(({ session }) => session);

  const workspaceDirs = options.workspaceDirs.filter(
    (d) => d && d.trim() !== "",
  );
  const matchCache = new Map<string, boolean>();
  const matches = (dir: string) => {
    let hit = matchCache.get(dir);
    if (hit === undefined) {
      hit = sessionMatchesWorkspace(dir, workspaceDirs, options);
      matchCache.set(dir, hit);
    }
    return hit;
  };

  const currentKey =
    workspaceDirs.length > 0
      ? normalizeWorkspacePath(workspaceDirs[0], ci)
      : undefined;
  const current: WorkspaceSessionGroup<T> | undefined =
    workspaceDirs.length > 0
      ? {
          key: currentKey!,
          label:
            shortWorkspaceLabel(workspaceDirs[0], options.homeDir) +
            (workspaceDirs.length > 1 ? ` (+${workspaceDirs.length - 1})` : ""),
          path: workspaceDirs.map(workspaceDisplayPath).join(", "),
          isCurrent: true,
          sessions: [],
        }
      : undefined;
  const others = new Map<string, WorkspaceSessionGroup<T>>();
  const noFolder: WorkspaceSessionGroup<T> = {
    key: NO_FOLDER_GROUP_KEY,
    label: NO_FOLDER_LABEL,
    path: "",
    isCurrent: false,
    sessions: [],
  };

  for (const session of sorted) {
    const dir = options.getDirectory(session);
    const key = dir ? normalizeWorkspacePath(dir, ci) : "";
    if (!dir || key === "") {
      noFolder.sessions.push(session);
    } else if (current && matches(dir)) {
      current.sessions.push(session);
    } else {
      let group = others.get(key);
      if (!group) {
        group = {
          key,
          label: shortWorkspaceLabel(dir, options.homeDir),
          path: workspaceDisplayPath(dir),
          isCurrent: false,
          sessions: [],
        };
        others.set(key, group);
      }
      group.sessions.push(session);
    }
  }

  // Map insertion order is the order of each folder's newest session
  return [
    ...(current && current.sessions.length > 0 ? [current] : []),
    ...others.values(),
    ...(noFolder.sessions.length > 0 ? [noFolder] : []),
  ];
}

/** The groups' sessions as one list, in display order. */
export function flattenSessionGroups<T>(
  groups: WorkspaceSessionGroup<T>[],
): T[] {
  return groups.flatMap((group) => group.sessions);
}

/** The newest session of the current workspace, if any. */
export function newestSessionInWorkspace<T>(
  sessions: T[],
  options: GroupSessionsOptions<T>,
): T | undefined {
  const [first] = groupSessionsByWorkspace(sessions, options);
  return first?.isCurrent ? first.sessions[0] : undefined;
}
