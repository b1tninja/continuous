import type { ApprovalSettings } from "./approval";
import { uriToPath } from "./names";

/**
 * Whether a file tool may name a path outside the workspace and carry it out:
 * when the outside-paths check is off. That check is a switch like the others,
 * and a preset sets it (the IDGAF preset leaves no check on), so there is one
 * question and one answer in every host: the IDE, the CLI, headless and
 * `serve`. Where a file is no longer decides anything once the check is off,
 * for the permission layer or for the tool.
 *
 * The locked floor (permission and policy files), a tool switched off, an
 * organisation ceiling and the person's own `floor:` rules are settled by the
 * evaluator before a call gets here, and still hold.
 */
export function editsAllowOutsideWorkspace(
  approval: Pick<ApprovalSettings, "builtin"> | undefined,
): boolean {
  // A host without settings allows nothing extra
  if (!approval) return false;
  return approval.builtin?.["ask-outside-paths"] === false;
}

/** The note that goes in the transcript when a write lands outside the workspace. */
export function wroteOutsideNote(target: string): string {
  const shown = target.startsWith("file:")
    ? (uriToPath(target) ?? target)
    : target;
  return `Wrote outside the workspace: ${shown}`;
}

/** Added to the audit reason of an allowed call whose target is outside the workspace. */
export function outsideTargetReason(target: string): string {
  return `The target is outside the workspace: ${target}.`;
}
