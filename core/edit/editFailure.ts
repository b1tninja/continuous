import { ContinueErrorReason } from "../util/errors";

/**
 * What the model is told when an edit tool did not change the file. "Failed
 * to edit <file>" named no cause: of 27 such results followed by another edit
 * of the file, 9 re-read it first, and 13 files were rewritten whole
 * (plans/research/agent-guidance-review-2026-11-21.md, 4.3). Each result
 * here says the cause, then what the file holds, then the next step.
 */

/** Why an edit did not change the file. */
export type EditFailureCause =
  /** old_string is not in the file. */
  | "not-found"
  /** old_string is in the file more than once, and replace_all was not set. */
  | "not-unique"
  /** The file was typed in, or changed on disk, after the edit read it. */
  | "file-changed"
  /** No file at the path. */
  | "file-missing"
  /** The person rejected the diff, or cancelled the call. */
  | "rejected"
  /** The arguments are not a valid edit (same old and new text, no edits). */
  | "invalid-arguments"
  /** The step that writes the edit into the editor failed. */
  | "apply-failed"
  /** Stopped before anything was written, for a reason that has no cause of its own. */
  | "other";

/**
 * Why an apply stopped without writing, as the IDE reports it. The IDE
 * returns the reason from `applyToFile`, so the cause is not read back out of
 * an error message.
 */
export enum EditNotAppliedReason {
  /** The document was typed in, or changed on disk, after the edit read it. */
  FileChanged = "file-changed",
  /** No editor could be opened or found for the file. */
  NoEditor = "no-editor",
  /** The diff view for the file could not be created. */
  NoDiffView = "no-diff-view",
  /** The config, or a model for the apply role, was not available. */
  NoApplyModel = "no-apply-model",
}

const NOT_APPLIED_DETAIL: Record<EditNotAppliedReason, string | undefined> = {
  [EditNotAppliedReason.FileChanged]: undefined,
  [EditNotAppliedReason.NoEditor]: "No editor could be opened for the file.",
  [EditNotAppliedReason.NoDiffView]: "The edit could not be shown as a diff.",
  [EditNotAppliedReason.NoApplyModel]:
    "No model is available to apply the edit: none has the apply or chat role, or the config did not load.",
};

/** The edit tools of the IDE, by the name the model calls. */
export const IDE_EDIT_TOOL_NAMES: readonly string[] = [
  "edit_existing_file",
  "single_find_and_replace",
  "multi_edit",
];

export function isIdeEditTool(toolName: string | undefined): boolean {
  return !!toolName && IDE_EDIT_TOOL_NAMES.includes(toolName);
}

/**
 * The cause an error's reason names, for an error raised before the apply
 * (argument checks, the search for old_string). Nothing has been written at
 * that point, so a reason with no cause of its own is "other".
 */
export function editFailureCauseOf(
  reason: ContinueErrorReason | undefined,
): EditFailureCause {
  switch (reason) {
    case ContinueErrorReason.FindAndReplaceOldStringNotFound:
      return "not-found";
    case ContinueErrorReason.FindAndReplaceMultipleOccurrences:
      return "not-unique";
    case ContinueErrorReason.FileNotFound:
      return "file-missing";
    case ContinueErrorReason.FindAndReplaceIdenticalOldAndNewStrings:
    case ContinueErrorReason.FindAndReplaceMissingOldString:
    case ContinueErrorReason.FindAndReplaceNonFirstEmptyOldString:
    case ContinueErrorReason.FindAndReplaceWhitespaceOnlyOldString:
    case ContinueErrorReason.FindAndReplaceMissingNewString:
    case ContinueErrorReason.FindAndReplaceInvalidReplaceAll:
    case ContinueErrorReason.FindAndReplaceMissingFilepath:
    case ContinueErrorReason.MultiEditEditsArrayRequired:
    case ContinueErrorReason.MultiEditEditsArrayEmpty:
    case ContinueErrorReason.MultiEditSubsequentEditsOnCreation:
    case ContinueErrorReason.MultiEditEmptyOldStringNotFirst:
      return "invalid-arguments";
    default:
      return "other";
  }
}

