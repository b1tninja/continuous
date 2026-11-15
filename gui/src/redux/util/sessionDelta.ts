import type {
  ChatHistoryItem,
  Session,
  SessionDelta,
  SessionSaveResult,
  TurnInterruption,
} from "core";
import { withoutPrompts } from "core/util/promptLogs";
import type { IIdeMessenger } from "../../context/IdeMessenger";

/**
 * Saving a session sends only what changed since the last save (STOR6).
 *
 * The store's history items are immutable, so an item that is the same
 * object as at the last save has not changed: the delta is the items whose
 * reference differs, plus the session fields whose value differs. The core
 * answers each save with a revision; the next delta is sent against it. When
 * the core cannot apply a delta (it restarted, the session log is off,
 * another save came in between) it asks for the whole session, which is
 * then sent with `history/save` as before.
 *
 * One save runs at a time, in the order asked, so a checkpoint during a
 * stream and the save at the turn's end never race for the same revision.
 */

const UNCHANGED_FIELD_KEYS = ["history", "sessionId"];

interface LastSaved {
  sessionId: string;
  rev: string;
  /** The store's item objects at the last save; undefined forces a resend. */
  items: (ChatHistoryItem | undefined)[];
  /** The session fields at the last save, by reference. */
  fields: Record<string, unknown>;
  fieldJson: Record<string, string>;
}

let lastSaved: LastSaved | undefined;
/** Whether the core keeps the session log: learned from its first answer. */
let coreHasLog: boolean | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** For tests: forget what was saved. */
export function resetSessionDeltaState(): void {
  lastSaved = undefined;
  coreHasLog = undefined;
  queue = Promise.resolve();
}

export interface SaveOptions {
  /**
   * A save during a turn (STOR6 checkpoint): the newest item is written with
   * this marker, so a session reopened after a crash offers Resume from
   * there; the save at the turn's end writes it again without. Skipped when
   * the core has no session log, where each save rewrites the whole file.
   */
  checkpoint?: TurnInterruption;
}

/** What a save sent, for tests and the write-cost measurement. */
export interface SaveReport {
  kind: "delta" | "full" | "skipped";
  /** Characters posted to the extension. */
  postedChars: number;
  items: number;
}

function fieldsOf(session: Session): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(session)) {
    if (!UNCHANGED_FIELD_KEYS.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

function stripPrompts(item: ChatHistoryItem): ChatHistoryItem {
  return withoutPrompts([item])[0];
}

function marked(
  item: ChatHistoryItem,
  checkpoint: TurnInterruption | undefined,
): ChatHistoryItem {
  if (!checkpoint || item.interrupted) return item;
  return { ...item, interrupted: checkpoint };
}

/** The delta from the last save to `session`, or undefined when there is no base. */
export function buildSessionDelta(
  session: Session,
  options: SaveOptions = {},
): SessionDelta | undefined {
  const last = lastSaved;
  if (!last || last.sessionId !== session.sessionId) return undefined;
  const history = session.history;
  const lastIndex = history.length - 1;
  const items: SessionDelta["items"] = [];
  history.forEach((item, index) => {
    const isMarked = !!options.checkpoint && index === lastIndex;
    if (!isMarked && last.items[index] === item) return;
    items.push({
      index,
      item: isMarked
        ? marked(stripPrompts(item), options.checkpoint)
        : stripPrompts(item),
    });
  });
  const fields = fieldsOf(session);
  const meta: Record<string, unknown> = {
    // Always: the core keeps the session list from them
    title: session.title,
    workspaceDirectory: session.workspaceDirectory,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (last.fields[k] === v) continue;
    if (last.fieldJson[k] === JSON.stringify(v)) continue;
    meta[k] = v;
  }
  const unset = Object.keys(last.fields).filter((k) => !(k in fields));
  return {
    sessionId: session.sessionId,
    baseRev: last.rev,
    length: history.length,
    items,
    meta,
    ...(unset.length && { unset }),
  };
}

function remember(
  session: Session,
  rev: string | null | undefined,
  options: SaveOptions,
): void {
  if (!rev) {
    lastSaved = undefined;
    return;
  }
  const fields = fieldsOf(session);
  const fieldJson: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    // Large fields are compared by reference only
    if (k !== "checkpoints") fieldJson[k] = JSON.stringify(v);
  }
  const items: (ChatHistoryItem | undefined)[] = [...session.history];
  // The marked copy is not what the store holds: send the item again next time
  if (options.checkpoint && items.length) items[items.length - 1] = undefined;
  lastSaved = { sessionId: session.sessionId, rev, items, fields, fieldJson };
}

async function postFull(
  messenger: IIdeMessenger,
  session: Session,
  options: SaveOptions,
): Promise<SaveReport> {
  const history = withoutPrompts(session.history);
  const payload: Session = {
    ...session,
    history:
      options.checkpoint && history.length
        ? [
            ...history.slice(0, -1),
            marked(history[history.length - 1], options.checkpoint),
          ]
        : history,
  };
  const result = await messenger.request("history/save", payload);
  if (result.status === "error") throw new Error(result.error);
  const rev = (result.content as SessionSaveResult | undefined)?.rev;
  coreHasLog = !!rev;
  remember(session, rev, options);
  return {
    kind: "full",
    postedChars: JSON.stringify(payload).length,
    items: payload.history.length,
  };
}

async function save(
  messenger: IIdeMessenger,
  session: Session,
  options: SaveOptions,
): Promise<SaveReport> {
  if (options.checkpoint && coreHasLog === false) {
    return { kind: "skipped", postedChars: 0, items: 0 };
  }
  const delta = buildSessionDelta(session, options);
  if (delta) {
    const result = await messenger.request("history/saveDelta", delta);
    if (result.status === "success" && result.content?.rev) {
      remember(session, result.content.rev, options);
      return {
        kind: "delta",
        postedChars: JSON.stringify(delta).length,
        items: delta.items.length,
      };
    }
    // needFull, or an extension without deltas: send it whole below
  }
  return postFull(messenger, session, options);
}

/**
 * Saves `session` (its history as the store holds it: prompts are dropped
 * here). Resolves after the extension has taken it; the write to disk runs
 * after that, off the extension's request path.
 */
export function saveSessionToCore(
  messenger: IIdeMessenger,
  session: Session,
  options: SaveOptions = {},
): Promise<SaveReport> {
  const run = queue.then(
    () => save(messenger, session, options),
    () => save(messenger, session, options),
  );
  queue = run.catch(() => undefined);
  return run;
}
