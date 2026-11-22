import { EditNotAppliedReason } from "core/edit/editFailure";

/**
 * Why an edit was not applied. The `applyToFile` handler returns the reason
 * to the chat, which words the tool call's result from it (gui
 * `applyForEditTool`, core `editFailureResult`), so every way an apply can
 * stop without writing must throw one of these. A quiet `return` left the
 * tool call running forever: the chat held every new message in its queue
 * and Stop could not end the turn.
 *
 * The reasons live in core, so the chat names the cause without reading it
 * back out of a message.
 */
export { EditNotAppliedReason };

// For the log and the error itself; the model's text is core's
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
