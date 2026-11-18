/**
 * The session trash (NI10, NI11). Deleting a session from the History page
 * or the terminal picker moves it here instead of removing it:
 *
 *     <global folder>/sessions-trash/<id>/trashed.json   when, and the list entry
 *     <global folder>/sessions-trash/<id>/files/<id>.jsonl or <id>.json
 *     <global folder>/sessions-trash/<id>/files/<id>/     its blob folder
 *
 * The trash is beside `sessions/`, not inside it, so nothing that reads the
 * sessions folder (the list rebuild, `continuous sessions clean`, the
 * orphan-blob scan, the session picker) sees a trashed session as live. A
 * trashed session can be restored for `TRASH_KEEP_MS` (7 days); after that
 * it is removed the next time the list or the trash is read, or a cleanup
 * runs. Nothing here reads a session's contents.
 */
import fs from "node:fs";
import path from "node:path";

import type { BaseSessionMetadata } from "../index.js";

import { writeFileAtomicSync } from "./atomicWrite.js";
import { getGlobalDirPath } from "./paths.js";

export const TRASH_DIR = "sessions-trash";
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a trashed session can be restored. */
export const TRASH_KEEP_DAYS = 7;
export const TRASH_KEEP_MS = TRASH_KEEP_DAYS * DAY_MS;
const ENTRY_FILE = "trashed.json";
const FILES_DIR = "files";

export interface TrashedSession {
  sessionId: string;
  /** Epoch ms when it was moved to the trash. */
  deletedAt: number;
  /** Epoch ms after which it is removed for good. */
  purgeAfter: number;
  /** Its entry in sessions.json when it was deleted (title, folder, counts). */
  metadata: BaseSessionMetadata;
  /** Bytes in the trash: the session file and its blobs. */
  bytes: number;
}

export interface TrashOptions {
  /** The global folder; default the real one. */
  root?: string;
  now?: number;
}

export function trashDir(root: string = getGlobalDirPath()): string {
  return path.join(root, TRASH_DIR);
}

function sessionsDir(root: string): string {
  return path.join(root, "sessions");
}

/** A session id that is safe as one path segment. */
export function isSafeSessionId(sessionId: string): boolean {
  return (
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    !/[\\/:*?"<>|\0]/.test(sessionId) &&
    sessionId !== "." &&
    sessionId !== ".." &&
    sessionId !== "sessions"
  );
}

function assertSafe(sessionId: string): void {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
  }
}

/** The files a session has in `sessions/`, data folder first. */
function liveParts(root: string, sessionId: string): string[] {
  return [sessionId, `${sessionId}.json`, `${sessionId}.jsonl`].filter((n) =>
    fs.existsSync(path.join(sessionsDir(root), n)),
  );
}

/** True when `sessions/` holds a `.json` or `.jsonl` of this session. */
export function liveSessionExists(sessionId: string, root?: string): boolean {
  const dir = sessionsDir(root ?? getGlobalDirPath());
  return (
    fs.existsSync(path.join(dir, `${sessionId}.json`)) ||
    fs.existsSync(path.join(dir, `${sessionId}.jsonl`))
  );
}

/**
 * Rename, or copy and remove when a rename is refused (Windows refuses to
 * rename a file another process has open; a copy keeps the bytes as well).
 */
function move(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw error;
  }
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(from, { recursive: true, force: true });
}

function bytesOf(p: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  for (const name of fs.readdirSync(p)) total += bytesOf(path.join(p, name));
  return total;
}

