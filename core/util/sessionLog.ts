/**
 * Append-only session log (STOR6), with large strings as blobs (STOR7).
 *
 * `sessions/<id>.jsonl` holds one JSON value per line:
 *
 *   {"t":"header","format":"continuous-session","v":1,"sessionId":"..."}
 *   {"t":"meta","k":"title","v":"..."}        a session field set
 *   {"t":"meta","k":"loop","d":1}             a session field removed
 *   {"t":"item","i":3,"v":{...}}              history[3] appended or replaced
 *   {"t":"trunc","n":5}                       history cut to 5 items
 *
 * Reading replays the lines in order. A snapshot is the same lines for the
 * current state only (header, one meta line per field, one item line per
 * item); it is what a new session and a migrated `.json` start with, and what
 * compaction rewrites the log to when it is COMPACT_RATIO times the live size.
 *
 * Crash safety: a write appends whole lines, and a snapshot is written to a
 * temp file and renamed. A last line cut short by a crash has no newline and
 * is ignored on load (and cut off the file, so the next append starts on a
 * line of its own); every line before it is kept. A line that does not parse
 * in the middle is skipped and counted.
 *
 * Writes are off the caller's path: `SessionLogWriter.save*` encode the
 * change and queue it; one asynchronous write per session runs at a time,
 * and changes queued meanwhile are coalesced (the newest line per item or
 * field wins). A load in the same process sees queued changes.
 *
 * Node only.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Session, SessionDelta, SessionSaveResult } from "../index.js";

export type { SessionDelta, SessionSaveResult };

import {
  blobRefs,
  type BlobSink,
  decodeItem,
  type DecodeStats,
  encodeItem,
  type EncodeContext,
  rememberToolOutputs,
} from "./sessionBlobs.js";

export const SESSION_LOG_FORMAT = "continuous-session";
export const SESSION_LOG_VERSION = 1;
/** Compact when the log is this many times the size of a snapshot. */
export const COMPACT_RATIO = 2;
/** ... and at least this big, so short sessions never compact. */
export const COMPACT_MIN_BYTES = 256 * 1024;
export { SESSION_LOG_STORAGE_DEFAULT } from "./constants.js";

type MetaKey = Exclude<keyof Session, "history" | "sessionId">;

/** The order fields are written in, as `HistoryManager.save` always has. */
export const SESSION_META_ORDER: MetaKey[] = [
  "title",
  "workspaceDirectory",
  "mode",
  "chatModelTitle",
  "usage",
  "promptCache",
  "checkpoints",
  "taskPlan",
  "planFile",
  "queuedMessages",
  "loop",
  "loopRequested",
  "forkedFrom",
];

/**
 * The fields of `session` that are saved, in the saved order. Empty lists
 * and unset flags are left out, as the JSON format always did.
 */
export function orderSessionForSave(session: Session): Session {
  const ordered: Session = {
    sessionId: session.sessionId,
    title: session.title,
    workspaceDirectory: session.workspaceDirectory,
    history: session.history,
  };
  if (session.mode) ordered.mode = session.mode;
  if (session.chatModelTitle !== undefined) {
    ordered.chatModelTitle = session.chatModelTitle;
  }
  if (session.usage !== undefined) ordered.usage = session.usage;
  if (session.promptCache !== undefined) {
    ordered.promptCache = session.promptCache;
  }
  if (session.checkpoints?.length) ordered.checkpoints = session.checkpoints;
  if (session.taskPlan?.items.length) ordered.taskPlan = session.taskPlan;
  if (session.planFile) ordered.planFile = session.planFile;
  if (session.queuedMessages?.length) {
    ordered.queuedMessages = session.queuedMessages;
  }
  if (session.loop) ordered.loop = session.loop;
  if (session.loopRequested) ordered.loopRequested = true;
  if (session.forkedFrom) ordered.forkedFrom = session.forkedFrom;
  return ordered;
}

/** The saved meta fields of `session`, unset ones absent. */
function metaOf(session: Session): Map<string, unknown> {
  const ordered = orderSessionForSave(session) as unknown as Record<
    string,
    unknown
  >;
  const meta = new Map<string, unknown>();
  for (const k of SESSION_META_ORDER) {
    if (k in ordered && ordered[k] !== undefined) meta.set(k, ordered[k]);
  }
  return meta;
}

