import type { ToolExtras } from "../../index.js";
import { isOutsideDirs } from "../../util/ideUtils.js";
import { wroteOutsideNote } from "../permissions/outsideEdits.js";

/**
 * The transcript note for a write that landed outside the workspace, or
 * undefined for one that did not. It is judged by where the file is, not by
 * the option, so it never says it when the target was inside.
 */
export async function outsideWriteNote(
  extras: Pick<ToolExtras, "ide" | "allowOutsideWorkspace">,
  fileUri: string,
): Promise<string | undefined> {
  if (!extras.allowOutsideWorkspace) return undefined;
  const dirs = await extras.ide.getWorkspaceDirs();
  return isOutsideDirs(fileUri, dirs) ? wroteOutsideNote(fileUri) : undefined;
}