function readEntry(dir: string): Omit<TrashedSession, "bytes"> | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, ENTRY_FILE), "utf8"),
    ) as Partial<TrashedSession>;
    if (
      !raw ||
      typeof raw.sessionId !== "string" ||
      typeof raw.deletedAt !== "number"
    ) {
      return undefined;
    }
    return {
      sessionId: raw.sessionId,
      deletedAt: raw.deletedAt,
      purgeAfter:
        typeof raw.purgeAfter === "number"
          ? raw.purgeAfter
          : raw.deletedAt + TRASH_KEEP_MS,
      metadata: raw.metadata ?? {
        sessionId: raw.sessionId,
        title: "",
        dateCreated: String(raw.deletedAt),
        workspaceDirectory: "",
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Moves a session's files (its data folder with the blobs, then its `.json`
 * and `.jsonl`) into the trash. `metadata` is what the list showed, kept so
 * a restore puts the same entry back. A session already in the trash under
 * the same id (it was saved again after it was trashed) is replaced. Throws
 * when the session has no file.
 */
export function moveSessionToTrash(
  sessionId: string,
  metadata: BaseSessionMetadata,
  options: TrashOptions = {},
): TrashedSession {
  assertSafe(sessionId);
  const root = options.root ?? getGlobalDirPath();
  const now = options.now ?? Date.now();
  const parts = liveParts(root, sessionId);
  if (!parts.some((p) => p !== sessionId)) {
    throw new Error(`Session ${sessionId} has no file to move to the trash`);
  }
  const entryDir = path.join(trashDir(root), sessionId);
  fs.rmSync(entryDir, { recursive: true, force: true });
  const filesDir = path.join(entryDir, FILES_DIR);
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const entry = {
    sessionId,
    deletedAt: now,
    purgeAfter: now + TRASH_KEEP_MS,
    metadata: { ...metadata, sessionId },
  };
  // Written first: a move that stops half way still shows in the trash
  writeFileAtomicSync(
    path.join(entryDir, ENTRY_FILE),
    JSON.stringify(entry, undefined, 2),
    { mode: 0o600 },
  );
  // The blob folder goes before the log, so a cleanup that runs meanwhile
  // never sees a log whose blobs are gone, nor blobs without their log
  for (const name of parts) {
    move(path.join(sessionsDir(root), name), path.join(filesDir, name));
  }
  return { ...entry, bytes: bytesOf(filesDir) };
}

/**
 * Moves a trashed session back to `sessions/` and removes it from the
 * trash; answers what it was. Throws when it is not in the trash, or when a
 * session with the same id exists again (restoring would replace it).
 */
export function restoreSessionFromTrash(
  sessionId: string,
  options: TrashOptions = {},
): TrashedSession {
  assertSafe(sessionId);
  const root = options.root ?? getGlobalDirPath();
  const entryDir = path.join(trashDir(root), sessionId);
  const entry = readEntry(entryDir);
  if (!entry) throw new Error(`Session ${sessionId} is not in the trash`);
  const filesDir = path.join(entryDir, FILES_DIR);
  const names = fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : [];
  if (liveSessionExists(sessionId, root)) {
    throw new Error(
      `A session with the id ${sessionId} exists again, so the trashed copy was not restored over it`,
    );
  }
  const bytes = bytesOf(filesDir);
  fs.mkdirSync(sessionsDir(root), { recursive: true });
  // Data folder first, as on the way in
  const ordered = names.sort((a, b) =>
    a === sessionId ? -1 : b === sessionId ? 1 : a.localeCompare(b),
  );
  for (const name of ordered) {
    move(path.join(filesDir, name), path.join(sessionsDir(root), name));
  }
  fs.rmSync(entryDir, { recursive: true, force: true });
  return { ...entry, bytes };
}

/** Removes one trashed session for good. Answers false when it was not there. */
export function deleteFromTrash(
  sessionId: string,
  options: TrashOptions = {},
): boolean {
  assertSafe(sessionId);
  const entryDir = path.join(trashDir(options.root), sessionId);
  if (!fs.existsSync(entryDir)) return false;
  fs.rmSync(entryDir, { recursive: true, force: true });
  return true;
}

/**
 * Removes what has been in the trash longer than `TRASH_KEEP_MS`, and
 * folders that are not trash entries at all (a move that failed before its
 * record was written). Best effort: a folder that cannot be removed now is
 * tried again next time.
 */
export function purgeExpiredTrash(options: TrashOptions = {}): {
  removed: string[];
  bytes: number;
} {
  const root = options.root ?? getGlobalDirPath();
  const now = options.now ?? Date.now();
  const dir = trashDir(root);
  const removed: string[] = [];
  let bytes = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, bytes };
  }
  for (const name of names) {
    const entryDir = path.join(dir, name);
    const entry = readEntry(entryDir);
    let expired: boolean;
    if (entry) {
      expired = now >= entry.purgeAfter;
    } else {
      // No record: only once it is as old as an expired entry would be
      try {
        expired = now - fs.statSync(entryDir).mtimeMs >= TRASH_KEEP_MS;
      } catch {
        continue;
      }
    }
    if (!expired) continue;
    try {
      const size = bytesOf(entryDir);
      fs.rmSync(entryDir, { recursive: true, force: true });
      removed.push(entry?.sessionId ?? name);
      bytes += size;
    } catch {
      // tried again on the next read
    }
  }
  return { removed, bytes };
}

/** What is in the trash, newest deletion first; expired entries are removed first. */
export function listTrash(options: TrashOptions = {}): TrashedSession[] {
  purgeExpiredTrash(options);
  const dir = trashDir(options.root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: TrashedSession[] = [];
  for (const name of names) {
    const entryDir = path.join(dir, name);
    const entry = readEntry(entryDir);
    if (!entry) continue;
    out.push({ ...entry, bytes: bytesOf(path.join(entryDir, FILES_DIR)) });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Removes everything in the trash. Answers how many sessions went. */
export function emptyTrash(options: TrashOptions = {}): number {
  const dir = trashDir(options.root);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return names.length;
}
