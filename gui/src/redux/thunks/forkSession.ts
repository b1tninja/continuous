import { createAsyncThunk } from "@reduxjs/toolkit";
import type { Session } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { forkSession } from "core/util/forkSession";
import { v4 as uuidv4 } from "uuid";
import { expectedRoute, promptCacheKey } from "../../util/cacheSafeguards";
import {
  forkCost,
  forkPromptCacheRecord,
  ledgerUpTo,
} from "../../util/forkCost";
import {
  INITIAL_PROMPT_CACHE_STATE,
  type PromptCacheKey,
} from "../../util/promptCache";
import { selectCacheSetting } from "../selectors/selectCacheSetting";
import { selectSelectedChatModel } from "../slices/configSlice";
import { newSession, setPromptCacheState } from "../slices/sessionSlice";
import type { RootState, ThunkApiType } from "../store";
import { buildChatRequest } from "../util/buildChatRequest";
import {
  getSession,
  refreshSessionMetadata,
  saveCurrentSession,
  selectChatModelForProfile,
} from "./session";

/** The open session as it would be saved, for forkSession. */
function currentSessionAsSaved(state: RootState): Session {
  const s = state.session;
  const cache = s.promptCache;
  return {
    sessionId: s.id,
    title: s.title,
    workspaceDirectory: window.workspacePaths?.[0] || "",
    history: s.history,
    mode: s.mode,
    chatModelTitle: selectSelectedChatModel(state)?.title ?? null,
    ...(s.taskPlan && { taskPlan: s.taskPlan }),
    ...(s.planFile && { planFile: s.planFile }),
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
 * The cache key of the fork's conversation as its next request will send it,
 * minus the new message: the next request's miss check compares against it,
 * so a fork that only grows is not reported as a miss. Undefined when the
 * request cannot be built (no model).
 */
function forkCacheKey(
  state: RootState,
  lastKey: PromptCacheKey | undefined,
): PromptCacheKey | undefined {
  try {
    const request = buildChatRequest(state);
    const system = request.messages.find((m) => m.role === "system");
    return promptCacheKey(
      request.model,
      request.activeTools,
      system ? renderChatMessage(system) : undefined,
      request.messages.filter((m) => m.role !== "system"),
      {
        route: expectedRoute(request.model, lastKey),
        options: request.completionOptions,
      },
    );
  } catch {
    return undefined;
  }
}

/**
 * Fork a session into a new one and open it (in a new tab when session tabs
 * are on; the tab bar follows the session). Without `sessionId`, or with the
 * open session's, it forks the open session, up to and including history item
 * `upTo` ("Fork from here") or whole ("Fork session"). With another session's
 * ID it forks that session, whole, from its saved file.
 *
 * The fork keeps the history unchanged, the mode, the chat model, the task
 * plan and the prompt cache record (core/util/forkSession.ts has the copy
 * table), so its first request starts with the parent's bytes and can read
 * the parent's cache. The model is not changed in the same step (D5): switch
 * it in the fork, where the model switch says what it costs. Permission
 * levels belong to the window, so a fork opened in it keeps them, an IDGAF
 * included. Resolves to the fork's session ID, or undefined when there was
 * nothing to fork.
 */
export const forkSessionThunk = createAsyncThunk<
  string | undefined,
  { upTo?: number; sessionId?: string },
  ThunkApiType
>(
  "session/fork",
  async ({ upTo, sessionId }, { dispatch, getState, extra }) => {
    const before = getState();
    if (before.session.isStreaming) return undefined;
    const forkId = uuidv4();
    const ofOpenSession = !sessionId || sessionId === before.session.id;

    if (!ofOpenSession) {
      if (before.session.history.length > 0) {
        await dispatch(
          saveCurrentSession({ openNewSession: false, generateTitle: false }),
        );
      }
      const parent = await getSession(extra.ideMessenger, sessionId);
      if (!parent.history.length) return undefined;
      const fork = forkSession(parent, { sessionId: forkId });
      await extra.ideMessenger.request("history/save", fork);
      dispatch(newSession(fork));
      if (fork.chatModelTitle) {
        void dispatch(selectChatModelForProfile(fork.chatModelTitle));
      }
      void dispatch(refreshSessionMetadata({}));
      return forkId;
    }

    const history = before.session.history;
    if (history.length === 0) return undefined;
    const lastIndex = history.length - 1;
    const index = upTo === undefined ? lastIndex : Math.min(upTo, lastIndex);
    const latest = index === lastIndex;
    const cacheState = before.session.promptCache ?? INITIAL_PROMPT_CACHE_STATE;
    const model = selectSelectedChatModel(before);
    const cost = model
      ? forkCost({
          model,
          setting: selectCacheSetting(before),
          state: cacheState,
          history,
          forkIndex: index,
          mode: before.session.mode,
          now: Date.now(),
        })
      : undefined;

    // The original, saved as it is now, so it can be reopened unchanged
    await dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );

    const parent = currentSessionAsSaved(before);
    const fork = forkSession(parent, {
      sessionId: forkId,
      ...(!latest && { upTo: index }),
      promptCache: forkPromptCacheRecord(cacheState, cost, latest),
    });
    // An untitled conversation keeps the untitled marker, so it is named the
    // usual way when it is saved
    if (parent.title === NEW_SESSION_TITLE) fork.title = NEW_SESSION_TITLE;

    await extra.ideMessenger.request("history/save", fork);
    dispatch(newSession(fork));

    // The in-memory part of the record: the parent's requests up to the fork
    // point, for the session's statistics, and the key of what the fork sends,
    // for the next request's miss check
    const opened = getState();
    const key = forkCacheKey(opened, cacheState.lastKey);
    dispatch(
      setPromptCacheState({
        ...(opened.session.promptCache ?? INITIAL_PROMPT_CACHE_STATE),
        ledger: ledgerUpTo(cacheState.ledger, index),
        ...(key
          ? { lastKey: key }
          : latest && cacheState.lastKey && { lastKey: cacheState.lastKey }),
      }),
    );
    void dispatch(refreshSessionMetadata({}));
    return forkId;
  },
);
