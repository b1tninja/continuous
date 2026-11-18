/**
 * Why an edit was not applied, worded for the model that asked for it. The
 * chat turns the error of an `applyToFile` request into the tool call's
 * result (gui `applyForEditTool`), so every way an apply can stop without
 * writing must throw one of these. A quiet `return` left the tool call
 * running forever: the chat held every new message in its queue and Stop
 * could not end the turn.
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

const MESSAGES: Record<EditNotAppliedReason, string> = {
  [EditNotAppliedReason.FileChanged]:
    "The file changed in the editor while the edit was being applied (it was typed in, or changed on disk), so nothing was written. Read the file again and retry the edit.",
  [EditNotAppliedReason.NoEditor]:
    "No editor could be opened for the file, so nothing was written. Check the path and retry.",
  [EditNotAppliedReason.NoDiffView]:
    "The edit could not be shown as a diff, so nothing was written. Retry the edit.",
  [EditNotAppliedReason.NoApplyModel]:
    "No model is available to apply the edit (none has the apply or chat role, or the config did not load), so nothing was written.",
};

export function editNotAppliedMessage(reason: EditNotAppliedReason): string {
  return MESSAGES[reason];
}

export class EditNotAppliedError extends Error {
  constructor(readonly reason: EditNotAppliedReason) {
    super(editNotAppliedMessage(reason));
    this.name = "EditNotAppliedError";
  }
}
