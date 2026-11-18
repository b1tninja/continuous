import { defaultFileAndFolderSecurityIgnores } from "core/indexing/ignore";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";

import type {
  AddToChatPayload,
  AddToChatPayloadItem,
  AddToChatRefusal,
} from "core";

/**
 * What the "Add to Continuous Chat" commands need from VS Code. Kept apart
 * from the `vscode` module so the handlers can be tested with plain data.
 * Every value is a URI string (`uri.toString()`), never a file system path,
 * so remote (`vscode-remote:`) and virtual (`vscode-vfs:`) workspaces work.
 */
export interface AddToChatHost {
  /** The workspace folders, as URI strings. */
  workspaceDirs(): string[];
  /** Whether the URI is a file or a folder; undefined when it is not there. */
  stat(uri: string): Promise<"file" | "folder" | undefined>;
}

/** Schemes the menus offer the commands for; see the `when` clauses in package.json. */
export const ADD_TO_CHAT_SCHEMES = ["file", "vscode-remote", "vscode-vfs"];

/**
 * True when a workspace-relative path matches the security patterns the
 * indexer and the `@` file picker exclude (`core/indexing/ignore.ts`). A
 * folder is checked with and without the trailing slash, because the folder
 * patterns are written as `name/`.
 */
export function isSecretPath(
  relativePath: string,
  kind: "file" | "folder",
): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!normalized) {
    return false;
  }
  try {
    return (
      defaultFileAndFolderSecurityIgnores.ignores(normalized) ||
      (kind === "folder" &&
        defaultFileAndFolderSecurityIgnores.ignores(`${normalized}/`))
    );
  } catch {
    // The ignore library rejects some paths; treat those as a concern.
    return true;
  }
}

function schemeOf(uri: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Turns the resources a menu or command handed over into the `addToChat`
 * message for the chat input. Each resource is, in order: dropped if it is a
 * duplicate; refused if unsaved or outside every workspace folder; refused
 * if the host cannot find it; refused if its workspace-relative path matches
 * a security pattern; otherwise sent as a file or folder.
 * Nothing is read here: the chip is a reference, and the `file` provider
 * reads the file when the message is sent.
 */
export async function buildAddToChatPayload(
  uris: string[],
  host: AddToChatHost,
): Promise<AddToChatPayload> {
  const data: AddToChatPayloadItem[] = [];
  const refused: AddToChatRefusal[] = [];
  // Longest first, so a nested workspace folder wins over its parent.
  const dirs = [...host.workspaceDirs()].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();

  for (const uri of uris) {
    if (seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    const name = getUriPathBasename(uri) || uri;
    const scheme = schemeOf(uri);

    if (scheme === "untitled") {
      refused.push({ name, reason: "unsaved" });
      continue;
    }

    let relative: string;
    let foundInDir: string | null;
    try {
      ({ relativePathOrBasename: relative, foundInDir } = findUriInDirs(
        uri,
        dirs,
      ));
    } catch {
      foundInDir = null;
      relative = "";
    }
    if (!foundInDir) {
      refused.push({ name, reason: "outside-workspace" });
      continue;
    }

    // Only metadata is asked for: whether it is there, and its type, which
    // decides the chip and which security patterns apply.
    const kind = await host.stat(uri);
    if (!kind) {
      refused.push({ name, reason: "not-found" });
      continue;
    }
    if (isSecretPath(relative, kind)) {
      refused.push({ name, reason: "secret" });
      continue;
    }
    data.push({ type: kind, fullPath: uri, name });
  }

  return refused.length ? { data, refused } : { data };
}

/**
 * The resources a menu command was invoked on. Explorer menus pass
 * `(clicked, selected[])`; editor menus pass `(uri, context)` where the
 * context is not a list; the palette passes nothing, which falls back to
 * the active editor.
 */
export function urisFromCommandArgs<T>(
  clicked: T | undefined,
  selected: unknown,
  activeEditorUri: T | undefined,
): T[] {
  if (Array.isArray(selected) && selected.length > 0) {
    return selected as T[];
  }
  if (clicked && typeof clicked === "object") {
    return [clicked];
  }
  return activeEditorUri ? [activeEditorUri] : [];
}

/**
 * The resource behind an editor tab: `uri` for text, notebook and custom
 * editors, the modified side for a diff. Terminals, webviews and other
 * inputs without a resource give undefined.
 */
export function uriOfTabInput<T>(input: unknown): T | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as { uri?: T; modified?: T };
  return record.uri ?? record.modified;
}