// ---------------------------------------------------------------- reading

export interface ReplayResult {
  sessionId: string;
  meta: Map<string, unknown>;
  /** Items as stored (blob references not read). */
  items: unknown[];
  /** Byte length of each item's newest line. */
  itemBytes: number[];
  metaBytes: Map<string, number>;
  headerBytes: number;
  /** Bytes of whole lines read: where the next append goes. */
  validBytes: number;
  /** A last line without a newline was ignored. */
  torn: boolean;
  /** Lines in the middle that did not parse and were skipped. */
  badLines: number;
}

/** Why a log cannot be used, without quoting it. */
export type ReplayFailure = { reason: string };

/** Replays `text`; `base` continues from an earlier replay of the same log. */
export function replaySessionLog(
  text: string,
  base?: ReplayResult,
): ReplayResult | ReplayFailure {
  if (!base && text.trim() === "") return { reason: "the file is empty" };
  const r: ReplayResult = base ?? {
    sessionId: "",
    meta: new Map(),
    items: [],
    itemBytes: [],
    metaBytes: new Map(),
    headerBytes: 0,
    validBytes: 0,
    torn: false,
    badLines: 0,
  };
  let start = 0;
  let first = !base;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      r.torn = true;
      break;
    }
    const line = text.slice(start, nl);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    start = nl + 1;
    r.validBytes += bytes;
    if (line.trim() === "") continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      if (first) return { reason: "its first line is not a session header" };
      r.badLines++;
      continue;
    }
    if (first) {
      if (rec?.t !== "header" || rec.format !== SESSION_LOG_FORMAT) {
        return { reason: "its first line is not a session header" };
      }
      if (typeof rec.v !== "number" || rec.v > SESSION_LOG_VERSION) {
        return { reason: `it is a newer session format (${String(rec.v)})` };
      }
      r.sessionId = String(rec.sessionId ?? "");
      r.headerBytes = bytes;
      first = false;
      continue;
    }
    switch (rec?.t) {
      case "meta":
        if (typeof rec.k !== "string") break;
        if (rec.d) {
          r.meta.delete(rec.k);
          r.metaBytes.delete(rec.k);
        } else {
          r.meta.set(rec.k, rec.v);
          r.metaBytes.set(rec.k, bytes);
        }
        break;
      case "item":
        if (!Number.isInteger(rec.i) || rec.i < 0 || rec.i > r.items.length) {
          r.badLines++;
          break;
        }
        r.items[rec.i] = rec.v;
        r.itemBytes[rec.i] = bytes;
        break;
      case "trunc":
        if (Number.isInteger(rec.n) && rec.n >= 0 && rec.n < r.items.length) {
          r.items.length = rec.n;
          r.itemBytes.length = rec.n;
        }
        break;
      case "header":
        // A snapshot written after an append (should not happen): ignore
        break;
      default:
        r.badLines++;
    }
  }
  if (first) return { reason: "its first line is not a session header" };
  return r;
}

/** The session a replay describes, blob references read through `readBlob`. */
export function sessionFromReplay(
  r: ReplayResult,
  readBlob: (hash: string) => string | undefined,
  stats: DecodeStats = { missing: new Set() },
): Session {
  const raw: Record<string, unknown> = {
    sessionId: r.sessionId,
    title: "",
    workspaceDirectory: "",
    history: r.items.map((item) => decodeItem(item, readBlob, stats)),
  };
  for (const k of SESSION_META_ORDER) {
    if (r.meta.has(k)) raw[k] = decodeItem(r.meta.get(k), readBlob, stats);
  }
  return orderSessionForSave(raw as unknown as Session);
}

/** Reads blobs from a session's blob folder, each file at most once. */
export function blobReader(
  dir: string,
  overlay?: Map<string, string>,
): (hash: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (hash) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    const pending = overlay?.get(hash);
    if (pending !== undefined) return pending;
    if (cache.has(hash)) return cache.get(hash);
    let text: string | undefined;
    try {
      text = fs.readFileSync(path.join(dir, hash), "utf8");
    } catch {
      text = undefined;
    }
    cache.set(hash, text);
    return text;
  };
}

// ---------------------------------------------------------------- writing

function line(rec: unknown): string {
  return `${JSON.stringify(rec)}\n`;
}

