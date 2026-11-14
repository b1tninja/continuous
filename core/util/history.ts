import * as fs from "fs";
import * as path from "path";

import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";

import { writeFileAtomicSync } from "./atomicWrite.js";
import { withoutPrompts } from "./promptLogs.js";
import { stripPromptsFromSessionBytes } from "./promptLogsFile.js";
import { NEW_SESSION_TITLE } from "./constants.js";
import {
  getSessionBlobFolderPath,
  getSessionDataFolderPath,
  getSessionFilePath,
  getSessionLogFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
import {
  blobReader,
  replaySessionLog,
  type ReplayResult,
  type SessionDelta,
  sessionFromReplay,
  SessionLogWriter,
  type SessionSaveResult,
} from "./sessionLog.js";
import {
  formatFileSize,
  isOverSessionBudget,
  serializeSession,
  SESSION_FILE_BUDGET_BYTES,
  sessionBudgetWarning,
  SLOW_SESSION_SAVE_MS,
} from "./sessionFile.js";
import { markSessionOpen } from "./sessionLeases.js";
function safeParseArray<T>(
  value: string,
  errorMessage: string = "Error parsing array",
): T[] | undefined {
  try {
    return JSON.parse(value) as T[];
  } catch (e: any) {
    console.warn(`${errorMessage}: ${e}`);
    return undefined;
  }
}

/** Session files are private to the person: 0600 when first written. */
function writeAtomic(file: string, contents: string): void {
  writeFileAtomicSync(file, contents, { mode: 0o600, fallbackInPlace: false });
}

const QUARANTINE_MARK = ".corrupt-";

/** True for a damaged session file that was set aside (`<id>.corrupt-<time>.json`). */
export function isQuarantinedSessionFile(name: string): boolean {
  return path.basename(name).includes(QUARANTINE_MARK);
}

/**
 * Moves a damaged session file aside as `<id>.corrupt-<time>.json` in the
 * same folder and returns the new path. The bytes are kept so they can be
 * repaired by hand; nothing later writes to that name. Throws when the file
 * can be neither renamed nor copied.
 */
export function quarantineSessionFile(file: string): string {
  const ext = file.endsWith(".jsonl") ? ".jsonl" : ".json";
  const base = file.endsWith(ext) ? file.slice(0, -ext.length) : file;
  let kept = `${base}${QUARANTINE_MARK}${Date.now()}${ext}`;
  for (let n = 1; fs.existsSync(kept); n++) {
    kept = `${base}${QUARANTINE_MARK}${Date.now()}-${n}${ext}`;
  }
  try {
    fs.renameSync(file, kept);
  } catch {
    // Windows refuses to rename a file that is open elsewhere; a copy keeps
    // the bytes just as well.
    fs.copyFileSync(file, kept, fs.constants.COPYFILE_EXCL);
  }
  return kept;
}

/** What `loadWithStatus` found. */
export interface SessionLoadResult {
  session: Session;
  /**
   * Set when the session file existed and could not be used. `keptAt` is
   * where its bytes are now; `reason` never holds file contents.
   */
  damaged?: { keptAt: string; reason: string };
}

/** One sentence for the person about a damaged session file. */
export function damagedSessionNotice(damaged: {
  keptAt: string;
  reason: string;
}): string {
  return `This session's file is damaged and was not loaded (${damaged.reason}). It is kept at ${damaged.keptAt}.`;
}

/** Why a session file cannot be used, without quoting it. */
function parseSessionText(
  raw: string,
): { session: Session } | { reason: string } {
  if (raw.trim() === "") return { reason: "the file is empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message quotes the text around the error; a session
    // holds the conversation, so only the fact is reported.
    return { reason: "it is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "it does not hold a session" };
  }
  return { session: parsed as Session };
}

/** True for a session file name in either format (not the list, not a temp file). */
export function isSessionFileName(name: string): boolean {
  const base = path.basename(name);
  return (
    (base.endsWith(".json") || base.endsWith(".jsonl")) &&
    base !== "sessions.json" &&
    !base.includes(".tmp") &&
    !isQuarantinedSessionFile(base)
  );
}

/** A session's blob folder, from the path of its `.jsonl` file. */
function blobDirOfLog(file: string): string {
  return path.join(path.dirname(file), path.basename(file, ".jsonl"), "blobs");
}

/** What was read from a `.jsonl` session, for the writer to continue from. */
export interface SessionLogRead {
  replay: ReplayResult;
  /** Blobs referred to that are not stored. */
  missingBlobs: number;
}

/** Text of a session log plus what this process has queued for it. */
type LogOverlay = ReturnType<SessionLogWriter["overlay"]>;

function replayWithOverlay(
  raw: string,
  overlay: LogOverlay,
): ReturnType<typeof replaySessionLog> {
  if (!overlay) return replaySessionLog(raw);
  let base = overlay.replaceText ?? raw;
  if (
    overlay.replaceText === undefined &&
    overlay.inflightStart !== undefined &&
    overlay.inflightText !== undefined &&
    Buffer.byteLength(raw, "utf8") <
      overlay.inflightStart + Buffer.byteLength(overlay.inflightText, "utf8")
  ) {
    base =
      Buffer.from(raw, "utf8")
        .subarray(0, overlay.inflightStart)
        .toString("utf8") + overlay.inflightText;
  }
  return replaySessionLog(base + overlay.pendingText);
}

function parseSessionLog(
  raw: string,
  file: string,
  overlay?: LogOverlay,
): { session: Session; log: SessionLogRead } | { reason: string } {
  const replay = replayWithOverlay(raw, overlay);
  if ("reason" in replay) return replay;
  const missing = new Set<string>();
  const session = sessionFromReplay(
    replay,
    blobReader(blobDirOfLog(file), overlay?.blobs),
    { missing },
  );
  return { session, log: { replay, missingBlobs: missing.size } };
}

/**
 * Reads one session file, `.json` or `.jsonl`. A file whose contents cannot
 * be used is moved aside (see quarantineSessionFile) and reported in
 * `damaged`; a file that is not there answers `undefined`; one that cannot
 * be read at all throws and is left alone. A `.jsonl` whose last line was
 * cut short is read without it.
 */
export function readSessionFile(
  file: string,
  overlay?: LogOverlay,
):
  | { session: Session; log?: SessionLogRead }
  | { damaged: SessionLoadResult["damaged"] }
  | undefined {
  let raw: string;
  try {
    // Prompts are dropped from the bytes before parsing: a file saved while
    // every request kept its prompt can be hundreds of MB (promptLogsFile.ts)
    // A .jsonl is read as written: its writer keeps no prompts, and the
    // appender continues at the byte offset the replay ends at
    raw = file.endsWith(".jsonl")
      ? fs.readFileSync(file, "utf8")
      : stripPromptsFromSessionBytes(fs.readFileSync(file)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Not readable right now (permissions, a lock, too many open files) is
    // not the same as damaged: the file is left where it is, and not opened
    // as an empty session that the next save would write over it.
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    throw new Error(
      `Session file ${file} could not be read (${code}). It was not opened, so that it is not overwritten.`,
    );
  }
  const parsed = file.endsWith(".jsonl")
    ? parseSessionLog(raw, file, overlay)
    : parseSessionText(raw);
  if ("session" in parsed) return parsed;
  return {
    damaged: { keptAt: quarantineOrThrow(file), reason: parsed.reason },
  };
}

function quarantineOrThrow(file: string): string {
  try {
    return quarantineSessionFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    // Opening it as an empty session would let the next save replace it.
    throw new Error(
      `Session file ${file} is damaged and could not be set aside (${code}). It was not opened, so that it is not overwritten.`,
    );
  }
}

const SESSIONS_LOCK_WAIT_MS = 5_000;
const STALE_SESSIONS_LOCK_MS = 10_000;

function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/** One process at a time updates sessions.json. A lock older than 10s is stale. */
function withSessionsLock<T>(fn: () => T): T {
  const lockPath = `${getSessionsListPath()}.lock`;
  const deadline = Date.now() + SESSIONS_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // a waiter may have cleared a stale lock already
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        if (
          Date.now() - fs.statSync(lockPath).mtimeMs >
          STALE_SESSIONS_LOCK_MS
        ) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // the holder released the lock between the stat and the unlink
      }
      if (Date.now() > deadline) {
        throw new Error(`Could not lock the session list at ${lockPath}`);
      }
      sleepSync(25);
    }
  }
}

