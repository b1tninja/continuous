import type { ContextItem, IDE } from "core";
import {
  editsAllowOutsideWorkspace,
  wroteOutsideNote,
} from "core/tools/permissions/outsideEdits";
import { isOutsideDirs } from "core/util/ideUtils";
import { selectApprovalSettings } from "../redux/selectors/selectAutoApproval";
import type { RootState } from "../redux/store";

/**
 * True while File edits is IDGAF: the file tools may then name a path
 * outside the workspace. The decision was already made by the permission
 * layer (core's tools/evaluatePolicy), which lets such a call through only at
 * that level; this lets the tool resolve the path instead of treating it as
 * not a target.
 */
export function allowOutsideWorkspaceOf(state: RootState | undefined): boolean {
  // A host without the settings (a partial state) allows nothing extra
  if (!state?.ui?.policyLevels) return false;
  return editsAllowOutsideWorkspace(selectApprovalSettings(state));
}

/**
 * The transcript note for an edit the editor applied to a file outside the
 * workspace, or undefined for one inside it (or when the level does not allow
 * it, in which case the person approved it by hand and saw the card).
 */
export async function outsideEditNote(
  ide: IDE,
  filepath: string | undefined,
  allowOutside: boolean,
): Promise<ContextItem | undefined> {
  if (!allowOutside || !filepath) return undefined;
  const dirs = await ide.getWorkspaceDirs();
  if (!isOutsideDirs(filepath, dirs)) return undefined;
  return {
    icon: "info",
    name: "Edit outside the workspace",
    description: filepath,
    content: wroteOutsideNote(filepath),
    hidden: false,
  };
}