function headerLine(sessionId: string): string {
  return line({
    t: "header",
    format: SESSION_LOG_FORMAT,
    v: SESSION_LOG_VERSION,
    sessionId,
  });
}

function itemHash(item: unknown): string {
  return createHash("sha1").update(JSON.stringify(item)).digest("hex");
}

function roleOf(item: unknown): string {
  return String((item as any)?.message?.role ?? "");
}

let revCounter = 0;
const PROCESS_TOKEN = createHash("sha1")
  .update(`${process.pid}:${Date.now()}:${Math.random()}`)
  .digest("hex")
  .slice(0, 8);

function nextRev(): string {
  return `${PROCESS_TOKEN}.${++revCounter}`;
}

export interface SessionListEntry {
  title: string;
  workspaceDirectory: string;
  messageCount: number;
  /** The log plus its blobs, as last written to sessions.json. */
  fileBytes?: number;
}

/** Counters for tests and for the write-cost measurement. */
export interface SessionLogStats {
  appends: number;
  snapshots: number;
  compactions: number;
  bytesWritten: number;
  blobBytesWritten: number;
  blobsWritten: number;
}

type Snapshot = {
  kind: "snapshot";
  /** The lines of the new file. */
  text: string;
  /** The legacy `.json` this snapshot replaces once it reads back the same. */
  migrateFrom?: string;
  /** The session as the snapshot must read back, for the migration check. */
  expect?: Session;
};

interface LogState {
  sessionId: string;
  file: string;
  blobDir: string;
  rev: string;
  itemHashes: (string | undefined)[];
  itemBytes: number[];
  roles: string[];
  metaJson: Map<string, string>;
  metaBytes: Map<string, number>;
  headerBytes: number;
  /** Bytes the file will have once everything queued is written. */
  logBytes: number;
  /** Bytes on disk after the last completed write. */
  diskBytes: number;
  knownBlobs: Set<string>;
  /**
   * Bytes of the blobs in `knownBlobs`, each counted once: with `logBytes`,
   * what the session takes on disk (the size guard, STOR8).
   */
  blobBytes: number;
  toolOutputs: EncodeContext["toolOutputs"];
  /** A fork's parent blob folder: blobs found there are linked, not written. */
  linkFrom?: string;
  // queue
  pendingOps: Map<string, string>;
  pendingTrunc?: number;
  pendingBlobs: Map<string, string>;
  pendingSnapshot?: Snapshot;
  compactQueued: boolean;
  running: boolean;
  inflight?: { start: number; text: string } | { snapshotText: string };
  waiters: (() => void)[];
  dropped: boolean;
  /** The migration check failed: this session is saved as `.json`. */
  jsonFallback: boolean;
  listed?: SessionListEntry;
}

export interface SessionLogPaths {
  logFile(sessionId: string): string;
  jsonFile(sessionId: string): string;
  blobDir(sessionId: string): string;
}

/** The write side of the session log, one per process. */
export class SessionLogWriter {
  private states = new Map<string, LogState>();
  readonly stats: SessionLogStats = {
    appends: 0,
    snapshots: 0,
    compactions: 0,
    bytesWritten: 0,
    blobBytesWritten: 0,
    blobsWritten: 0,
  };
  /** Called with a short message when a write fails; never quotes content. */
  onError: (message: string) => void = (m) => console.warn(m);

  constructor(private paths: SessionLogPaths) {}

  /** True when a delta can be applied to `sessionId` at `rev`. */
  canApply(sessionId: string, rev: string): boolean {
    const s = this.states.get(sessionId);
    return !!s && !s.dropped && !s.jsonFallback && s.rev === rev;
  }

  isJsonFallback(sessionId: string): boolean {
    return !!this.states.get(sessionId)?.jsonFallback;
  }

  listEntry(sessionId: string): SessionListEntry | undefined {
    return this.states.get(sessionId)?.listed;
  }

  setListed(sessionId: string, entry: SessionListEntry): void {
    const s = this.states.get(sessionId);
    if (s) s.listed = entry;
  }

  messageCount(sessionId: string): number {
    return (this.states.get(sessionId)?.roles ?? []).filter(
      (r) => r === "assistant",
    ).length;
  }

  /** Forgets a session and drops what is queued for it (delete, JSON save). */
  drop(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    s.dropped = true;
    s.pendingOps.clear();
    s.pendingBlobs.clear();
    s.pendingSnapshot = undefined;
    s.compactQueued = false;
    this.states.delete(sessionId);
    for (const w of s.waiters.splice(0)) w();
  }

