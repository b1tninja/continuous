/**
 * Checkpoints for the terminal agent: a per-session store of the files the
 * agent's own file tools (Edit, MultiEdit, Write) are about to change.
 *
 * Layout, under the global folder (never the workspace, never git):
 *
 *   checkpoints/<sessionId>/index.json      turns, last writes, redo record
 *   checkpoints/<sessionId>/blobs/<sha256>  file contents, stored once each
 *
 * Only named targets are captured, one snapshot per file per turn (the state
 * before the turn), so the cost is the size of the files the agent writes and
 * never the size of the repository. Zed removed its checkpoints in 1.27.0
 * because snapshotting every repository before every message hung large
 * workspaces (zed-industries/zed#65989); this store has no step whose cost
 * grows with the tree.
 *
 * The planning of which snapshot to restore is shared with the IDE's
 * checkpoints (core/util/checkpoints.ts `planRestore`); what differs is
 * storage (blobs on disk instead of contents inline in the session) and the
 * check that a file has not been changed outside the agent since its last
 * write, which the IDE does not have.
 *
 * Not covered: files changed by shell commands, MCP tools, or anything other
 * than the three file tools.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "core/util/atomicWrite.js";
import {
  checkpointHoldsSecret,
  planRestore,
  pruneCheckpointsFrom,
} from "core/util/checkpoints.js";
import { diffLines } from "diff";

import {
  DEFAULT_CHECKPOINT_CAPS,
  isSafeSessionId,
  sha256,
  type CheckpointCaps,
  type CheckpointIndex,
  type CheckpointTurn,
  type FileSnapshot,
  type RedoRecord,
  type RewindAction,
  type RewindItem,
  type RewindResult,
  type TurnRef,
} from "./model.js";

function emptyIndex(sessionId: string): CheckpointIndex {
  return { version: 1, sessionId, turns: [], lastWritten: {} };
}

interface CurrentState {
  exists: boolean;
  data?: Buffer;
  hash?: string;
}

function readCurrent(file: string): CurrentState {
  try {
    const data = fs.readFileSync(file);
    return { exists: true, data, hash: sha256(data) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false };
    }
    throw error;
  }
}

function lineChanges(
  from: string,
  to: string,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(from, to)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** Folder of one session's checkpoints under the checkpoints root. */
export function sessionCheckpointDir(root: string, sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`Not a usable session id: ${JSON.stringify(sessionId)}`);
  }
  return path.join(root, sessionId);
}

export class CheckpointStore {
  readonly dir: string;
  private readonly blobsDir: string;
  private readonly indexPath: string;

  constructor(
    readonly root: string,
    readonly sessionId: string,
    readonly caps: CheckpointCaps = DEFAULT_CHECKPOINT_CAPS,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = sessionCheckpointDir(root, sessionId);
    this.blobsDir = path.join(this.dir, "blobs");
    this.indexPath = path.join(this.dir, "index.json");
  }

  /** The index, or an empty one. A damaged index is set aside, not lost. */
  load(): CheckpointIndex {
    let text: string;
    try {
      text = fs.readFileSync(this.indexPath, "utf-8");
    } catch {
      return emptyIndex(this.sessionId);
    }
    try {
      const parsed = JSON.parse(text) as CheckpointIndex;
      if (
        parsed?.version === 1 &&
        Array.isArray(parsed.turns) &&
        typeof parsed.lastWritten === "object" &&
        parsed.lastWritten !== null
      ) {
        return parsed;
      }
    } catch {
      // fall through
    }
    try {
      fs.renameSync(this.indexPath, `${this.indexPath}.damaged-${this.now()}`);
    } catch {
      // Leave it; the next save replaces it.
    }
    return emptyIndex(this.sessionId);
  }

  private save(index: CheckpointIndex): void {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomicSync(this.indexPath, JSON.stringify(index));
  }

  private putBlob(data: Buffer): string {
    const hash = sha256(data);
    const file = path.join(this.blobsDir, hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(this.blobsDir, { recursive: true });
      writeFileAtomicSync(file, data);
    }
    return hash;
  }

