import type { Editor } from "@tiptap/react";
import { useEffect } from "react";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { newSession } from "../../../redux/slices/sessionSlice";
import { isEmptyDraft } from "../../../util/drafts";

/**
 * Typing in the main input while the resuming view is up (a saved session
 * still loading into an empty chat) means the person has moved on: the
 * load is dropped (thunks/session.ts fetchSessionToLoad), so it cannot
 * replace the chat under them.
 *
 * It takes a new session, not just the end of the load: the empty chat
 * still has the id of the session being loaded, and a message sent there
 * would be saved over it. The typed text stays in the input:
 * useDraftPersistence carries the draft into a new, empty session.
 */
export function useDropSessionLoadOnTyping(
  editor: Editor | null,
  enabled: boolean,
) {
  const dispatch = useAppDispatch();
  const isResuming = useAppSelector(
    (s) =>
      !!s.session.loadingSessionId &&
      s.session.history.length === 0 &&
      !s.session.isInEdit,
  );

  useEffect(() => {
    if (!editor || !enabled || !isResuming) return;
    const onUpdate = () => {
      // Clearing the input, or a draft put back without an update, is not typing
      if (isEmptyDraft(editor.getJSON())) return;
      dispatch(newSession());
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor, enabled, isResuming, dispatch]);
}