  dropAll(): void {
    for (const id of [...this.states.keys()]) this.drop(id);
  }

  /**
   * Saves the whole session: appends the items and fields that differ from
   * the last save in this process, or writes a snapshot when this process
   * has not seen the log yet, the file changed under it, or (`migrate`) a
   * legacy `.json` is to be replaced.
   */
  saveFull(session: Session): SessionSaveResult {
    const id = session.sessionId;
    let s = this.states.get(id);
    if (s && (s.jsonFallback || s.dropped)) {
      return { rev: null };
    }
    if (!s || !this.fileMatches(s)) {
      s = this.snapshotFromSession(session, s);
      return { rev: s.rev };
    }
    const hashes = session.history.map(itemHash);
    const ctx = this.encodeContext(s);
    const oldLen = s.itemHashes.length;
    const newLen = session.history.length;
    if (newLen < oldLen) this.queueTrunc(s, newLen);
    for (let i = 0; i < newLen; i++) {
      if (i < oldLen && hashes[i] === s.itemHashes[i]) continue;
      this.queueItem(s, i, session.history[i], hashes[i], ctx);
    }
    this.queueMeta(s, metaOf(session), true, ctx);
    s.rev = nextRev();
    this.afterQueue(s);
    return { rev: s.rev };
  }

  /** Applies a delta; answers needFull when it cannot be applied here. */
  saveDelta(delta: SessionDelta): SessionSaveResult {
    const s = this.states.get(delta.sessionId);
    if (!s || !this.canApply(delta.sessionId, delta.baseRev)) {
      return { rev: null, needFull: true };
    }
    if (!this.fileMatches(s)) {
      this.drop(delta.sessionId);
      return { rev: null, needFull: true };
    }
    const oldLen = s.itemHashes.length;
    const given = new Map(delta.items.map((d) => [d.index, d.item]));
    for (let i = oldLen; i < delta.length; i++) {
      if (!given.has(i)) return { rev: null, needFull: true };
    }
    for (const index of given.keys()) {
      if (!Number.isInteger(index) || index < 0 || index >= delta.length) {
        return { rev: null, needFull: true };
      }
    }
    const ctx = this.encodeContext(s);
    if (delta.length < oldLen) this.queueTrunc(s, delta.length);
    for (const index of [...given.keys()].sort((a, b) => a - b)) {
      const item = given.get(index);
      this.queueItem(s, index, item, itemHash(item), ctx);
    }
    const meta = new Map<string, unknown>();
    for (const k of SESSION_META_ORDER) {
      const v = (delta.meta as Record<string, unknown>)[k];
      if (v !== undefined) meta.set(k, v);
    }
    this.queueMeta(s, meta, false, ctx);
    for (const k of delta.unset ?? []) {
      if (s.metaJson.has(k)) this.queueMetaUnset(s, k);
    }
    s.rev = nextRev();
    this.afterQueue(s);
    return { rev: s.rev };
  }

  /**
   * Takes over a log that was just read, so the next save appends to it.
   * Ignored while this process still has writes queued for the session: its
   * own state is newer than the file.
   */
  adopt(
    sessionId: string,
    replay: ReplayResult,
    decodedItems: unknown[],
  ): string | undefined {
    const existing = this.states.get(sessionId);
    if (existing && (existing.running || this.hasPending(existing))) {
      return existing.rev;
    }
    if (existing?.jsonFallback) return undefined;
    const s = this.newState(sessionId);
    s.itemHashes = decodedItems.map(itemHash);
    s.itemBytes = [...replay.itemBytes];
    s.roles = decodedItems.map(roleOf);
    for (const [k, v] of replay.meta) {
      s.metaJson.set(k, JSON.stringify(v));
      s.metaBytes.set(k, replay.metaBytes.get(k) ?? 0);
    }
    s.headerBytes = replay.headerBytes;
    s.logBytes = s.diskBytes = replay.validBytes;
    for (const item of replay.items) {
      for (const h of blobRefs(item)) s.knownBlobs.add(h);
    }
    for (const value of replay.meta.values()) {
      for (const h of blobRefs(value)) s.knownBlobs.add(h);
    }
    s.blobBytes = storedBlobBytes(s.blobDir, s.knownBlobs);
    // Tool outputs, so a later tool message for one of these calls joins it
    const ctx = this.encodeContext(s);
    for (const item of decodedItems) rememberToolOutputs(item, ctx);
    this.states.set(sessionId, s);
    return s.rev;
  }

