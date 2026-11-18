import { createAsyncThunk } from "@reduxjs/toolkit";
import type { Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { forkSession } from "core/util/forkSession";
import { renderChatMessage } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  restoreHistoryBeforeEdit,
  setEditUndo,
  type ChatHistoryItemWithMessageId,
} from "../slices/sessionSlice";
import type { RootState, ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { refreshSessionMetadata, saveCurrentSession } from "./session";

/*
 * Editing an earlier message keeps what it replaces (NI7). Before the edit
 * truncates the conversation, the whole conversation is saved as a session
 * of its own, "<title> (before edit)", a fork of this one (forkedFrom, the
 * copy table of core/util/forkSession.ts). It is an ordinary session: it is
 * listed in History, opens like any other, and Delete moves it to the trash
 * (#886), where it is restorable for 7 days. The open session's file is the
 * edited conversation, so neither the session log (#869) nor a session's
 * shape changes.
 *
 * Undo puts the conversation from before the edit back in the open session,
 * and the copy takes the edited version instead ("<title> (undone edit)"),
 * so undoing loses nothing either.
 */

export const BEFORE_EDIT_SUFFIX = " (before edit)";
export const UNDONE_EDIT_SUFFIX = " (undone edit)";

/** The open session's title, or its first message when it has none yet. */
function sessionTitle(state: RootState): string {
  const s = state.session;
  const known = s.allSessionMetadata.find((m) => m.sessionId === s.id)?.title;
  const title =
    s.title && s.title !== NEW_SESSION_TITLE ? s.title : (known ?? "");
  if (title && title !== NEW_SESSION_TITLE) return title;
  const first = s.history.find((item) => item.message.role === "user");
  const line = first
    ? (renderChatMessage(first.message)
        .split("\n")
        .find((l) => l.trim()) ?? "")
    : "";
  return line.trim().slice(0, 80) || "Chat";
}

/** `history` as a session of its own, a fork of the open one. */
function copyOfSession(
  state: RootState,
  history: ChatHistoryItemWithMessageId[],
  title: string,
  sessionId: string,
): Session {
  const s = state.session;
  const parent: Session = {
    sessionId: s.id,
    title,
    workspaceDirectory: window.workspacePaths?.[0] || "",
    history,
    mode: s.mode,
    chatModelTitle: selectSelectedChatModel(state)?.title ?? null,
    ...(s.taskPlan && { taskPlan: s.taskPlan }),
  };
  const copy = forkSession(parent, { sessionId });
  copy.title = title;
  return copy;
}

/** How many messages an edit at `index` replaces: that one and every later one. */
export function replacedByEdit(
  history: ChatHistoryItemWithMessageId[],
  index: number,
): number {
  return history.slice(index).filter((item) => item.message.role !== "system")
    .length;
}

/**
 * Before an edit of the message at `index` replaces the conversation's tail:
 * `before` (the history as it is now) is saved as "<title> (before edit)",
 * and the undo line gets what Undo needs. The edit does not wait for the
 * save; the line says when it failed.
 */
export const keepReplacedTurns = createAsyncThunk<
  void,
  { index: number; before: ChatHistoryItemWithMessageId[] },
  ThunkApiType
>(
  "session/keepReplacedTurns",
  async ({ index, before }, { dispatch, getState, extra }) => {
    if (index < 0 || index >= before.length) return;
    const replaced = replacedByEdit(before, index);
    if (replaced === 0) return;
    const state = getState();
    const copySessionId = uuidv4();
    const copyTitle = `${sessionTitle(state)}${BEFORE_EDIT_SUFFIX}`;
    dispatch(
      setEditUndo({
        before,
        index,
        replaced,
        copySessionId,
        copyTitle,
        saved: "pending",
      }),
    );
    let saved: "saved" | "failed" = "failed";
    try {
      const result = await extra.ideMessenger.request(
        "history/save",
        copyOfSession(state, before, copyTitle, copySessionId),
      );
      if (result.status === "success") saved = "saved";
    } catch (e) {
      console.error("The conversation before the edit was not saved", e);
    }
    const now = getState().session.editUndo;
    if (now?.copySessionId === copySessionId) {
      dispatch(setEditUndo({ ...now, saved }));
    }
    void dispatch(refreshSessionMetadata({}));
  },
);

/**
 * Undo on the undo line: the edited turn is stopped if it still runs, the
 * conversation from before the edit comes back, and the copy holds the
 * edited version instead. Files the edited turn changed are not touched;
 * Restore to here does that.
 */
export const undoEdit = createAsyncThunk<void, undefined, ThunkApiType>(
  "session/undoEdit",
  async (_, { dispatch, getState, extra }) => {
    const undo = getState().session.editUndo;
    if (!undo) return;
    if (getState().session.isStreaming) await dispatch(cancelStream());
    const state = getState();
    const edited = state.session.history;
    dispatch(restoreHistoryBeforeEdit(undo.before));

    const base = undo.copyTitle.endsWith(BEFORE_EDIT_SUFFIX)
      ? undo.copyTitle.slice(0, -BEFORE_EDIT_SUFFIX.length)
      : undo.copyTitle;
    try {
      await extra.ideMessenger.request(
        "history/save",
        copyOfSession(
          state,
          edited,
          `${base}${UNDONE_EDIT_SUFFIX}`,
          undo.copySessionId,
        ),
      );
    } catch (e) {
      console.error("The edited version was not kept", e);
    }
    await dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );
    void dispatch(refreshSessionMetadata({}));
  },
);