function metadataFromSessionFile(
  file: string,
): BaseSessionMetadata | undefined {
  try {
    let session: Session;
    if (file.endsWith(".jsonl")) {
      // Titles and counts only: blobs are not read
      const replay = replaySessionLog(fs.readFileSync(file, "utf8"));
      if ("reason" in replay) return undefined;
      session = sessionFromReplay(replay, () => "");
    } else {
      session = JSON.parse(
        stripPromptsFromSessionBytes(fs.readFileSync(file)).toString("utf8"),
      ) as Session;
    }
    if (!session || typeof session !== "object" || !session.sessionId) {
      return undefined;
    }
    const messageCount = Array.isArray(session.history)
      ? session.history.filter((item) => item?.message?.role === "assistant")
          .length
      : 0;
    return {
      sessionId: session.sessionId,
      title: session.title ?? "",
      dateCreated: String(fs.statSync(file).mtimeMs),
      workspaceDirectory: session.workspaceDirectory ?? "",
      messageCount,
    };
  } catch {
    return undefined;
  }
}

/** Rebuild the list from the session files when sessions.json cannot be read. */
function rebuildSessionsList(): BaseSessionMetadata[] {
  const folder = getSessionsFolderPath();
  const names = fs.readdirSync(folder).filter(isSessionFileName);
  const logs = new Set(names.filter((n) => n.endsWith(".jsonl")));
  return (
    names
      // A .json beside its .jsonl is a migration that did not finish removing it
      .filter((name) => !(name.endsWith(".json") && logs.has(`${name}l`)))
      .flatMap((name) => {
        const meta = metadataFromSessionFile(path.join(folder, name));
        return meta ? [meta] : [];
      })
  );
}

