/**
 * Where the rendered environment goes in a conversation, shared by the CLI
 * and the IDE (plans/research/env-disclosure-master-plan.md, sections 3.4 and
 * 3.7, rows ENV12, ENV14 and ENV32):
 *
 * - the first-message block goes on the first user message, built once from
 *   the frozen snapshot, so it never changes during the session;
 * - a date notice is recorded the first time a request is built on a later
 *   local day, against the user message that was newest then, and from then
 *   on it rides on that same message in every request. Earlier bytes never
 *   change: a notice only ever lands on the newest message, and stays there.
 *
 * Pure: the caller keeps the notices with the session.
 */
import type { EnvironmentSnapshot } from "./environmentPrompt";
import { renderEnvironmentUpdate } from "./environmentUpdate";

/** One date notice, kept with the session. */
export interface EnvironmentNotice {
  /** Which user message carries it, counted from 0 over the user messages. */
  userTurn: number;
  /** The local day it announced. */
  localDay: string;
  text: string;
}

/**
 * The notices with one added when `today` is later than the day the last
 * notice (or the snapshot) announced; the same array when nothing changed.
 * `userTurns` is how many user messages the request has.
 */
export function withDateNotice(
  snapshot: EnvironmentSnapshot,
  notices: readonly EnvironmentNotice[],
  userTurns: number,
  today: string,
): readonly EnvironmentNotice[] {
  if (userTurns < 1) return notices;
  const last = notices.length
    ? notices[notices.length - 1].localDay
    : snapshot.localDay;
  if (today <= last) return notices;
  const userTurn = userTurns - 1;
  // A message already carrying a notice keeps its bytes; the next one gets it
  if (notices.some((n) => n.userTurn >= userTurn)) return notices;
  const text = renderEnvironmentUpdate(snapshot, { localDay: today });
  if (!text) return notices;
  return [...notices, { userTurn, localDay: today, text }];
}

/**
 * Adds `firstBlock` to the first user message and each notice to its user
 * message, through `edit`, which returns a new message (the input is not
 * changed). `edit` decides where the text goes (before or after the content).
 */
export function placeEnvironment<M>(
  messages: readonly M[],
  isUser: (m: M) => boolean,
  edit: (m: M, add: { first?: string; notices: string[] }) => M,
  firstBlock: string | undefined,
  notices: readonly EnvironmentNotice[] = [],
): M[] {
  let turn = -1;
  return messages.map((m) => {
    if (!isUser(m)) return m;
    turn++;
    const first = turn === 0 && firstBlock ? firstBlock : undefined;
    const here = notices.filter((n) => n.userTurn === turn).map((n) => n.text);
    return first || here.length ? edit(m, { first, notices: here }) : m;
  });
}

/** `text` before a message's content: a string, or a first text part. */
export function withLeadingText<C>(content: C, text: string): C {
  if (!text) return content;
  if (typeof content === "string") {
    return (content ? `${text}\n\n${content}` : text) as C;
  }
  if (Array.isArray(content)) return [{ type: "text", text }, ...content] as C;
  return content;
}

/** `text` after a message's content: a string, or a last text part. */
export function withTrailingText<C>(content: C, text: string): C {
  if (!text) return content;
  if (typeof content === "string") {
    return (content ? `${content}\n\n${text}` : text) as C;
  }
  if (Array.isArray(content)) return [...content, { type: "text", text }] as C;
  return content;
}