  /** What a load in this process must add to what is on disk. */
  overlay(sessionId: string):
    | {
        /** Replay this instead of the file (a snapshot being written). */
        replaceText?: string;
        /** Replay the file only up to here, then `inflightText`. */
        inflightStart?: number;
        inflightText?: string;
        pendingText: string;
        blobs: Map<string, string>;
      }
    | undefined {
    const s = this.states.get(sessionId);
    if (!s || (!s.running && !this.hasPending(s))) return undefined;
    const blobs = new Map(s.pendingBlobs);
    let replaceText: string | undefined;
    let inflightStart: number | undefined;
    let inflightText: string | undefined;
    if (s.inflight && "snapshotText" in s.inflight) {
      replaceText = s.inflight.snapshotText;
    } else if (s.inflight) {
      inflightStart = s.inflight.start;
      inflightText = s.inflight.text;
    }
    let pendingText = "";
    if (s.pendingSnapshot) {
      replaceText = s.pendingSnapshot.text;
      inflightStart = inflightText = undefined;
    }
    pendingText += this.pendingOpsText(s);
    return { replaceText, inflightStart, inflightText, pendingText, blobs };
  }

  /**
   * What the session takes on disk once its queued writes are done: the log
   * plus the blobs it refers to. Undefined when this process has no state
   * for it (not loaded or saved here, or saved as `.json`).
   */
  sessionBytes(
    sessionId: string,
  ): { logBytes: number; blobBytes: number } | undefined {
    const s = this.states.get(sessionId);
    if (!s || s.dropped || s.jsonFallback) return undefined;
    return { logBytes: s.logBytes, blobBytes: s.blobBytes };
  }