export interface EditFailure {
  /** The tool as the model called it. */
  tool: string;
  /** The path as the model gave it; "the file" when it gave none. */
  file?: string;
  cause: EditFailureCause;
  /**
   * What the failing step said: the closest region for a text that was not
   * found, the argument that is wrong, the apply step's own message.
   */
  detail?: string;
  /** For "apply-failed": the IDE's reason, when it gave one. */
  notApplied?: EditNotAppliedReason;
}

const REREAD = (file: string) =>
  `Read ${file} again and retry with the exact current text. Do not rewrite the whole file.`;

function sentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The tool result for an edit that did not change the file. */
export function editFailureResult(failure: EditFailure): string {
  const { tool, cause } = failure;
  const named = failure.file?.trim();
  const file = named || "the file";
  // At the start of a sentence
  const File = named || "The file";
  const detail = sentence(failure.detail);
  const lead = `${tool} did not change ${file}`;
  // multi_edit computes every edit before it writes any
  const unchanged =
    tool === "multi_edit"
      ? `${File} is unchanged: multi_edit writes all of its edits or none.`
      : `${File} is unchanged.`;
  const lines = (...parts: (string | undefined)[]) =>
    parts.filter((p): p is string => !!p).join("\n");

  switch (cause) {
    case "not-found":
      return lines(
        `${lead}: the old text was not found in the file.`,
        detail,
        `${unchanged} ${REREAD(file)}`,
      );
    case "not-unique":
      return lines(
        `${lead}: the old text was found more than once.`,
        detail,
        `${unchanged} Retry with more surrounding lines in old_string, or with replace_all set to true. Do not rewrite the whole file.`,
      );
    case "file-changed":
      return `${lead}: the file changed since it was read (it was typed in, or changed on disk). Nothing from this call was written. ${REREAD(file)}`;
    case "file-missing":
      return `${lead}: the file does not exist. Nothing was written. Check the path and retry with a file that exists.`;
    case "rejected":
      return `The person rejected this ${tool} edit of ${file}. ${File} is unchanged. Do not send the same edit again.`;
    case "invalid-arguments":
      return lines(
        `${lead}: the arguments are not a valid edit.`,
        detail,
        `${unchanged} Correct the arguments and send the call again.`,
      );
    case "apply-failed": {
      const reason = failure.notApplied
        ? NOT_APPLIED_DETAIL[failure.notApplied]
        : detail;
      if (failure.notApplied === EditNotAppliedReason.FileChanged) {
        return editFailureResult({ ...failure, cause: "file-changed" });
      }
      if (failure.notApplied === EditNotAppliedReason.NoApplyModel) {
        // A retry meets the same missing model
        return `${lead}: the apply step failed. ${reason} Nothing was written. Do not send this call again. Say that the edit could not be applied and why.`;
      }
      if (failure.notApplied) {
        return `${lead}: the apply step failed. ${reason} Nothing was written. Send the edit again once. Do not rewrite the whole file.`;
      }
      // An apply that threw may have stopped part-way
      return lines(
        `${lead}: the apply step failed${reason ? "." : " and gave no reason."}`,
        reason,
        `Read ${file} to see what it holds now, then send the edit again once. Do not rewrite the whole file.`,
      );
    }
    default:
      return lines(`${lead}.`, detail, unchanged);
  }
}

/**
 * The result of a cancelled call to an edit tool, or undefined for any other
 * tool. A cancelled edit is a diff the person rejected or a call they
 * declined; either way the file is as it was.
 */
export function cancelledEditResult(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (!toolName || !isIdeEditTool(toolName)) return undefined;
  const filepath = (args as { filepath?: unknown } | undefined)?.filepath;
  return editFailureResult({
    tool: toolName,
    file: typeof filepath === "string" ? filepath : undefined,
    cause: "rejected",
  });
}