/**
 * The session list, or a list rebuilt from the session files when the file
 * is empty or not valid JSON. A bad file is renamed aside so the next save
 * can write a fresh one.
 */
function readSessionsList(file: string): BaseSessionMetadata[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new SyntaxError("sessions.json is not a list");
    }
    return parsed as BaseSessionMetadata[];
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
    } catch {
      // still rebuild; the bad file may be replaced by the next write
    }
    console.warn(
      `sessions.json could not be read (${error instanceof Error ? error.message : String(error)}). It was backed up and the list was rebuilt from the session files.`,
    );
    return rebuildSessionsList();
  }
}

function updateSessionsList(
  update: (list: BaseSessionMetadata[]) => BaseSessionMetadata[],
): void {
  const file = getSessionsListPath();
  withSessionsLock(() => {
    const next = update(readSessionsList(file));
    writeAtomic(file, JSON.stringify(next, undefined, 2));
  });
}

const writersToFlushOnExit = new Set<SessionLogWriter>();

/** One exit hook per process writes what every writer still has queued. */
function flushOnExit(writer: SessionLogWriter): void {
  if (writersToFlushOnExit.size === 0) {
    process.once("exit", () => {
      for (const w of writersToFlushOnExit) w.flushAllSync();
    });
  }
  writersToFlushOnExit.add(writer);
}

export class HistoryManager {
  private log = new SessionLogWriter({
    logFile: getSessionLogFilePath,
    jsonFile: getSessionFilePath,
    blobDir: getSessionBlobFolderPath,
  });
  private useLog = false;
  private readonly warnedOverBudget = new Set<string>();

