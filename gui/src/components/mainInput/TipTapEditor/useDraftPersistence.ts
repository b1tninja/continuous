import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearDraft,
  isEmptyDraft,
  loadDraft,
  MAIN_DRAFT_INPUT,
  restoredDraftNotice,
  saveDraft,
} from "../../../util/drafts";

/** How long typing pauses before the draft is saved. */
export const DRAFT_SAVE_DEBOUNCE_MS = 500;

/**
 * Keeps an input's unsent text in the webview's storage, per session (see
 * util/drafts). `inputId` is MAIN_DRAFT_INPUT for the main input, or the id
 * of the earlier message being edited.
 *
 * - When the session is opened (or the panel reloads), its draft comes back
 *   with a notice.
 * - Typing saves it, 500 ms after the last change; hiding or closing the page
 *   saves at once.
 * - Sending clears it (`clearNow`).
 *
 * Switching the main input to another session saves the text under the
 * session it was typed in and shows the other session's draft, or an empty
 * input. A new, empty session takes the text along instead, as the input did
 * before drafts were kept, and the draft moves with it.
 *
 * An earlier message's draft is kept only while it differs from the message.
 */
export function useDraftPersistence(options: {
  editor: Editor | null;
  sessionId: string;
  inputId: string;
  enabled: boolean;
  /** The session has no messages (a new chat) */
  isSessionEmpty: boolean;
}) {
  const { editor, sessionId, inputId, enabled } = options;
  const [notice, setNotice] = useState<string>();
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSession = useRef<string | undefined>(undefined);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const isSessionEmpty = useRef(options.isSessionEmpty);
  isSessionEmpty.current = options.isSessionEmpty;

  useEffect(() => {
    if (!editor || !enabled || !sessionId) return;
    const isMain = inputId === MAIN_DRAFT_INPUT;
    const previous = lastSession.current;
    lastSession.current = sessionId;

    // An earlier message's own content: a draft equal to it is no draft
    const baseline = isMain ? undefined : JSON.stringify(editor.getJSON());

    // Re-enabled in the same session (edit mode ended): the input is as it was
    if (previous !== sessionId) {
      const draft = loadDraft(sessionId, inputId);
      if (draft) {
        editor.commands.setContent(draft.content, { emitUpdate: false });
        setNotice(restoredDraftNotice(draft));
      } else {
        setNotice(undefined);
        if (isMain && previous) {
          const carried = editor.getJSON();
          if (isEmptyDraft(carried)) {
            // Nothing to carry
          } else if (isSessionEmpty.current) {
            saveDraft(sessionId, inputId, carried);
            clearDraft(previous, inputId);
          } else {
            // Kept under the session it was typed in, even when it came in
            // without an edit (restored after edit mode, say)
            saveDraft(previous, inputId, carried);
            editor.commands.clearContent(false);
          }
        }
      }
    }

    const save = () => {
      pending.current = undefined;
      if (editor.isDestroyed) return;
      const json = editor.getJSON();
      if (baseline !== undefined && JSON.stringify(json) === baseline) {
        clearDraft(sessionId, inputId);
      } else {
        saveDraft(sessionId, inputId, json);
      }
    };
    const flush = () => {
      if (pending.current === undefined) return;
      clearTimeout(pending.current);
      save();
    };
    const onUpdate = () => {
      if (pending.current !== undefined) clearTimeout(pending.current);
      pending.current = setTimeout(save, DRAFT_SAVE_DEBOUNCE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    editor.on("update", onUpdate);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      editor.off("update", onUpdate);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [editor, sessionId, inputId, enabled]);

  /** The message was sent: its draft goes, and so does the notice. */
  const clearNow = useCallback(() => {
    if (pending.current !== undefined) {
      clearTimeout(pending.current);
      pending.current = undefined;
    }
    clearDraft(currentSession.current, inputId);
    setNotice(undefined);
  }, [inputId]);

  const dismissNotice = useCallback(() => setNotice(undefined), []);

  return { notice, dismissNotice, clearNow };
}
