import type { IDE } from "..";

/**
 * The folders a file tool may resolve a path in: the IDE's workspace folders,
 * then the folders the person added with `additionalFolders` in config.yaml.
 * Both count as the workspace for every file tool, edits included.
 *
 * The chat page bundles this file and has no filesystem, so this file imports
 * nothing from Node. The Node side registers how to read the added folders
 * (`registerWorkspaceFolderExtender`, called by
 * tools/permissions/additionalFolders.ts when it loads). Where nothing is
 * registered, the IDE's folders are all there is.
 */
type Extender = (opened: string[]) => string[];

let extender: Extender | undefined;

export function registerWorkspaceFolderExtender(fn: Extender): void {
  extender = fn;
}

/** The workspace folders with the added ones, or just these when none can be read. */
export function withAddedFolders(opened: string[]): string[] {
  if (!extender) return opened;
  try {
    return extender(opened);
  } catch {
    return opened;
  }
}

export async function workspaceFoldersForFiles(ide: IDE): Promise<string[]> {
  return withAddedFolders(await ide.getWorkspaceDirs());
}