  /** `budgetBytes`: when a save logs that the file is too large. */
  constructor(
    private readonly budgetBytes: number = SESSION_FILE_BUDGET_BYTES,
  ) {}

  list(options: ListHistoryOptions): BaseSessionMetadata[] {
    const filepath = getSessionsListPath();
    if (!fs.existsSync(filepath)) {
      return [];
    }
    const content = fs.readFileSync(filepath, "utf8");

    let sessions = safeParseArray<BaseSessionMetadata>(content) ?? [];
    sessions = sessions
      .filter((session: any) => {
        // Filter out old format
        return typeof session.session_id !== "string";
        // Reverse to show newest first; sessions.json is chronological by creation
      })
      .reverse();

    // Filter by workspace directory if provided
    if (options.workspaceDirectory) {
      const target = options.workspaceDirectory.toLowerCase();
      sessions = sessions.filter(
        (session) =>
          typeof session.workspaceDirectory === "string" &&
          session.workspaceDirectory.toLowerCase() === target,
      );
    }

    // Apply limit and offset
    if (options.limit) {
      const offset = options.offset || 0;
      sessions = sessions.slice(offset, offset + options.limit);
    }

    return sessions;
  }

  /**
   * Save new and changed sessions as an append-only `.jsonl` log with large
   * strings as blobs (STOR6/STOR7) instead of rewriting a `.json` file. Off
   * by default here, so the CLI keeps writing `.json`; the IDE turns it on
   * from the `sessionLogStorage` setting. Either way both formats are read.
   */
  setSessionLog(enabled: boolean): void {
    this.useLog = enabled;
    if (enabled) flushOnExit(this.log);
  }

  get sessionLogEnabled(): boolean {
    return this.useLog;
  }

  /** Counters of the log writer, for tests and measurement. */
  get sessionLogStats() {
    return this.log.stats;
  }

  /** Resolves when queued session writes (of one session, or all) are on disk. */
  flush(sessionId?: string): Promise<void> {
    return this.log.flush(sessionId);
  }

  delete(sessionId: string) {
    const jsonFile = getSessionFilePath(sessionId);
    const logFile = getSessionLogFilePath(sessionId);
    if (!fs.existsSync(jsonFile) && !fs.existsSync(logFile)) {
      throw new Error(`Session file ${jsonFile} does not exist`);
    }
    this.log.drop(sessionId);
    fs.rmSync(jsonFile, { force: true });
    fs.rmSync(logFile, { force: true });
    fs.rmSync(getSessionDataFolderPath(sessionId), {
      recursive: true,
      force: true,
    });

    updateSessionsList((sessionsList) =>
      sessionsList.filter((session) => session.sessionId !== sessionId),
    );
  }

  clearAll() {
    this.log.dropAll();
    fs.rmSync(getSessionsFolderPath(), { recursive: true, force: true });
  }

  /**
   * The session, or an empty one under the same id when there is no file or
   * the file is damaged. A damaged file is moved aside first, so a later
   * save under this id replaces nothing. Throws when the file cannot be
   * read, or is damaged and cannot be moved aside. Use `loadWithStatus` to tell the person about it.
   */
  load(sessionId: string): Session {
    const result = this.loadWithStatus(sessionId);
    if (result.damaged) console.warn(damagedSessionNotice(result.damaged));
    return result.session;
  }

