import { withDateNotice } from "core/util/environmentMessages";
import { localDayOf } from "core/util/environmentUpdate";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { setSessionEnvironment } from "../slices/sessionSlice";
import type { AppDispatch, RootState } from "../store";
import { buildChatRequest } from "../util/buildChatRequest";

/** The session core was last asked about from this webview. */
let askedFor: string | undefined;

/** For tests: forget which session was asked about. */
export function resetSessionEnvironmentFreeze(): void {
  askedFor = undefined;
}

/**
 * Whether the session still has to ask core: once per session, answered or
 * not, so a request that needs nothing does not wait at all.
 */
export function needsSessionEnvironment(state: RootState): boolean {
  return askedFor !== state.session.id;
}

/**
 * Makes sure the session has its environment before a request is built
 * (plans/research/env-disclosure-master-plan.md 3.3, ENV13 and ENV14). A new
 * session asks core to gather it once; a session that has one (a resumed
 * session) sends it back once, so core freezes the terminal executor at the
 * shell the session was told about. Nothing is sent again for the same
 * session. When core cannot answer, the session goes without it. A plain
 * function, not a thunk, so it adds no actions of its own to a turn.
 */
export async function ensureSessionEnvironment(
  getState: () => RootState,
  dispatch: AppDispatch,
  ideMessenger: IIdeMessenger,
): Promise<void> {
  const session = getState().session;
  if (askedFor === session.id) return;
  askedFor = session.id;
  try {
    const result = await ideMessenger.request("environment/session", {
      saved: session.environment,
    });
    if (result.status !== "success" || !result.content) return;
    // The person may have switched sessions while core was gathering
    if (getState().session.id !== session.id) return;
    if (!session.environment?.strings) {
      dispatch(setSessionEnvironment(result.content));
    }
  } catch {
    // No environment: the request is built without it
  }
}

/**
 * Records a date notice when the person's local day has moved on since the
 * session started (or since its last notice): on the newest user message of
 * the request about to be built, saved with the session, so it stays on that
 * message in every later request (ENV32). Returns whether one was added.
 */
export function recordDateNotice(
  getState: () => RootState,
  dispatch: AppDispatch,
  today: string = localDayOf(),
): boolean {
  const env = getState().session.environment;
  if (!env?.snapshot?.localDay) return false;
  const before = env.notices ?? [];
  const last = before.length
    ? before[before.length - 1].localDay
    : env.snapshot.localDay;
  if (today <= last) return false;
  let userTurns: number;
  try {
    userTurns = buildChatRequest(getState()).userTurns;
  } catch {
    return false;
  }
  const next = withDateNotice(env.snapshot, before, userTurns, today);
  if (next === before) return false;
  dispatch(setSessionEnvironment({ ...env, notices: [...next] }));
  return true;
}
