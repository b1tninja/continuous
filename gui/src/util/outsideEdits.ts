import type { ContextItem, IDE } from "core";
import {
  editsAllowOutsideWorkspace,
  wroteOutsideNote,
} from "core/tools/permissions/outsideEdits";
import { isOutsideDirs } from "core/util/ideUtils";
import { selectApprovalSettings } from "../redux/selectors/selectAutoApproval";
import type { RootState } from "../redux/store";

/**
 * True while the outside-paths check is off (the IDGAF preset leaves no check
 * on): the file tools may then name a path outside the workspace. The
 * decision was already made by the permission layer (core's
 * tools/evaluatePolicy); this lets the tool resolve the path instead of
 * treating it as not a target.
 */
export function allowOutsideWorkspaceOf(state: RootState | undefined): boolean {
  // A host without the settings (a partial state) allows nothing extra
  if (!state?.ui?.policyLevels) return false;
  return editsAllowOutsideWorkspace(selectApprovalSettings(state));
}

/**
 * True while the protect-secrets check is off: the file tools may then read
 * and write a file that looks like a secret. Like the outside-paths stop, the
 * permission layer has already decided the call; this only lifts the tool's
 * own refusal.
 */
export function allowSecretFilesOf(state: RootState | undefined): boolean {
  if (!state?.ui?.policyLevels) return false;
  return selectApprovalSettings(state).builtin?.["protect-secrets"] === false;
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
