import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setEditUndo } from "../../redux/slices/sessionSlice";
import { undoEdit } from "../../redux/thunks/editCopy";
import { confirmSessionSwitch } from "../../redux/thunks/interruptConfirm";
import { loadSession } from "../../redux/thunks/session";
import { NoticeAction, NoticeBar } from "./NoticeBar";

/** The undo line's sentence for `replaced` messages kept in `title`. */
export function editUndoText(
  replaced: number,
  title: string,
  saved: "pending" | "saved" | "failed",
): string {
  const messages = replaced === 1 ? "message is" : `${replaced} messages are`;
  if (saved === "failed") {
    return `Edited. The replaced ${replaced === 1 ? "message" : "messages"} could not be saved to History; Undo still brings them back.`;
  }
  return `Edited. The ${messages} kept in "${title}".`;
}

/**
 * Above the input after an earlier message was edited (NI7): what the edit
 * replaced is kept as a session of its own, Undo brings it back here, View
 * opens the copy. Stays until the next message, a dismiss or another session.
 */
export function EditUndoLine() {
  const dispatch = useAppDispatch();
  const undo = useAppSelector((s) => s.session.editUndo);
  if (!undo) return null;

  const view = async () => {
    if (!(await dispatch(confirmSessionSwitch("openSession")).unwrap())) {
      return;
    }
    await dispatch(
      loadSession({ sessionId: undo.copySessionId, saveCurrentSession: true }),
    );
  };

  return (
    <NoticeBar
      testId="edit-undo-line"
      onDismiss={() => dispatch(setEditUndo(undefined))}
    >
      <span>{editUndoText(undo.replaced, undo.copyTitle, undo.saved)}</span>
      <NoticeAction
        testId="edit-undo"
        title="Brings the conversation from before the edit back; the edited version is kept in History instead"
        onClick={() => void dispatch(undoEdit())}
      >
        Undo
      </NoticeAction>
      {undo.saved === "saved" && (
        <NoticeAction
          testId="edit-undo-view"
          title="Opens the saved copy of the conversation from before the edit"
          onClick={() => void view()}
        >
          View
        </NoticeAction>
      )}
    </NoticeBar>
  );
}