  loadWithStatus(sessionId: string): SessionLoadResult {
    const logFile = getSessionLogFilePath(sessionId);
    const overlay = this.log.overlay(sessionId);
    const useLogFile = !!overlay || fs.existsSync(logFile);
    const sessionFile = useLogFile ? logFile : getSessionFilePath(sessionId);
    const empty: Session = {
      history: [],
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      sessionId: sessionId,
    };
    let read: ReturnType<typeof readSessionFile>;
    if (overlay && !fs.existsSync(logFile)) {
      // Its first write (a new or migrated session) is still queued
      const parsed = parseSessionLog("", logFile, overlay);
      read = "session" in parsed ? parsed : undefined;
    } else {
      read = readSessionFile(sessionFile, overlay);
    }
    if (!read) {
      console.log(
        `Error loading session: Session file ${sessionFile} does not exist`,
      );
      return { session: empty };
    }
    if ("damaged" in read) return { session: empty, damaged: read.damaged };
    read.session.sessionId = sessionId;
    // A cleanup run in another process leaves an open session alone
    markSessionOpen(sessionId);
    if (read.log && !overlay) this.continueLog(sessionId, logFile, read.log);
    return { session: read.session };
  }

  /** After reading a `.jsonl`: drop a cut-off last line and let saves append. */
  private continueLog(
    sessionId: string,
    file: string,
    log: SessionLogRead,
  ): void {
    const { replay } = log;
    if (replay.torn) {
      try {
        // The cut-off line is not a change anyone saw saved; the next append
        // starts on a line of its own
        fs.truncateSync(file, replay.validBytes);
      } catch {
        return; // left as it is; the next save writes it whole
      }
    }
    if (log.missingBlobs) {
      console.warn(
        `Session ${sessionId}: ${log.missingBlobs} stored output(s) are missing and were replaced by a marker.`,
      );
    }
    if (this.useLog) {
      const decoded = sessionFromReplay(
        replay,
        blobReader(blobDirOfLog(file)),
      ).history;
      this.log.adopt(sessionId, replay, decoded);
    }
  }

  /**
   * Saves the whole session. With the session log on, only what changed
   * since the last save in this process is appended (a `.json` is migrated
   * on its first save); with it off, the `.json` is rewritten (and a `.jsonl`
   * of the same session is replaced by it). Answers the revision a
   * `saveDelta` can continue from, or null when deltas cannot be used.
   */
  save(full: Session): SessionSaveResult & { fileBytes?: number } {
    // No prompt is written: each repeats the conversation before it, so
    // keeping them made the file grow with the square of its length
    const session = { ...full, history: withoutPrompts(full.history) };
    if (this.useLog && !this.log.isJsonFallback(session.sessionId)) {
      const result = this.log.saveFull(session);
      if (result.rev !== null) {
        this.updateListEntry(session.sessionId, {
          title: session.title,
          workspaceDirectory: session.workspaceDirectory,
          messageCount: session.history.filter(
            (item) => item.message.role === "assistant",
          ).length,
        });
        return result;
      }
    }
    const fileBytes = this.saveJson(session);
    return { rev: null, fileBytes };
  }

  /**
   * Saves the items and fields the webview changed since its last save.
   * Answers needFull when this process cannot apply it (the log is off, it
   * restarted, another save came in between, or the file changed under it):
   * the webview then sends the whole session with `save`.
   */
  saveDelta(delta: SessionDelta): SessionSaveResult {
    if (!this.useLog) return { rev: null, needFull: true };
    const before = this.log.listEntry(delta.sessionId);
    const result = this.log.saveDelta({
      ...delta,
      items: delta.items.map(({ index, item }) => ({
        index,
        item: withoutPrompts([item])[0],
      })),
    });
    if (result.needFull) return result;
    this.updateListEntry(delta.sessionId, {
      title: delta.meta.title ?? before?.title ?? "",
      workspaceDirectory:
        delta.meta.workspaceDirectory ?? before?.workspaceDirectory ?? "",
      messageCount: this.log.messageCount(delta.sessionId),
    });
    return result;
  }

  /** sessions.json, rewritten only when what it shows of the session changed. */
  private updateListEntry(
    sessionId: string,
    entry: { title: string; workspaceDirectory: string; messageCount: number },
  ): void {
    const last = this.log.listEntry(sessionId);
    if (
      last &&
      last.title === entry.title &&
      last.workspaceDirectory === entry.workspaceDirectory &&
      last.messageCount === entry.messageCount
    ) {
      return;
    }
    writeSessionsListEntry(sessionId, entry);
    this.log.setListed(sessionId, entry);
  }