  readBlob(hash: string): Buffer {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`Not a blob id: ${hash}`);
    }
    const data = fs.readFileSync(path.join(this.blobsDir, hash));
    if (sha256(data) !== hash) {
      throw new Error(`Snapshot ${hash.slice(0, 12)} is damaged`);
    }
    return data;
  }

  private referencedBlobs(index: CheckpointIndex): Map<string, number> {
    const sizes = new Map<string, number>();
    const add = (f: FileSnapshot) => {
      if (f.blob) sizes.set(f.blob, f.bytes ?? 0);
    };
    index.turns.forEach((t) => t.files.forEach(add));
    index.redo?.files.forEach(add);
    index.redo?.removedTurns.forEach((t) => t.files.forEach(add));
    return sizes;
  }

  /** Stored bytes, each blob counted once. */
  storedBytes(index: CheckpointIndex = this.load()): number {
    let total = 0;
    for (const size of this.referencedBlobs(index).values()) total += size;
    return total;
  }

  /** Delete blobs no turn or redo record refers to. */
  private collectGarbage(index: CheckpointIndex): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.blobsDir);
    } catch {
      return;
    }
    const keep = this.referencedBlobs(index);
    for (const name of names) {
      if (!keep.has(name)) {
        fs.rmSync(path.join(this.blobsDir, name), { force: true });
      }
    }
  }

  /** The turn this write belongs to: the last one if it is the same prompt. */
  private turnFor(index: CheckpointIndex, ref: TurnRef): CheckpointTurn {
    const last = index.turns[index.turns.length - 1];
    // Same prompt and not a later message: the same turn. Compaction can
    // lower the message's index mid-turn, which is still the same turn; the
    // same text sent again later is a new one.
    if (
      last &&
      last.promptHash === ref.promptHash &&
      ref.userIndex <= last.userIndex
    ) {
      return last;
    }
    const turn: CheckpointTurn = {
      turnId: randomUUID(),
      createdAt: this.now(),
      label: ref.label,
      promptHash: ref.promptHash,
      userIndex: ref.userIndex,
      files: [],
    };
    index.turns.push(turn);
    return turn;
  }

  /**
   * Snapshot `file` before the agent writes it. Only the first write of a
   * file in a turn is captured. A new write ends any pending redo. Returns
   * the snapshot taken, or undefined when the turn already had one.
   */
  snapshotBefore(file: string, ref: TurnRef): FileSnapshot | undefined {
    const index = this.load();
    if (index.redo) {
      delete index.redo;
    }
    const turn = this.turnFor(index, ref);
    if (turn.files.some((f) => f.uri === file)) {
      this.save(index);
      return undefined;
    }

    const snapshot = this.capture(file);
    turn.files.push(snapshot);

    // Turn cap: drop the oldest turns. Restoring to any turn still listed
    // stays exact, since a restore only reads the target turn and later ones.
    while (index.turns.length > this.caps.maxTurns) {
      index.turns.shift();
    }
    // Byte cap: drop the oldest turns, never the current one.
    while (
      this.storedBytes(index) > this.caps.maxSessionBytes &&
      index.turns.length > 1 &&
      index.turns[0] !== turn
    ) {
      index.turns.shift();
    }
    if (this.storedBytes(index) > this.caps.maxSessionBytes && snapshot.blob) {
      const own = turn.files.indexOf(snapshot);
      turn.files[own] = {
        uri: file,
        existed: true,
        bytes: snapshot.bytes,
        skipped: "session_cap",
      };
    }
    this.save(index);
    this.collectGarbage(index);
    return turn.files.find((f) => f.uri === file);
  }

  private capture(file: string): FileSnapshot {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { uri: file, existed: false };
      }
      return { uri: file, existed: true, skipped: "unreadable" };
    }
    if (!stat.isFile()) {
      return { uri: file, existed: true, skipped: "not_a_file" };
    }
    if (checkpointHoldsSecret(file)) {
      return { uri: file, existed: true, skipped: "secret" };
    }
    if (stat.size >= this.caps.maxFileBytes) {
      return {
        uri: file,
        existed: true,
        bytes: stat.size,
        skipped: "too_large",
      };
    }
    try {
      const data = fs.readFileSync(file);
      if (data.length >= this.caps.maxFileBytes) {
        return {
          uri: file,
          existed: true,
          bytes: data.length,
          skipped: "too_large",
        };
      }
      return {
        uri: file,
        existed: true,
        blob: this.putBlob(data),
        bytes: data.length,
      };
    } catch {
      return { uri: file, existed: true, skipped: "unreadable" };
    }
  }

  /** Remember what the agent wrote, to tell later outside changes apart. */
  recordWrite(file: string, content: string | Buffer): void {
    const index = this.load();
    index.lastWritten[file] = sha256(
      typeof content === "string" ? Buffer.from(content, "utf-8") : content,
    );
    this.save(index);
  }

  turns(): CheckpointTurn[] {
    return this.load().turns;
  }

  /**
   * What restoring to before `targetTurnId` would change, compared with the
   * files now. Files that already match are left out.
   */
  planRewind(
    targetTurnId: string,
    index: CheckpointIndex = this.load(),
  ): RewindItem[] {
    const order = index.turns.map((t) => t.turnId);
    const plan = planRestore<FileSnapshot>(index.turns, order, targetTurnId);
    const items: RewindItem[] = [];
    for (const snapshot of plan) {
      const item = this.compare(snapshot, index.lastWritten[snapshot.uri]);
      if (item) items.push(item);
    }
    return items;
  }

  private compare(
    snapshot: FileSnapshot,
    lastWritten: string | null | undefined,
  ): RewindItem | undefined {
    const { uri } = snapshot;
    let current: CurrentState;
    try {
      current = readCurrent(uri);
    } catch {
      current = { exists: true };
    }
    const target = snapshot.existed ? (snapshot.blob ?? null) : null;
    if (snapshot.existed && !snapshot.blob) {
      return {
        uri,
        action: "unrestorable",
        snapshot,
        changedOutside: false,
        added: 0,
        removed: 0,
      };
    }
    if (current.exists ? current.hash === target : target === null) {
      return undefined;
    }
    // `undefined`: the agent never finished a write (the tool failed after
    // the snapshot), so any difference from the snapshot came from outside.
    const changedOutside =
      lastWritten === undefined
        ? true
        : lastWritten === null
          ? current.exists
          : !current.exists || current.hash !== lastWritten;

    const now = current.data?.toString("utf-8") ?? "";
    let then = "";
    try {
      then = target ? this.readBlob(target).toString("utf-8") : "";
    } catch {
      // A damaged snapshot: the restore reports it as failed.
    }
    const { added, removed } = lineChanges(now, then);
    let action: RewindAction = "delete";
    if (snapshot.existed) action = current.exists ? "restore" : "recreate";
    return { uri, action, snapshot, changedOutside, added, removed };
  }

  /**
   * Restore the files to before `targetTurnId` and keep what was undone for
   * one redo. Files changed outside the agent are refused unless
   * `confirmChanged`. With `files: false` only the conversation part is
   * recorded (for redo) and no file is touched.
   */
  rewind(
    targetTurnId: string,
    options: {
      confirmChanged?: boolean;
      files?: boolean;
      conversation?: { atIndex: number; items: unknown[] };
    } = {},
  ): RewindResult {
    const { confirmChanged = false, files = true } = options;
    const index = this.load();
    const result: RewindResult = {
      restored: [],
      deleted: [],
      refused: [],
      unrestorable: [],
      failed: [],
    };
    const items = files ? this.planRewind(targetTurnId, index) : [];
    const redo: RedoRecord = {
      createdAt: this.now(),
      targetTurnId,
      files: [],
      expected: {},
      removedTurns: [],
      lastWrittenBefore: {},
      conversation: options.conversation,
    };
    const keep = new Set<string>();

    for (const item of items) {
      const { uri, action, snapshot } = item;
      if (action === "unrestorable") {
        result.unrestorable.push({
          uri,
          reason: snapshot.skipped ?? "unknown",
        });
        keep.add(uri);
        continue;
      }
      if (item.changedOutside && !confirmChanged) {
        result.refused.push(uri);
        keep.add(uri);
        continue;
      }
      try {
        const before = this.capture(uri);
        if (before.skipped) {
          throw new Error(
            `cannot keep the current file for redo (${before.skipped})`,
          );
        }
        if (action === "delete") {
          fs.rmSync(uri, { force: true });
          redo.expected[uri] = null;
          result.deleted.push(uri);
        } else {
          const data = this.readBlob(snapshot.blob!);
          fs.mkdirSync(path.dirname(uri), { recursive: true });
          writeFileAtomicSync(uri, data);
          redo.expected[uri] = snapshot.blob!;
          result.restored.push(uri);
        }
        redo.files.push(before);
        if (index.lastWritten[uri] !== undefined) {
          redo.lastWrittenBefore[uri] = index.lastWritten[uri];
        }
        // The restored state is now the agent's last word on the file.
        if (action === "delete") delete index.lastWritten[uri];
        else index.lastWritten[uri] = snapshot.blob!;
      } catch (error) {
        keep.add(uri);
        result.failed.push({
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (files) {
      const order = index.turns.map((t) => t.turnId);
      const start = order.indexOf(targetTurnId);
      if (start !== -1) {
        redo.removedTurns = index.turns.slice(start);
        index.turns = pruneCheckpointsFrom(
          index.turns,
          order,
          targetTurnId,
          keep,
        );
      }
    }
    index.redo = redo;
    this.save(index);
    this.collectGarbage(index);
    return result;
  }

  /** The pending redo, if the last change to the store was a rewind. */
  redoRecord(): RedoRecord | undefined {
    return this.load().redo;
  }

  /** What redo would put back, with files changed since the rewind flagged. */
  planRedo(index: CheckpointIndex = this.load()): RewindItem[] {
    const redo = index.redo;
    if (!redo) return [];
    const items: RewindItem[] = [];
    for (const snapshot of redo.files) {
      const item = this.compare(snapshot, redo.expected[snapshot.uri]);
      if (item) items.push(item);
    }
    return items;
  }

  /**
   * Undo the last rewind: put the files back as they were just before it and
   * return the history items it cut, for the caller to put back. Available
   * until the agent writes again.
   */
  redo(
    options: { confirmChanged?: boolean } = {},
  ):
    | (RewindResult & { conversation?: { atIndex: number; items: unknown[] } })
    | undefined {
    const index = this.load();
    const redo = index.redo;
    if (!redo) return undefined;
    const result: RewindResult = {
      restored: [],
      deleted: [],
      refused: [],
      unrestorable: [],
      failed: [],
    };
    for (const item of this.planRedo(index)) {
      const { uri, action, snapshot } = item;
      if (item.changedOutside && !options.confirmChanged) {
        result.refused.push(uri);
        continue;
      }
      try {
        if (action === "delete") {
          fs.rmSync(uri, { force: true });
          result.deleted.push(uri);
        } else {
          fs.mkdirSync(path.dirname(uri), { recursive: true });
          writeFileAtomicSync(uri, this.readBlob(snapshot.blob!));
          result.restored.push(uri);
        }
      } catch (error) {
        result.failed.push({
          uri,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Put the undone turns back after the ones that survived the rewind
    // (failed and refused files kept their turn entries; drop those copies).
    const kept = new Set(redo.removedTurns.map((t) => t.turnId));
    index.turns = [
      ...index.turns.filter((t) => !kept.has(t.turnId)),
      ...redo.removedTurns,
    ];
    for (const uri of Object.keys(redo.expected)) {
      if (result.refused.includes(uri)) continue;
      const before = redo.lastWrittenBefore[uri];
      if (before === undefined) delete index.lastWritten[uri];
      else index.lastWritten[uri] = before;
    }
    delete index.redo;
    this.save(index);
    this.collectGarbage(index);
    return { ...result, conversation: redo.conversation };
  }

  /** Remove this session's checkpoints. */
  deleteAll(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
