/**
 * The rewind operations shared by the `/rewind` picker and the headless
 * `continuous rewind` command: which turns can be picked, what picking one
 * would change, and doing it (files, conversation or both) with one redo.
 */
import path from "path";

import type { ChatHistoryItem } from "core/index.js";

import type {
  CheckpointTurn,
  RewindItem,
  RewindResult,
  SkipReason,
} from "./model.js";
import { messageText, promptHash, promptLabel } from "./model.js";
import type { CheckpointStore } from "./store.js";

export type RewindMode = "files" | "conversation" | "both";

export interface RewindEntry {
  /** 1-based, the number `continuous rewind --to` takes */
  number: number;
  label: string;
  /** Index of the prompt in the history; undefined when compacted away */
  historyIndex?: number;
  /** The checkpoint recorded for this prompt, if the agent wrote files */
  turn?: CheckpointTurn;
  /** First checkpoint at or after this prompt: what a file restore targets */
  filesTurnId?: string;
  /** Files the agent's file tools wrote in this turn */
  files: string[];
}

/**
 * One entry per prompt in the history, in order, joined to the checkpoint
 * turns by prompt text. Checkpoint turns whose prompt is no longer in the
 * history (compacted, or cut by a conversation rewind) are listed where they
 * fall, for file restore only.
 */
export function buildRewindEntries(
  history: ChatHistoryItem[],
  turns: CheckpointTurn[],
): RewindEntry[] {
  const raw: Omit<RewindEntry, "number" | "filesTurnId">[] = [];
  const orphan = (turn: CheckpointTurn) => ({
    label: turn.label,
    turn,
    files: turn.files.map((f) => f.uri),
  });
  let next = 0;
  // Where unmatched turns go: right after the last matched prompt, so a
  // compacted turn comes before the summary that replaced it
  let insertAt = 0;
  history.forEach((item, historyIndex) => {
    if (item.message.role !== "user") return;
    const text = messageText(item.message.content);
    const hash = promptHash(text);
    const found = turns.findIndex((t, i) => i >= next && t.promptHash === hash);
    if (found !== -1) {
      raw.splice(insertAt, 0, ...turns.slice(next, found).map(orphan));
      next = found + 1;
    }
    const turn = found === -1 ? undefined : turns[found];
    raw.push({
      label: promptLabel(text) || "(empty prompt)",
      historyIndex,
      turn,
      files: turn?.files.map((f) => f.uri) ?? [],
    });
    if (turn) insertAt = raw.length;
  });
  raw.push(...turns.slice(next).map(orphan));

  const entries: RewindEntry[] = raw.map((e, i) => ({ ...e, number: i + 1 }));
  let following: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].turn) following = entries[i].turn!.turnId;
    entries[i].filesTurnId = following;
  }
  return entries;
}

/** What restoring files to before this entry would change. */
export function previewFiles(
  store: CheckpointStore,
  entry: RewindEntry,
): RewindItem[] {
  return entry.filesTurnId ? store.planRewind(entry.filesTurnId) : [];
}

export function availableModes(
  entry: RewindEntry,
  items: RewindItem[],
): RewindMode[] {
  const modes: RewindMode[] = [];
  const files = items.length > 0;
  const conversation = entry.historyIndex !== undefined;
  if (files) modes.push("files");
  if (conversation) modes.push("conversation");
  if (files && conversation) modes.push("both");
  return modes;
}

export const MODE_LABELS: Record<RewindMode, string> = {
  files: "Restore files (keep the conversation)",
  conversation: "Rewind the conversation (keep the files)",
  both: "Restore files and rewind the conversation",
};

export const NOT_COVERED_NOTE =
  "Only files written by Edit, MultiEdit and Write are restored. Files changed by shell commands or MCP tools are not covered.";

function shown(uri: string, cwd: string): string {
  const rel = path.relative(cwd, uri);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : uri;
}

const SKIP_TEXT: Record<SkipReason | "unknown", string> = {
  too_large: "too large to keep",
  unreadable: "could not be read",
  secret: "secret file, contents not kept",
  session_cap: "over the session's snapshot budget",
  not_a_file: "not a regular file",
  unknown: "no snapshot",
};

