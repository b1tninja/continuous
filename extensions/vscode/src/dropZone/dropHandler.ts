import { defaultFileAndFolderSecurityIgnores } from "core/indexing/ignore";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";

/**
 * What a drop on the "Drop files here" tree view turns into.
 *
 * VS Code gives a tree view's `handleDrop` the dragged resources as one
 * `text/uri-list` entry (src/vs/editor/browser/dataTransfer.ts,
 * `toExternalVSDataTransfer`): the workbench's full internal list for the
 * Explorer and editor tabs, and `file:` URIs built from Electron's
 * `getPathForFile` for files and folders from the OS file manager. This module
 * reads that list and decides, per URI, whether it becomes an `@file` or
 * `@folder` chip or is refused. It never reads file contents; the chip is
 * resolved by the context provider when the message is sent.
 */

export const URI_LIST_MIME = "text/uri-list";

/** Most chips one drop may add; more than this is refused with a count. */
export const MAX_DROPPED_ITEMS = 50;

/** The part of `vscode.DataTransfer` the handler uses. */
export interface DropDataTransfer {
  get(mimeType: string): { asString(): PromiseLike<string> } | undefined;
}

export type DroppedKind = "file" | "folder";

/** One accepted resource, in the shape of the `addToChat` message items. */
export interface DropChip {
  type: DroppedKind;
  fullPath: string;
  name: string;
}

export interface DropRefusal {
  name: string;
  reason: string;
}

export interface DropOutcome {
  chips: DropChip[];
  refused: DropRefusal[];
}

export interface DropDeps {
  /** Workspace folder URIs, as `vscode.Uri.toString()` gives them. */
  workspaceDirs: string[];
  /** "file", "folder", or undefined when the resource does not exist. */
  stat(uri: string): Promise<DroppedKind | undefined>;
  /** Compare `file:` paths without case (Windows and default macOS volumes). */
  caseInsensitiveFiles?: boolean;
}

/**
 * The URIs of a `text/uri-list` value (RFC 2483: CRLF separated, `#` lines are
 * comments). VS Code writes `\r\n`; a bare `\n` is accepted too.
 */
export function parseUriList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * The URI without its fragment. An editor tab with a selection is dragged as
 * `file:///a.ts#L3,5-L9,1`; the chip names the file.
 */
export function stripFragment(uri: string): string {
  const hash = uri.indexOf("#");
  return hash === -1 ? uri : uri.slice(0, hash);
}

function schemeOf(uri: string): string | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  return match?.[1].toLowerCase();
}

function displayName(uri: string): string {
  try {
    return decodeURIComponent(getUriPathBasename(uri)) || uri;
  } catch {
    return getUriPathBasename(uri) || uri;
  }
}

/**
 * The resource's path relative to the workspace folder that holds it, or
 * undefined when it is in none of them. Dot segments are resolved before the
 * comparison (`findUriInDirs`).
 */
export function workspaceRelativePath(
  uri: string,
  workspaceDirs: string[],
  caseInsensitiveFiles = false,
): string | undefined {
  let found: ReturnType<typeof findUriInDirs>;
  try {
    found = findUriInDirs(uri, workspaceDirs);
  } catch {
    return undefined;
  }
  if (found.foundInDir !== null) {
    return found.relativePathOrBasename;
  }
  if (caseInsensitiveFiles && schemeOf(uri) === "file") {
    try {
      const lower = findUriInDirs(
        uri.toLowerCase(),
        workspaceDirs.map((d) => d.toLowerCase()),
      );
      if (lower.foundInDir !== null) {
        return lower.relativePathOrBasename;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * True when the workspace-relative path matches the security patterns the
 * indexer and the `@` file list already exclude (`core/indexing/ignore.ts`):
 * `.env*`, `*.pem`, `*.key`, `id_rsa`, `.ssh/`, `.aws/` and the rest. A folder
 * is also checked with a trailing slash, so `secrets/` refuses the folder
 * itself, and a file under a refused folder is refused by the library.
 */
export function isSecretPath(relativePath: string, kind?: DroppedKind) {
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!rel) {
    return false;
  }
  try {
    if (defaultFileAndFolderSecurityIgnores.ignores(rel)) {
      return true;
    }
    return (
      kind === "folder" &&
      defaultFileAndFolderSecurityIgnores.ignores(`${rel}/`)
    );
  } catch {
    // The ignore library rejects some paths; treat those as a concern.
    return true;
  }
}

/**
 * Turns a drop into chips and refusals. Order per URI: (1) only URIs, no
 * duplicates, no fragments; (2) refused when outside every workspace folder,
 * which covers `untitled:`, OS files from outside the project and local files
 * dropped on a remote window; (3) refused by name when it matches a security
 * pattern, before anything touches the file system; (4) the host is asked only
 * whether it is a file or a folder; a folder is checked by name again with
 * the trailing slash.
 */
export async function resolveDrop(
  dataTransfer: DropDataTransfer,
  deps: DropDeps,
): Promise<DropOutcome> {
  const entry = dataTransfer.get(URI_LIST_MIME);
  const raw = entry ? await entry.asString() : "";
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const line of parseUriList(raw)) {
    const uri = stripFragment(line);
    if (!schemeOf(uri) || seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    uris.push(uri);
  }

  const outcome: DropOutcome = { chips: [], refused: [] };
  for (const uri of uris) {
    const name = displayName(uri);
    if (outcome.chips.length >= MAX_DROPPED_ITEMS) {
      outcome.refused.push({
        name,
        reason: `only ${MAX_DROPPED_ITEMS} items can be added in one drop`,
      });
      continue;
    }
    const rel = workspaceRelativePath(
      uri,
      deps.workspaceDirs,
      deps.caseInsensitiveFiles,
    );
    if (rel === undefined) {
      outcome.refused.push({ name, reason: "is outside the workspace" });
      continue;
    }
    if (isSecretPath(rel, "file")) {
      outcome.refused.push({
        name,
        reason: "looks like it holds secrets or keys",
      });
      continue;
    }
    let kind: DroppedKind | undefined;
    try {
      kind = await deps.stat(uri);
    } catch {
      kind = undefined;
    }
    if (!kind) {
      outcome.refused.push({ name, reason: "was not found" });
      continue;
    }
    if (kind === "folder" && isSecretPath(rel, "folder")) {
      outcome.refused.push({
        name,
        reason: "looks like it holds secrets or keys",
      });
      continue;
    }
    outcome.chips.push({ type: kind, fullPath: uri, name });
  }
  return outcome;
}

/** One sentence for the person, or undefined when nothing was dropped. */
export function describeOutcome(outcome: DropOutcome): string | undefined {
  const { chips, refused } = outcome;
  if (chips.length === 0 && refused.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (chips.length > 0) {
    parts.push(
      chips.length === 1
        ? `Added ${chips[0].name} to the chat input.`
        : `Added ${chips.length} items to the chat input.`,
    );
  }
  if (refused.length > 0) {
    const shown = refused
      .slice(0, 3)
      .map((r) => `${r.name} ${r.reason}`)
      .join("; ");
    const more = refused.length > 3 ? ` (and ${refused.length - 3} more)` : "";
    parts.push(`Not added: ${shown}${more}.`);
  }
  return parts.join(" ");
}
