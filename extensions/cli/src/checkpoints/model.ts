/** Types and small helpers shared by the checkpoint store and its users. */
import { createHash } from "crypto";

import type { MessageContent } from "core/index.js";

export type SkipReason =
  /** Larger than `maxFileBytes` */
  | "too_large"
  /** Could not be read */
  | "unreadable"
  /** A secret file (.env, keys): its contents are never copied */
  | "secret"
  /** The session's snapshot budget was spent by this turn alone */
  | "session_cap"
  /** A directory or something else that is not a regular file */
  | "not_a_file";

export interface FileSnapshot {
  /** Absolute path, symbolic links resolved */
  uri: string;
  /** False when the file did not exist: restoring deletes it */
  existed: boolean;
  /** sha256 of the contents in `blobs/`; absent when skipped or not existed */
  blob?: string;
  bytes?: number;
  skipped?: SkipReason;
}

export interface CheckpointTurn {
  turnId: string;
  createdAt: number;
  /** First line of the prompt that started the turn, shortened */
  label: string;
  /** Hash of the prompt text, to find the turn's message in the history */
  promptHash: string;
  /** Index of that message in the history when the turn was recorded */
  userIndex: number;
  /** The first snapshot of each file the agent wrote during the turn */
  files: FileSnapshot[];
}

export interface RedoRecord {
  createdAt: number;
  targetTurnId: string;
  /** The files as they were just before the rewind */
  files: FileSnapshot[];
  /** sha256 each file had right after the rewind; null when it was removed */
  expected: Record<string, string | null>;
  /** Turns the rewind took off the list, put back by redo */
  removedTurns: CheckpointTurn[];
  /** `lastWritten` entries the rewind replaced */
  lastWrittenBefore: Record<string, string>;
  /** History items the rewind cut, put back by redo */
  conversation?: { atIndex: number; items: unknown[] };
}

export interface CheckpointIndex {
  version: 1;
  sessionId: string;
  turns: CheckpointTurn[];
  /** sha256 of what the agent last wrote to each file */
  lastWritten: Record<string, string>;
  redo?: RedoRecord;
}

export interface CheckpointCaps {
  /** Files at or above this size are recorded as `too_large` */
  maxFileBytes: number;
  /** Total stored bytes per session; the oldest turns go first */
  maxSessionBytes: number;
  /** Turns kept per session; the oldest go first */
  maxTurns: number;
}

export const DEFAULT_CHECKPOINT_CAPS: CheckpointCaps = {
  maxFileBytes: 2 * 1024 * 1024,
  maxSessionBytes: 64 * 1024 * 1024,
  maxTurns: 100,
};

/** What the agent is working on when it writes: the prompt's turn. */
export interface TurnRef {
  label: string;
  promptHash: string;
  userIndex: number;
}

export type RewindAction = "restore" | "recreate" | "delete" | "unrestorable";

export interface RewindItem {
  uri: string;
  action: RewindAction;
  snapshot: FileSnapshot;
  /**
   * The file is not what the agent last wrote: someone or something else
   * changed it since. Restoring would overwrite that change, so it needs
   * confirmation.
   */
  changedOutside: boolean;
  /** Lines the restore adds and removes, compared with the file now */
  added: number;
  removed: number;
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  /** Changed outside the agent and not confirmed: left alone */
  refused: string[];
  /** No stored contents (skipped): left alone */
  unrestorable: { uri: string; reason: SkipReason | "unknown" }[];
  failed: { uri: string; error: string }[];
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A session id becomes a folder name; anything that could escape is refused. */
export function isSafeSessionId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

/** A label for a prompt: its first non-empty line, shortened. */
export function promptLabel(text: string, max = 72): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function promptHash(text: string): string {
  return sha256(text).slice(0, 16);
}

/** Plain text of a message, for labels and turn matching. */
export function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}