/** One line per file: what happens, the path, the line counts, a warning. */
export function describeItems(items: RewindItem[], cwd: string): string[] {
  return items.map((item) => {
    const where = shown(item.uri, cwd);
    if (item.action === "unrestorable") {
      return `cannot restore  ${where} (${SKIP_TEXT[item.snapshot.skipped ?? "unknown"]})`;
    }
    const counts = `+${item.added} -${item.removed}`;
    const outside = item.changedOutside
      ? "  changed outside the agent since its last write"
      : "";
    return `${item.action.padEnd(8)} ${where}  ${counts}${outside}`;
  });
}

export function describeResult(result: RewindResult, cwd: string): string[] {
  const lines: string[] = [];
  const n = result.restored.length + result.deleted.length;
  if (n > 0) {
    lines.push(
      `Restored ${result.restored.length} file(s), removed ${result.deleted.length} the agent created.`,
    );
  }
  for (const uri of result.refused) {
    lines.push(`Left alone (changed outside the agent): ${shown(uri, cwd)}`);
  }
  for (const { uri, reason } of result.unrestorable) {
    lines.push(`Cannot restore ${shown(uri, cwd)}: ${SKIP_TEXT[reason]}`);
  }
  for (const { uri, error } of result.failed) {
    lines.push(`Failed ${shown(uri, cwd)}: ${error}`);
  }
  return lines;
}

export interface RewindOutcome {
  /** The new history when the conversation changed */
  history?: ChatHistoryItem[];
  result: RewindResult;
  lines: string[];
}

/** Rewind to before `entry`. Files outside-changed need `confirmChanged`. */
export function applyRewind(
  store: CheckpointStore,
  history: ChatHistoryItem[],
  entry: RewindEntry,
  mode: RewindMode,
  options: { confirmChanged?: boolean; cwd?: string } = {},
): RewindOutcome {
  const cwd = options.cwd ?? process.cwd();
  const files = mode !== "conversation";
  const conversation = mode !== "files" && entry.historyIndex !== undefined;
  if (files && !entry.filesTurnId && !conversation) {
    return {
      result: emptyResult(),
      lines: ["Nothing to restore: the agent wrote no files from here on."],
    };
  }
  const cut = conversation ? entry.historyIndex! : undefined;
  const result = store.rewind(entry.filesTurnId ?? "", {
    confirmChanged: options.confirmChanged,
    files: files && !!entry.filesTurnId,
    conversation:
      cut === undefined
        ? undefined
        : { atIndex: cut, items: history.slice(cut) },
  });
  const lines = describeResult(result, cwd);
  if (cut !== undefined) {
    lines.push(
      `Conversation rewound to before "${entry.label}" (${history.length - cut} message(s) removed).`,
    );
  }
  if (lines.length === 0) lines.push("Files already match; nothing changed.");
  lines.push("Redo is available until the agent writes again.");
  return {
    history: cut === undefined ? undefined : history.slice(0, cut),
    result,
    lines,
  };
}

/**
 * Undo the last rewind. The conversation comes back only when nothing was
 * added to it since; otherwise it is left as it is and that is said.
 */
export function applyRedo(
  store: CheckpointStore,
  history: ChatHistoryItem[],
  options: { confirmChanged?: boolean; cwd?: string } = {},
): RewindOutcome | undefined {
  const cwd = options.cwd ?? process.cwd();
  const redone = store.redo({ confirmChanged: options.confirmChanged });
  if (!redone) return undefined;
  const lines = describeResult(redone, cwd);
  let next: ChatHistoryItem[] | undefined;
  const conv = redone.conversation;
  if (conv) {
    if (history.length === conv.atIndex) {
      next = [...history, ...(conv.items as ChatHistoryItem[])];
      lines.push(`Conversation restored (${conv.items.length} message(s)).`);
    } else {
      lines.push(
        "The conversation was not restored: messages were added after the rewind.",
      );
    }
  }
  if (lines.length === 0) lines.push("Files already match; nothing changed.");
  return { history: next, result: redone, lines };
}

function emptyResult(): RewindResult {
  return {
    restored: [],
    deleted: [],
    refused: [],
    unrestorable: [],
    failed: [],
  };
}
