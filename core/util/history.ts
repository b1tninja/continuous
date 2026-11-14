import * as fs from "fs";
import * as path from "path";

import { BaseSessionMetadata, Session } from "../index.js";
import { ListHistoryOptions } from "../protocol/core.js";

import { writeFileAtomicSync } from "./atomicWrite.js";
import { stripPromptsFromSessionBytes } from "./promptLogsFile.js";
import { NEW_SESSION_TITLE } from "./constants.js";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths.js";
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
  const base = file.endsWith(".json") ? file.slice(0, -".json".length) : file;
  let kept = `${base}${QUARANTINE_MARK}${Date.now()}.json`;
  for (let n = 1; fs.existsSync(kept); n++) {
    kept = `${base}${QUARANTINE_MARK}${Date.now()}-${n}.json`;
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

/**
 * Reads one session file. A file whose contents cannot be used is moved
 * aside (see quarantineSessionFile) and reported in `damaged`; a file that
 * is not there answers `undefined`; one that cannot be read at all throws
 * and is left alone.
 */
export function readSessionFile(
  file: string,
):
  { session: Session } | { damaged: SessionLoadResult["damaged"] } | undefined {
  let raw: string;
  try {
    // Prompts are dropped from the bytes before parsing: a file saved while
    // every request kept its prompt can be hundreds of MB (promptLogsFile.ts)
    raw = stripPromptsFromSessionBytes(fs.readFileSync(file)).toString("utf8");
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
  const parsed = parseSessionText(raw);
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
    const session = JSON.parse(
      stripPromptsFromSessionBytes(fs.readFileSync(file)).toString("utf8"),
    ) as Session;
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
  return fs
    .readdirSync(folder)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        name !== "sessions.json" &&
        !name.includes(".tmp") &&
        !isQuarantinedSessionFile(name),
    )
    .flatMap((name) => {
      const meta = metadataFromSessionFile(path.join(folder, name));
      return meta ? [meta] : [];
    });
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

export class HistoryManager {
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

  delete(sessionId: string) {
    // Delete a session
    const sessionFile = getSessionFilePath(sessionId);
    if (!fs.existsSync(sessionFile)) {
      throw new Error(`Session file ${sessionFile} does not exist`);
    }
    fs.unlinkSync(sessionFile);

    updateSessionsList((sessionsList) =>
      sessionsList.filter((session) => session.sessionId !== sessionId),
    );
  }

  clearAll() {
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
    const sessionFile = getSessionFilePath(sessionId);
    const empty: Session = {
      history: [],
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      sessionId: sessionId,
    };
    const read = readSessionFile(sessionFile);
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
    return { session: read.session };
  }

  save(session: Session): { fileBytes: number } {
    // The key order of the file is fixed by orderSession: id at the top,
    // history next, etc.
    const started = Date.now();
    const contents = serializeSession(session);
    const fileBytes = Buffer.byteLength(contents, "utf8");
    writeAtomic(getSessionFilePath(session.sessionId), contents);
    const elapsed = Date.now() - started;

    markSessionOpen(session.sessionId);

    // Logged once per session and process: every save of a large session
    // would repeat it
    if (
      isOverSessionBudget(fileBytes, this.budgetBytes) &&
      !this.warnedOverBudget.has(session.sessionId)
    ) {
      this.warnedOverBudget.add(session.sessionId);
      console.warn(
        sessionBudgetWarning(session.sessionId, fileBytes, this.budgetBytes),
      );
    }
    if (elapsed >= SLOW_SESSION_SAVE_MS) {
      console.warn(
        `Saving session ${session.sessionId} took ${elapsed} ms (${formatFileSize(fileBytes)})`,
      );
    }

    const messageCount = session.history.filter(
      (item) => item.message.role === "assistant",
    ).length;
    updateSessionsList((sessionsList) => {
      let found = false;
      for (const sessionMetadata of sessionsList) {
        if (sessionMetadata.sessionId === session.sessionId) {
          sessionMetadata.title = session.title;
          sessionMetadata.workspaceDirectory = session.workspaceDirectory;
          sessionMetadata.messageCount = messageCount;
          sessionMetadata.fileBytes = fileBytes;
          found = true;
          break;
        }
      }
      if (!found) {
        sessionsList.push({
          sessionId: session.sessionId,
          title: session.title,
          dateCreated: String(Date.now()),
          workspaceDirectory: session.workspaceDirectory,
          messageCount,
          fileBytes,
        });
      }
      return sessionsList;
    });
    return { fileBytes };
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

const historyManager = new HistoryManager();

export default historyManager;