  /** Resolves when everything queued for `sessionId` (or all) is written. */
  async flush(sessionId?: string): Promise<void> {
    const states = sessionId
      ? [this.states.get(sessionId)].filter((s): s is LogState => !!s)
      : [...this.states.values()];
    await Promise.all(
      states.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s.running && !this.hasPending(s)) resolve();
            else s.waiters.push(resolve);
          }),
      ),
    );
  }

  /**
   * Writes what is queued and not yet started, synchronously (process exit).
   * A write already running is left to finish or not: a line it cuts short
   * is ignored on the next load.
   */
  flushAllSync(): void {
    for (const s of this.states.values()) {
      if (s.running || !this.hasPending(s)) continue;
      try {
        for (const [hash, text] of s.pendingBlobs) {
          this.writeBlobSync(s, hash, text);
        }
        s.pendingBlobs.clear();
        if (s.pendingSnapshot) {
          const snap = s.pendingSnapshot;
          s.pendingSnapshot = undefined;
          const tmp = `${s.file}.${process.pid}.exit.tmp`;
          fs.writeFileSync(tmp, snap.text, { mode: 0o600 });
          fs.renameSync(tmp, s.file);
          s.diskBytes = Buffer.byteLength(snap.text, "utf8");
        }
        const text = this.takePendingOps(s);
        if (text) {
          fs.appendFileSync(s.file, text, { mode: 0o600 });
          s.diskBytes += Buffer.byteLength(text, "utf8");
        }
      } catch {
        // exiting: nothing more can be done
      }
    }
  }

  // ------------------------------------------------------------ internals

  private newState(sessionId: string): LogState {
    return {
      sessionId,
      file: this.paths.logFile(sessionId),
      blobDir: this.paths.blobDir(sessionId),
      rev: nextRev(),
      itemHashes: [],
      itemBytes: [],
      roles: [],
      metaJson: new Map(),
      metaBytes: new Map(),
      headerBytes: 0,
      logBytes: 0,
      diskBytes: 0,
      knownBlobs: new Set(),
      blobBytes: 0,
      toolOutputs: new Map(),
      pendingOps: new Map(),
      pendingBlobs: new Map(),
      compactQueued: false,
      running: false,
      waiters: [],
      dropped: false,
      jsonFallback: false,
    };
  }

  private hasPending(s: LogState): boolean {
    return (
      s.pendingOps.size > 0 ||
      s.pendingTrunc !== undefined ||
      s.pendingBlobs.size > 0 ||
      !!s.pendingSnapshot ||
      s.compactQueued
    );
  }

  /** The file is as this process left it (another window did not write it). */
  private fileMatches(s: LogState): boolean {
    if (s.running || this.hasPending(s)) return true;
    try {
      return fs.statSync(s.file).size === s.diskBytes;
    } catch {
      return false;
    }
  }

  private encodeContext(s: LogState): EncodeContext {
    const sink: BlobSink = {
      has: (hash) => s.knownBlobs.has(hash),
      put: (hash, text) => {
        if (!s.knownBlobs.has(hash)) {
          s.blobBytes += Buffer.byteLength(text, "utf8");
        }
        s.knownBlobs.add(hash);
        s.pendingBlobs.set(hash, text);
      },
    };
    return { sink, toolOutputs: s.toolOutputs };
  }

  private snapshotFromSession(session: Session, old?: LogState): LogState {
    const id = session.sessionId;
    if (old) this.drop(id);
    const s = this.newState(id);
    if (session.forkedFrom?.sessionId) {
      s.linkFrom = this.paths.blobDir(session.forkedFrom.sessionId);
    }
    const ctx = this.encodeContext(s);
    let text = headerLine(id);
    s.headerBytes = Buffer.byteLength(text, "utf8");
    for (const [k, v] of metaOf(session)) {
      const l = line({ t: "meta", k, v: encodeItem(v, ctx) });
      text += l;
      s.metaJson.set(k, JSON.stringify(v));
      s.metaBytes.set(k, Buffer.byteLength(l, "utf8"));
    }
    session.history.forEach((item, i) => {
      const l = line({ t: "item", i, v: encodeItem(item, ctx) });
      text += l;
      s.itemHashes[i] = itemHash(item);
      s.itemBytes[i] = Buffer.byteLength(l, "utf8");
      s.roles[i] = roleOf(item);
    });
    s.logBytes = Buffer.byteLength(text, "utf8");
    const legacy = this.paths.jsonFile(id);
    const migrating = fs.existsSync(legacy);
    s.pendingSnapshot = {
      kind: "snapshot",
      text,
      ...(migrating && {
        migrateFrom: legacy,
        expect: JSON.parse(JSON.stringify(orderSessionForSave(session))),
      }),
    };
    this.states.set(id, s);
    this.afterQueue(s);
    return s;
  }

  private queueTrunc(s: LogState, n: number): void {
    for (const key of [...s.pendingOps.keys()]) {
      if (key.startsWith("i:") && Number(key.slice(2)) >= n) {
        s.pendingOps.delete(key);
      }
    }
    s.pendingTrunc = Math.min(s.pendingTrunc ?? Infinity, n);
    const line_ = line({ t: "trunc", n });
    s.logBytes += Buffer.byteLength(line_, "utf8");
    s.itemHashes.length = n;
    s.itemBytes.length = n;
    s.roles.length = n;
  }

  private queueItem(
    s: LogState,
    i: number,
    item: unknown,
    hash: string,
    ctx: EncodeContext,
  ): void {
    const l = line({ t: "item", i, v: encodeItem(item, ctx) });
    const bytes = Buffer.byteLength(l, "utf8");
    s.pendingOps.delete(`i:${i}`);
    s.pendingOps.set(`i:${i}`, l);
    s.logBytes += bytes;
    s.itemHashes[i] = hash;
    s.itemBytes[i] = bytes;
    s.roles[i] = roleOf(item);
  }

  private queueMeta(
    s: LogState,
    meta: Map<string, unknown>,
    complete: boolean,
    ctx: EncodeContext,
  ): void {
    for (const [k, v] of meta) {
      const json = JSON.stringify(v);
      if (s.metaJson.get(k) === json) continue;
      const l = line({ t: "meta", k, v: encodeItem(v, ctx) });
      const bytes = Buffer.byteLength(l, "utf8");
      s.pendingOps.delete(`m:${k}`);
      s.pendingOps.set(`m:${k}`, l);
      s.metaJson.set(k, json);
      s.metaBytes.set(k, bytes);
      s.logBytes += bytes;
    }
    if (complete) {
      for (const k of [...s.metaJson.keys()]) {
        if (!meta.has(k)) this.queueMetaUnset(s, k);
      }
    }
  }

  private queueMetaUnset(s: LogState, k: string): void {
    const l = line({ t: "meta", k, d: 1 });
    s.pendingOps.delete(`m:${k}`);
    s.pendingOps.set(`m:${k}`, l);
    s.metaJson.delete(k);
    s.metaBytes.delete(k);
    s.logBytes += Buffer.byteLength(l, "utf8");
  }

  private liveBytes(s: LogState): number {
    let n = s.headerBytes;
    for (const b of s.itemBytes) n += b ?? 0;
    for (const b of s.metaBytes.values()) n += b;
    return n;
  }

  private afterQueue(s: LogState): void {
    if (
      !s.pendingSnapshot &&
      !s.compactQueued &&
      s.logBytes > COMPACT_MIN_BYTES &&
      s.logBytes > COMPACT_RATIO * this.liveBytes(s)
    ) {
      s.compactQueued = true;
    }
    if (!s.running) {
      s.running = true;
      setImmediate(() => void this.drain(s));
    }
  }

  private pendingOpsText(s: LogState): string {
    let text = "";
    if (s.pendingTrunc !== undefined) {
      text += line({ t: "trunc", n: s.pendingTrunc });
    }
    for (const l of s.pendingOps.values()) text += l;
    return text;
  }

  private takePendingOps(s: LogState): string {
    const text = this.pendingOpsText(s);
    s.pendingOps.clear();
    s.pendingTrunc = undefined;
    return text;
  }

  private async drain(s: LogState): Promise<void> {
    try {
      while (!s.dropped && !s.jsonFallback && this.hasPending(s)) {
        const blobs = new Map(s.pendingBlobs);
        // Blobs first: a line is never on disk before what it refers to
        if (blobs.size) {
          await fs.promises.mkdir(s.blobDir, { recursive: true, mode: 0o700 });
          for (const [hash, text] of blobs) {
            if (s.dropped) return;
            await this.writeBlob(s, hash, text);
            s.pendingBlobs.delete(hash);
          }
        }
        if (s.dropped) return;
        if (s.pendingSnapshot) {
          const snap = s.pendingSnapshot;
          s.pendingSnapshot = undefined;
          s.inflight = { snapshotText: snap.text };
          await this.writeSnapshot(s, snap);
          s.inflight = undefined;
          continue;
        }
        const text = this.takePendingOps(s);
        if (text) {
          s.inflight = { start: s.diskBytes, text };
          await this.append(s, text);
          s.inflight = undefined;
          continue;
        }
        if (s.compactQueued) {
          s.compactQueued = false;
          await this.compact(s);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "error";
      this.onError(
        `Session ${s.sessionId} could not be written (${code}); it is saved again whole on the next save.`,
      );
      // Start over from the next full save
      this.drop(s.sessionId);
    } finally {
      s.inflight = undefined;
      s.running = false;
      if (!s.dropped && !s.jsonFallback && this.hasPending(s)) {
        s.running = true;
        setImmediate(() => void this.drain(s));
      } else {
        for (const w of s.waiters.splice(0)) w();
      }
    }
  }

  private async writeBlob(
    s: LogState,
    hash: string,
    text: string,
  ): Promise<void> {
    const dest = path.join(s.blobDir, hash);
    try {
      await fs.promises.access(dest);
      return; // content-addressed: present means identical
    } catch {
      // not there yet
    }
    if (s.linkFrom) {
      try {
        await fs.promises.link(path.join(s.linkFrom, hash), dest);
        return;
      } catch {
        // not in the parent, or links not supported: write it
      }
    }
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.promises.rename(tmp, dest);
    } catch (error) {
      await fs.promises.rm(tmp, { force: true });
      // Another process wrote the same content first
      if (!fs.existsSync(dest)) throw error;
    }
    this.stats.blobsWritten++;
    this.stats.blobBytesWritten += Buffer.byteLength(text, "utf8");
  }

  private writeBlobSync(s: LogState, hash: string, text: string): void {
    fs.mkdirSync(s.blobDir, { recursive: true, mode: 0o700 });
    const dest = path.join(s.blobDir, hash);
    if (fs.existsSync(dest)) return;
    fs.writeFileSync(dest, text, { encoding: "utf8", mode: 0o600 });
  }

  private async append(s: LogState, text: string): Promise<void> {
    // Positional, and never creating the file: a session deleted meanwhile
    // stays deleted, and a cut-off line from a crash is written over.
    const handle = await fs.promises.open(s.file, "r+");
    try {
      await handle.write(text, s.diskBytes, "utf8");
    } finally {
      await handle.close();
    }
    const bytes = Buffer.byteLength(text, "utf8");
    s.diskBytes += bytes;
    this.stats.appends++;
    this.stats.bytesWritten += bytes;
  }

  private async writeSnapshot(s: LogState, snap: Snapshot): Promise<void> {
    const tmp = `${s.file}.${process.pid}.${++revCounter}.tmp`;
    await fs.promises.writeFile(tmp, snap.text, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (snap.migrateFrom && snap.expect) {
      const ok = this.readsBackAs(tmp, s.blobDir, snap.expect);
      if (!ok) {
        await fs.promises.rm(tmp, { force: true });
        // This save, and the later ones, go to the .json: changes queued
        // behind the snapshot are in the next whole-session save, which a
        // fallback session always asks for
        s.jsonFallback = true;
        s.pendingOps.clear();
        s.pendingTrunc = undefined;
        s.pendingBlobs.clear();
        s.compactQueued = false;
        const legacyTmp = `${snap.migrateFrom}.${process.pid}.${++revCounter}.tmp`;
        await fs.promises.writeFile(
          legacyTmp,
          JSON.stringify(snap.expect, undefined, 2),
          { encoding: "utf8", mode: 0o600 },
        );
        await renameWithRetry(legacyTmp, snap.migrateFrom);
        this.onError(
          `Session ${s.sessionId} did not read back the same in the new format; it stays in ${path.basename(snap.migrateFrom)}.`,
        );
        return;
      }
    }
    await renameWithRetry(tmp, s.file);
    const bytes = Buffer.byteLength(snap.text, "utf8");
    s.diskBytes = bytes;
    this.stats.snapshots++;
    this.stats.bytesWritten += bytes;
    if (snap.migrateFrom) {
      // The new file reads back the same: the old one is no longer needed
      await fs.promises.rm(snap.migrateFrom, { force: true });
    }
  }

  private readsBackAs(file: string, blobDir: string, expect: Session): boolean {
    try {
      const replay = replaySessionLog(fs.readFileSync(file, "utf8"));
      if ("reason" in replay || replay.torn || replay.badLines) return false;
      const stats: DecodeStats = { missing: new Set() };
      const back = sessionFromReplay(replay, blobReader(blobDir), stats);
      if (stats.missing.size) return false;
      return stableStringify(back) === stableStringify(expect);
    } catch {
      return false;
    }
  }

  /** Rewrites the log as a snapshot of what it holds now. */
  private async compact(s: LogState): Promise<void> {
    const raw = await fs.promises.readFile(s.file, "utf8");
    const replay = replaySessionLog(raw);
    if ("reason" in replay) return;
    let text = headerLine(s.sessionId);
    for (const k of SESSION_META_ORDER) {
      if (!replay.meta.has(k)) continue;
      text += line({ t: "meta", k, v: replay.meta.get(k) });
    }
    replay.items.forEach((item, i) => {
      text += line({ t: "item", i, v: item });
    });
    if (s.dropped || this.hasPending(s)) {
      // New changes arrived while reading: compact on a later turn
      if (!s.dropped) s.compactQueued = true;
      return;
    }
    s.inflight = { snapshotText: text };
    await this.writeSnapshot(s, { kind: "snapshot", text });
    // Changes queued while the snapshot was written go after it
    s.logBytes =
      s.diskBytes + Buffer.byteLength(this.pendingOpsText(s), "utf8");
    this.stats.compactions++;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  let wait = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        process.platform !== "win32" ||
        !["EPERM", "EBUSY", "EACCES"].includes(code) ||
        attempt >= 5
      ) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}

/** JSON with object keys sorted, for comparing two sessions. */
/** Bytes of the given blobs in `dir`; one not stored counts 0. */
function storedBlobBytes(dir: string, hashes: Iterable<string>): number {
  let bytes = 0;
  for (const hash of hashes) {
    try {
      bytes += fs.statSync(path.join(dir, hash)).size;
    } catch {
      // missing: read as a marker, takes no space
    }
  }
  return bytes;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, v[k]]),
      );
    }
    return v;
  });
}
