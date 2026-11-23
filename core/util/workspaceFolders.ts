import type { IDE } from "..";

/**
 * The folders a file tool may resolve a path in: the IDE's workspace folders,
 * then the folders the person added with `additionalFolders` in config.yaml.
 * Both count as the workspace for every file tool, edits included.
 *
 * The added folders are read with Node only; the chat page bundles this file and
 * has no filesystem, so there the IDE's folders are all there is.
 */
export async function workspaceFoldersForFiles(ide: IDE): Promise<string[]> {
  const opened = await ide.getWorkspaceDirs();
  if (typeof process === "undefined") return opened;
  // Where Node's path is missing (the webview bundle) the import or its calls
  // throw: the IDE's folders are all there is then
  try {
    const m = await import("../tools/permissions/additionalFolders");
    return m.withAdditionalFolders(opened, m.readUserAdditionalFolders());
  } catch {
    return opened;
  }
}