  /** Writes the session as `.json`; answers the bytes written. */
  private saveJson(session: Session): number {
    // The key order of the file is fixed by orderSession: id at the top,
    // history next, etc.
    const started = Date.now();
    const contents = serializeSession(session);
    const fileBytes = Buffer.byteLength(contents, "utf8");
    writeAtomic(getSessionFilePath(session.sessionId), contents);
    const elapsed = Date.now() - started;

    markSessionOpen(session.sessionId);
    this.warnIfLarge(session.sessionId, fileBytes, elapsed);

    // The .json is now the newer copy: a .jsonl of the same session (the
    // log was turned off) would shadow it. A session whose migration check
    // failed keeps its state, so it is not tried again in this process.
    if (!this.log.isJsonFallback(session.sessionId)) {
      this.log.drop(session.sessionId);
    }
    const logFile = getSessionLogFilePath(session.sessionId);
    if (fs.existsSync(logFile)) {
      fs.rmSync(logFile, { force: true });
      fs.rmSync(getSessionBlobFolderPath(session.sessionId), {
        recursive: true,
        force: true,
      });
    }

    const messageCount = session.history.filter(
      (item) => item.message.role === "assistant",
    ).length;
    writeSessionsListEntry(session.sessionId, {
      title: session.title,
      workspaceDirectory: session.workspaceDirectory,
      messageCount,
      fileBytes,
    });
    return fileBytes;
  }

  /** Logged once per session and process: every save of a large session would repeat it. */
  private warnIfLarge(
    sessionId: string,
    fileBytes: number,
    elapsed: number,
  ): void {
    if (
      isOverSessionBudget(fileBytes, this.budgetBytes) &&
      !this.warnedOverBudget.has(sessionId)
    ) {
      this.warnedOverBudget.add(sessionId);
      console.warn(
        sessionBudgetWarning(sessionId, fileBytes, this.budgetBytes),
      );
    }
    if (elapsed >= SLOW_SESSION_SAVE_MS) {
      console.warn(
        `Saving session ${sessionId} took ${elapsed} ms (${formatFileSize(fileBytes)})`,
      );
    }
  }

  /**
   * Fills in `fileBytes` for listed sessions saved before it was recorded,
   * from the file itself. Call it on a page of the list, not all of it.
   */
  withFileSizes(sessions: BaseSessionMetadata[]): BaseSessionMetadata[] {
    return sessions.map((session) => {
      if (session.fileBytes !== undefined) return session;
      try {
        const { size } = fs.statSync(getSessionFilePath(session.sessionId));
        return { ...session, fileBytes: size };
      } catch {
        return session;
      }
    });
  }
}

function writeSessionsListEntry(
  sessionId: string,
  entry: {
    title: string;
    workspaceDirectory: string;
    messageCount: number;
    fileBytes?: number;
  },
): void {
  updateSessionsList((sessionsList) => {
    let found = false;
    for (const sessionMetadata of sessionsList) {
      if (sessionMetadata.sessionId === sessionId) {
        sessionMetadata.title = entry.title;
        sessionMetadata.workspaceDirectory = entry.workspaceDirectory;
        sessionMetadata.messageCount = entry.messageCount;
        if (entry.fileBytes !== undefined) {
          sessionMetadata.fileBytes = entry.fileBytes;
        }
        found = true;
        break;
      }
    }
    if (!found) {
      sessionsList.push({
        sessionId,
        title: entry.title,
        dateCreated: String(Date.now()),
        workspaceDirectory: entry.workspaceDirectory,
        messageCount: entry.messageCount,
        ...(entry.fileBytes !== undefined && { fileBytes: entry.fileBytes }),
      });
    }
    return sessionsList;
  });
}

const historyManager = new HistoryManager();

export default historyManager;
