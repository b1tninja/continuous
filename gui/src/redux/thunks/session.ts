import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { BaseSessionMetadata, ChatMessage, Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import type { TrashSessionResult } from "core/util/history";
import { renderChatMessage } from "core/util/messageContent";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import { selectSelectedProfile } from "../slices/profilesSlice";
import {
  deleteSessionMetadata,
  newSession,
  setAllSessionMetadata,
  setIsSessionMetadataLoading,
  setLoadingSessionId,
  setSessionLoadNotice,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { saveSessionToCore } from "../util/sessionDelta";
import {
  currentWorkspaceDirs,
  lastSessionCandidates,
  sessionBelongsToWorkspace,
  workspaceKey,
} from "../../util/sessionWorkspace";
import { updateSelectedModelByRole } from "../thunks/updateSelectedModelByRole";
import { clearSessionDrafts, pruneDrafts } from "../../util/drafts";

const MAX_TITLE_LENGTH = 100;
/** The most sessions core's `history/list` answers when no limit is given (core.ts) */
const HISTORY_LIST_DEFAULT_LIMIT = 100;

// Async session functions live in thunks (because of IDE messaging mostly)
// see sessionSlice for sync redux session functions

export async function getSession(
  ideMessenger: IIdeMessenger,
  id: string,
): Promise<Session> {
  const result = await ideMessenger.request("history/load", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.content;
}

export const refreshSessionMetadata = createAsyncThunk<
  BaseSessionMetadata[],
  {
    offset?: number;
    limit?: number;
  },
  ThunkApiType
>(
  "session/refreshMetadata",
  async ({ offset, limit }, { dispatch, extra, getState }) => {
    const result = await extra.ideMessenger.request("history/list", {
      limit,
      offset,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    dispatch(setIsSessionMetadataLoading(false));
    dispatch(setAllSessionMetadata(result.content));
    // The whole list (core answers at most HISTORY_LIST_DEFAULT_LIMIT): drafts
    // of sessions it no longer holds can go
    if (
      limit === undefined &&
      offset === undefined &&
      result.content.length < HISTORY_LIST_DEFAULT_LIMIT
    ) {
      pruneDrafts({
        knownSessionIds: result.content.map((s) => s.sessionId),
        keepSessionIds: [getState().session.id],
      });
    }
    return result.content;
  },
);

export const deleteSession = createAsyncThunk<void, string, ThunkApiType>(
  "session/delete",
  async (id, { getState, dispatch, extra }) => {
    dispatch(deleteSessionMetadata(id)); // optimistic
    clearSessionDrafts(id);
    const state = getState();
    if (id === state.session.id) {
      await dispatch(loadLastSession());
    }
    const result = await extra.ideMessenger.request("history/delete", { id });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    // Again: leaving the deleted session saved what its input held
    clearSessionDrafts(id);
    void dispatch(refreshSessionMetadata({}));
  },
);

/**
 * Delete from the History page: the session goes to the trash, restorable
 * for 7 days (core/util/sessionTrash.ts). When another window or terminal
 * agent has it open nothing moves, and the answer says where, for the page
 * to ask; `force` moves it anyway.
 */
export const trashSession = createAsyncThunk<
  TrashSessionResult,
  { id: string; force?: boolean },
  ThunkApiType
>("session/trash", async ({ id, force }, { getState, dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/trash", {
    id,
    force,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  if (result.content.status === "trashed") {
    dispatch(deleteSessionMetadata(id));
    if (id === getState().session.id) {
      await dispatch(loadLastSession());
    }
    void dispatch(refreshSessionMetadata({}));
  }
  return result.content;
});

/** Undo, or Restore in the trash: the session is back in the list. */
export const restoreTrashedSession = createAsyncThunk<
  BaseSessionMetadata,
  string,
  ThunkApiType
>("session/restoreTrashed", async (id, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/restore", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  await dispatch(refreshSessionMetadata({}));
  return result.content;
});

export const updateSession = createAsyncThunk<void, Session, ThunkApiType>(
  "session/update",
  async (session, { extra, dispatch }) => {
    dispatch(
      updateSessionMetadata({
        sessionId: session.sessionId,
        title: session.title,
      }),
    ); // optimistic session metadata update
    // Only what changed since the last save crosses to the extension
    await saveSessionToCore(extra.ideMessenger, session);
    await dispatch(refreshSessionMetadata({}));
  },
);

/** Shown when a session the person picked or left open is gone */
export const MISSING_SESSION_NOTICE =
  "That session is no longer available: it may have been deleted or moved to the trash.";
/** Shown when the session left open could not be read at start-up */
export const UNREADABLE_SESSION_NOTICE =
  "The previous session could not be loaded. Last Session tries again.";

/**
 * What core answers for a session it does not hold (deleted, in the trash):
 * an empty session with the placeholder title (core/util/history.ts
 * loadWithStatus). Only a session with messages is ever saved.
 */
export function isMissingSession(session: Session): boolean {
  return (
    session.history.length === 0 &&
    (!session.title || session.title === NEW_SESSION_TITLE)
  );
}

type FetchedSession =
  | { status: "loaded"; session: Session }
  | { status: "failed"; error: unknown }
  /** The person moved on (a new session, another one) before it arrived */
  | { status: "dropped" };

/**
 * Fetches a saved session while `loadingSessionId` marks it as in flight, so
 * the chat shows the resuming view (ResumingSessionBody). Any `newSession`,
 * or a load of another session, takes the mark, and then the result is
 * dropped instead of replacing what the person is doing. A failure leaves
 * the mark for the caller to clear or to keep for its next try.
 */
async function fetchSessionToLoad(
  sessionId: string,
  fetch: () => Promise<Session>,
  dispatch: AppThunkDispatch,
  getState: () => RootState,
): Promise<FetchedSession> {
  dispatch(setLoadingSessionId(sessionId));
  const isStillWanted = () => getState().session.loadingSessionId === sessionId;
  try {
    const session = await fetch();
    return isStillWanted()
      ? { status: "loaded", session }
      : { status: "dropped" };
  } catch (error) {
    return isStillWanted()
      ? { status: "failed", error }
      : { status: "dropped" };
  }
}

/**
 * The session is gone: an empty chat and a short note. An empty chat on the
 * gone session's id gets a fresh id, so its first save cannot reuse it.
 */
function showMissingSession(
  sessionId: string,
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  notice: string,
) {
  const { session } = getState();
  if (session.id === sessionId || session.history.length === 0) {
    dispatch(newSession());
  } else {
    dispatch(setLoadingSessionId(undefined));
  }
  dispatch(setSessionLoadNotice(notice));
}

export const loadSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/load",
  async (
    { sessionId, saveCurrentSession: save },
    { extra, dispatch, getState },
  ) => {
    if (save) {
      // save the session in the background
      void dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
    }
    const fetched = await fetchSessionToLoad(
      sessionId,
      () => getSession(extra.ideMessenger, sessionId),
      dispatch,
      getState,
    );
    if (fetched.status === "dropped") {
      return;
    }
    if (fetched.status === "failed") {
      dispatch(setLoadingSessionId(undefined));
      throw fetched.error;
    }
    const session = fetched.session;
    // Picked from the list but gone now (trashed or deleted in another
    // window). An id the list does not hold (a tab's new session) opens
    // empty, as before.
    const wasListed = getState().session.allSessionMetadata.some(
      (m) => m.sessionId === sessionId,
    );
    if (wasListed && isMissingSession(session)) {
      showMissingSession(sessionId, dispatch, getState, MISSING_SESSION_NOTICE);
      return;
    }
    dispatch(newSession(session));

    // Restore selected chat model from session, if present
    if (session.chatModelTitle) {
      void dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
  },
);

export const selectChatModelForProfile = createAsyncThunk<
  void,
  string,
  ThunkApiType
>(
  "session/selectModelForCurrentProfile",
  async (modelTitle, { extra, dispatch, getState }) => {
    const state = getState();
    const modelMatch = state.config.config?.modelsByRole?.chat?.find(
      (m) => m.title === modelTitle,
    );
    const selectedProfile = selectSelectedProfile(state);
    if (selectedProfile && modelMatch) {
      await dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: modelTitle,
          selectedProfile,
        }),
      );
    }
  },
);

/** This window's workspace folders, from the IDE (the webview's copy as a fallback). */
async function workspaceDirsOf(ideMessenger: IIdeMessenger): Promise<string[]> {
  try {
    const dirs = await ideMessenger.ide.getWorkspaceDirs();
    if (Array.isArray(dirs)) return dirs.filter(Boolean);
  } catch {
    // the webview's copy below
  }
  return currentWorkspaceDirs();
}

/** The history list, or none when it cannot be read. */
async function listSessionMetadata(
  ideMessenger: IIdeMessenger,
): Promise<BaseSessionMetadata[]> {
  const result = await ideMessenger.request("history/list", {});
  return result.status === "success" ? result.content : [];
}

/**
 * Loads the first of `candidates` that can be read and is not gone, and
 * makes it the current session. "dropped" when the person moved on while it
 * loaded; "none" when none could be loaded (the loading mark stays on the
 * last one tried, so a retry can tell it is still wanted).
 */
async function loadFirstSession(
  candidates: string[],
  ideMessenger: IIdeMessenger,
  dispatch: AppThunkDispatch,
  getState: () => RootState,
): Promise<"loaded" | "dropped" | "none"> {
  for (const id of candidates) {
    const fetched = await fetchSessionToLoad(
      id,
      () => getSession(ideMessenger, id),
      dispatch,
      getState,
    );
    if (fetched.status === "dropped") return "dropped";
    if (fetched.status === "failed" || isMissingSession(fetched.session)) {
      continue;
    }
    const session = fetched.session;
    dispatch(newSession(session));
    if (session.chatModelTitle) {
      void dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
    return "loaded";
  }
  return "none";
}

/**
 * Reopens the last session of THIS workspace (util/sessionWorkspace.ts
 * lastSessionCandidates): the webview's storage is shared by every window,
 * so the single `lastSessionId` may belong to another workspace. A new
 * session when the workspace has none.
 */
export const loadLastSession = createAsyncThunk<void, void, ThunkApiType>(
  "session/loadLast",
  async (_, { extra, dispatch, getState }) => {
    const state = getState().session;
    // Nothing was ever left: a new session at once, without asking the IDE
    if (!state.lastSessionId && !state.lastSessionIdByWorkspace) {
      dispatch(newSession());
      return;
    }
    const workspaceDirs = await workspaceDirsOf(extra.ideMessenger);
    const sessions = await listSessionMetadata(extra.ideMessenger);
    const candidates = lastSessionCandidates({
      byWorkspace: state.lastSessionIdByWorkspace,
      legacyLastSessionId: state.lastSessionId,
      sessions,
      workspaceDirs,
    });
    if (candidates.length === 0) {
      dispatch(newSession());
      return;
    }
    const first = await loadFirstSession(
      candidates,
      extra.ideMessenger,
      dispatch,
      getState,
    );
    if (first !== "none") {
      return;
    }
    // The extension may still be starting: one more try after a second,
    // unless the person moved on in the meantime (the mark is not ours then)
    const lastTried = candidates[candidates.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (getState().session.loadingSessionId !== lastTried) {
      return;
    }
    const second = await loadFirstSession(
      candidates,
      extra.ideMessenger,
      dispatch,
      getState,
    );
    if (second === "none") {
      dispatch(newSession());
    }
  },
);

/**
 * Whether the person has started or picked something since the webview
 * opened on `preferredId`: a late start-up load must not replace it.
 */
function movedOnFrom(session: RootState["session"], preferredId: string) {
  return (
    session.id !== preferredId ||
    session.history.length > 0 ||
    (session.loadingSessionId !== undefined &&
      session.loadingSessionId !== preferredId)
  );
}

/**
 * When the webview starts: the session it had open (`preferredId`) when that
 * is a session of this workspace, otherwise the last one of this workspace,
 * otherwise nothing (the empty session stays). The stored id is shared by
 * every window, so without this check a window could open another
 * workspace's conversation.
 *
 * The resuming view is up already when start-up expected this window to
 * reopen the session (ParallelListeners, resumingSession.ts), marked by
 * `loadingSessionId`. Nothing is loaded once the person has moved on (typed,
 * started a new session, opened another).
 */
export const restoreWorkspaceSession = createAsyncThunk<
  void,
  { preferredId: string | undefined },
  ThunkApiType
>(
  "session/restoreForWorkspace",
  async ({ preferredId }, { extra, dispatch, getState }) => {
    if (!preferredId) return;
    if (movedOnFrom(getState().session, preferredId)) return;
    const resuming = getState().session.loadingSessionId === preferredId;
    let session: Session;
    try {
      session = await getSession(extra.ideMessenger, preferredId);
    } catch {
      if (resuming && !movedOnFrom(getState().session, preferredId)) {
        showMissingSession(
          preferredId,
          dispatch,
          getState,
          UNREADABLE_SESSION_NOTICE,
        );
      }
      // Not saved (an empty session) or gone: left as it is, as before
      return;
    }
    const workspaceDirs = await workspaceDirsOf(extra.ideMessenger);
    if (movedOnFrom(getState().session, preferredId)) return;
    if (resuming && isMissingSession(session)) {
      showMissingSession(
        preferredId,
        dispatch,
        getState,
        MISSING_SESSION_NOTICE,
      );
      return;
    }
    if (sessionBelongsToWorkspace(session.workspaceDirectory, workspaceDirs)) {
      dispatch(newSession(session));
      if (session.chatModelTitle) {
        void dispatch(selectChatModelForProfile(session.chatModelTitle));
      }
      return;
    }
    // Another workspace's session: not this one, so no resuming view for it
    if (resuming) dispatch(setLoadingSessionId(undefined));
    // The one left last in this workspace instead
    const remembered =
      getState().session.lastSessionIdByWorkspace?.[
        workspaceKey(workspaceDirs)
      ];
    if (remembered && remembered !== preferredId) {
      const result = await loadFirstSession(
        [remembered],
        extra.ideMessenger,
        dispatch,
        getState,
      );
      if (result !== "none") return;
      if (getState().session.loadingSessionId === remembered) {
        dispatch(setLoadingSessionId(undefined));
      }
    }
    // A conversation already under way is left alone
    if (movedOnFrom(getState().session, preferredId)) return;
    if (getState().session.id === preferredId) {
      // A new id, so this window's first save cannot write over the other
      // workspace's session
      dispatch(newSession());
    }
  },
);

function getChatTitleFromMessage(message: ChatMessage) {
  const text =
    renderChatMessage(message)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-1)[0] || "";

  // Truncate
  if (text.length > MAX_TITLE_LENGTH) {
    return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
  }
  return text;
}

/**
 * The session as saved. Its history is the store's own items (the save
 * drops their prompts, core/util/promptLogs): the delta save compares them
 * by reference with the last save's.
 */
function sessionToSave(
  session: RootState["session"],
  title: string,
  chatModelTitle: string | null,
): Session {
  const cache = session.promptCache;
  return {
    sessionId: session.id,
    title,
    workspaceDirectory: window.workspacePaths?.[0] || "",
    history: session.history,
    mode: session.mode,
    chatModelTitle,
    ...(session.usage && { usage: session.usage }),
    checkpoints: session.checkpoints,
    ...(session.taskPlan && { taskPlan: session.taskPlan }),
    ...(session.planFile && { planFile: session.planFile }),
    ...(session.environment && { environment: session.environment }),
    ...(session.loop && { loop: session.loop }),
    ...(session.loopRequested && { loopRequested: true }),
    ...(session.forkedFrom && { forkedFrom: session.forkedFrom }),
    // Saving an empty list removes queued messages from the file
    queuedMessages: session.queuedMessages ?? [],
    // Enough for a resumed session to know its cache has expired and what
    // re-reading the conversation will cost.
    ...(cache?.lastRequestAt !== undefined && {
      promptCache: {
        lastRequestAt: cache.lastRequestAt,
        lastInputTokens: cache.lastInputTokens,
        lastTtl: cache.lastTtl,
        requests: cache.requests,
        escalated: cache.escalated,
        escalatedBy: cache.escalatedBy,
      },
    }),
  };
}

/**
 * Saves the open session in the middle of a turn: when the person's message
 * is added, at each tool result, and every few seconds while an answer
 * streams. The newest item is saved marked as cut off ("reloaded"), so a
 * window that dies before the turn ends reopens with Resume on it; the save
 * at the turn's end writes it again unmarked. Only the change is sent, and
 * nothing at all when the extension keeps sessions as one JSON file (each
 * save would rewrite the whole file). No title is generated. A plain
 * function, not a thunk: it changes nothing in the store, so it dispatches
 * nothing.
 */
export async function checkpointSession(
  getState: () => RootState,
  ideMessenger: IIdeMessenger,
): Promise<void> {
  const state = getState();
  const session = state.session;
  if (session.history.length === 0 || session.isInEdit) return;
  const known = session.allSessionMetadata.find(
    (m) => m.sessionId === session.id,
  );
  const title =
    session.title !== NEW_SESSION_TITLE
      ? session.title
      : (known?.title ?? NEW_SESSION_TITLE);
  try {
    await saveSessionToCore(
      ideMessenger,
      sessionToSave(
        session,
        title || NEW_SESSION_TITLE,
        selectSelectedChatModel(state)?.title ?? null,
      ),
      { checkpoint: "reloaded" },
    );
  } catch (e) {
    // The turn's own save at its end still runs
    console.warn("Session checkpoint not saved", e);
  }
}

export const saveCurrentSession = createAsyncThunk<
  void,
  { openNewSession: boolean; generateTitle: boolean },
  ThunkApiType
>(
  "session/saveCurrent",
  async ({ openNewSession, generateTitle }, { dispatch, extra, getState }) => {
    const session = getState().session; // assign to a variable so that even when current session changes, we have the reference to the old session
    if (session.history.length === 0) {
      return;
    }

    if (openNewSession) {
      dispatch(newSession());
    }

    const selectedChatModel = selectSelectedChatModel(getState());

    // New session has already been dispatched
    // Now save previous session and update chat title if relevant
    let title = session.title;
    if (title === NEW_SESSION_TITLE) {
      if (
        !getState().config.config?.disableSessionTitles &&
        selectedChatModel
      ) {
        let assistantResponse = session.history
          ?.filter((h) => h.message.role === "assistant")[0]
          ?.message?.content?.toString();

        if (assistantResponse && generateTitle) {
          try {
            const result = await extra.ideMessenger.request(
              "chatDescriber/describe",
              {
                text: assistantResponse,
              },
            );
            if (result.status === "success" && result.content) {
              title = result.content;
            }
          } catch (e) {
            console.error("Error generating chat title", e);
          }
        }
      }
      // Fallbacks if above doesn't work out or session titles disabled
      if (title === NEW_SESSION_TITLE) {
        title = getChatTitleFromMessage(session.history[0].message);
      }
    }
    // More fallbacks in case of no title
    if (!title.length) {
      const metadata = session.allSessionMetadata.find(
        (m) => m.sessionId === session.id,
      );
      if (metadata?.title) {
        title = metadata.title;
      }
    }
    if (!title.length) {
      title = NEW_SESSION_TITLE;
    }

    const updatedSession = sessionToSave(
      session,
      title,
      selectedChatModel?.title ?? null,
    );

    const result = await dispatch(updateSession(updatedSession));
    unwrapResult(result);
  },
);
