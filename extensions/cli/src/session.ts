/* eslint-disable max-lines */
import fs from "fs";
import os from "os";
import path from "path";

import type {
  BaseSessionMetadata,
  ChatHistoryItem,
  LoopState,
  Session,
  SessionUsage,
  TaskPlan,
  Usage,
} from "core/index.js";
import { totalInputTokens } from "core/llm/utils/cacheStats.js";
import type { CostBreakdown } from "core/llm/utils/calculateRequestCost.js";
import { addRequestUsage } from "core/llm/utils/sessionUsage.js";
import { forkSession } from "core/util/forkSession.js";
import historyManager, {
  damagedSessionNotice,
  isSessionFileName,
  readSessionFile,
  type TrashSessionResult,
} from "core/util/history.js";
import { restoreLoop } from "core/util/loopMode.js";
import {
  groupSessionsByWorkspace,
  isCaseInsensitivePlatform,
  sessionMatchesWorkspace,
  type WorkspaceMatchOptions,
} from "core/util/sessionWorkspace.js";
import { v4 as uuidv4 } from "uuid";

import { DEFAULT_SESSION_TITLE } from "./constants/session.js";
import { env } from "./env.js";
import { logger } from "./util/logger.js";
import { userNotice } from "./util/userNotice.js";

/** How a request was priced, for `trackUsage`. */
export interface TrackHow {
  /** Priced at the fallback rate: the session total becomes an estimate */
  estimated?: boolean;
  /** The price used, so the per-model price source matches the total */
  pricedAs?: CostBreakdown | null;
}

// Re-export BaseSessionMetadata for external consumers
export type { BaseSessionMetadata };

// Extended type for sessions that can be local or remote
export interface ExtendedSessionMetadata extends BaseSessionMetadata {
  firstUserMessage?: string;
  isRemote?: boolean;
  remoteId?: string; // For remote sessions, this is the agent ID
  /** When the session file was last written (ISO): the "newest" order */
  lastModified?: string;
  /** Saved in the folder the CLI runs in, or its repository (core/util/sessionWorkspace.ts) */
  inWorkspace?: boolean;
  /** Header of the workspace group the session is listed under */
  workspaceGroup?: string;
  /** Full path of that group's folder ("" for sessions without one) */
  workspaceGroupPath?: string;
}

// Note: We now use UUID-based session IDs instead of terminal-based IDs.
// Each new chat session gets a unique UUID.
// --resume continues the newest session of the folder the CLI runs in (in a
// terminal, after the picker of commands/resumePicker.ts), or the session
// given by id.

/**
 * Get the session storage directory
 */
function getSessionDir(): string {
  // For tests, use the test directory if we're in test mode
  if (process.env.CONTINUE_CLI_TEST && process.env.HOME) {
    const sessionDir = path.join(process.env.HOME, ".continue", "sessions");

    // Create directory if it doesn't exist
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    return sessionDir;
  }

  // ~/.continuous, or CONTINUOUS_GLOBAL_DIR / CONTINUE_GLOBAL_DIR
  const sessionDir = path.join(env.continueHome, "sessions");

  // Create directory if it doesn't exist
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  return sessionDir;
}

/**
 * Get the session file path for the current session
 */
export function getSessionFilePath(): string {
  const sessionId = getCurrentSessionId();
  const sessionDir = getSessionDir();
  return path.join(sessionDir, `${sessionId}.json`);
}

// Singleton for current session management
class SessionManager {
  private static instance: SessionManager;
  private currentSession: Session | null = null;
  private sessionUsage: SessionUsage = {
    totalCost: 0,
    promptTokens: 0,
    completionTokens: 0,
    promptTokensDetails: {
      cachedTokens: 0,
      cacheWriteTokens: 0,
    },
    byModel: {},
  };

  private constructor() {}

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  getCurrentSession(): Session {
    if (!this.currentSession) {
      // Use test session ID for testing consistency
      const sessionId = process.env.CONTINUE_CLI_TEST_SESSION_ID
        ? process.env.CONTINUE_CLI_TEST_SESSION_ID
        : uuidv4();

      this.currentSession = {
        sessionId,
        title: DEFAULT_SESSION_TITLE,
        workspaceDirectory: process.cwd(),
        history: [],
        usage: { ...this.sessionUsage },
      };
    }
    return this.currentSession;
  }

  setSession(session: Session): void {
    // A loop saved mid-run comes back stopped, so a resumed session never
    // starts work by itself (core/util/loopMode.ts restoreLoop).
    if (session.loop !== undefined) {
      const loop = restoreLoop(session.loop);
      if (loop) {
        session.loop = loop;
      } else {
        delete session.loop;
      }
    }
    this.currentSession = session;
    this.syncUsageFromSession();
    notifyTaskPlanListeners(session.taskPlan);
    notifyLoopListeners(session.loop);
  }

  updateHistory(history: ChatHistoryItem[]): void {
    const session = this.getCurrentSession();
    session.history = history;
    saveSession();
  }

  updateTitle(title: string): void {
    const session = this.getCurrentSession();
    session.title = title;
    saveSession();
  }

  updateTaskPlan(plan: TaskPlan | undefined): void {
    const session = this.getCurrentSession();
    if (plan?.items.length) {
      session.taskPlan = plan;
    } else {
      delete session.taskPlan;
    }
    saveSession();
    notifyTaskPlanListeners(session.taskPlan);
  }

  updateLoop(loop: LoopState | undefined): void {
    const session = this.getCurrentSession();
    if (loop) {
      session.loop = loop;
    } else {
      delete session.loop;
    }
    saveSession();
    notifyLoopListeners(session.loop);
  }

  updatePlanFile(planFile: string | undefined): void {
    const session = this.getCurrentSession();
    if (planFile) {
      session.planFile = planFile;
    } else {
      delete session.planFile;
    }
    saveSession();
  }

  clear(): void {
    this.currentSession = null;
    notifyTaskPlanListeners(undefined);
    notifyLoopListeners(undefined);
    this.sessionUsage = {
      totalCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: {
        cachedTokens: 0,
        cacheWriteTokens: 0,
      },
    };
  }

  hasSession(): boolean {
    return this.currentSession !== null;
  }

  getSessionId(): string {
    return this.getCurrentSession().sessionId;
  }

  /**
   * Add one request. `promptTokens` in the session totals is the input the
   * provider processed: uncached input plus cache reads plus cache writes
   * (`totalInputTokens`), whatever the provider's own count leaves out. A
   * Bedrock request whose whole prompt was a cache write reports
   * `inputTokens` 0 and still counts its write here. Without a provider the
   * provider's count is taken as the whole input. `estimated` marks a cost
   * priced at the fallback rate (no price table for the model): the session
   * total is then an estimate and is shown as one.
   */
  trackUsage(
    cost: number,
    usage: Usage,
    provider?: string,
    model?: string,
    /**
     * `true` (or `estimated`): priced at the fallback rate. `pricedAs`: the
     * price the caller used, so the per-model source matches the total.
     */
    how: boolean | TrackHow = false,
  ): void {
    const { estimated = false, pricedAs } =
      typeof how === "boolean" ? { estimated: how } : how;
    // Accumulate cost
    this.sessionUsage.totalCost += cost;
    if (estimated) {
      this.sessionUsage.costEstimated = true;
    }

    // Per-model totals by kind, for the loop's cost counter. Usage that
    // names no model (a worker's or a wave's) is kept under "unattributed",
    // which has no price, so the counter says unknown instead of undercounting
    this.sessionUsage.byModel = addRequestUsage(
      { ...this.sessionUsage, totalCost: 0 },
      provider ?? "unattributed",
      model ?? "unattributed",
      usage,
      pricedAs,
    ).byModel;

    // Accumulate token counts
    const processedInput =
      provider && model
        ? totalInputTokens(provider, model, usage)
        : usage.promptTokens;
    this.sessionUsage.promptTokens += processedInput;
    this.sessionUsage.completionTokens += usage.completionTokens;

    // Accumulate cache tokens if present
    if (usage.promptTokensDetails?.cachedTokens) {
      this.sessionUsage.promptTokensDetails =
        this.sessionUsage.promptTokensDetails || {};
      this.sessionUsage.promptTokensDetails.cachedTokens =
        (this.sessionUsage.promptTokensDetails.cachedTokens || 0) +
        usage.promptTokensDetails.cachedTokens;
    }

    if (usage.promptTokensDetails?.cacheWriteTokens) {
      this.sessionUsage.promptTokensDetails =
        this.sessionUsage.promptTokensDetails || {};
      this.sessionUsage.promptTokensDetails.cacheWriteTokens =
        (this.sessionUsage.promptTokensDetails.cacheWriteTokens || 0) +
        usage.promptTokensDetails.cacheWriteTokens;
    }

    // Update session and persist
    const session = this.getCurrentSession();
    session.usage = { ...this.sessionUsage };
    saveSession(); // Persist immediately
  }

  getTotalCost(): number {
    return this.sessionUsage.totalCost;
  }

  getUsage(): SessionUsage {
    return { ...this.sessionUsage };
  }

  private syncUsageFromSession(): void {
    const session = this.currentSession;
    if (session?.usage) {
      this.sessionUsage = { ...session.usage };
    } else {
      // Migrate old sessions that only had totalCost
      this.sessionUsage = {
        totalCost: 0,
        promptTokens: 0,
        completionTokens: 0,
        promptTokensDetails: {
          cachedTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    }
  }
}

function getCurrentSessionId(): string {
  return SessionManager.getInstance().getSessionId();
}

function modifySessionBeforeSave(session: Session): Session {
  const filteredHistory = session.history.filter((item) => {
    return item.message.role !== "system";
  });

  const modifiedHistory = filteredHistory.map((item) => {
    if (item.message.role === "user") {
      return {
        ...item,
        editorState: item.message.content,
      };
    }

    return item;
  });

  return {
    ...session,
    history: modifiedHistory,
  };
}

export function getSessionPersistenceSnapshot(session: Session): Session {
  return modifySessionBeforeSave(session);
}

/**
 * Get the complete state snapshot that matches the /state endpoint format
 */
export interface StateSnapshot {
  session: Session;
  isProcessing: boolean;
  messageQueueLength: number;
  pendingPermission: any;
}

export function getCompleteStateSnapshot(
  session: Session,
  isProcessing: boolean = false,
  messageQueueLength: number = 0,
  pendingPermission: any = null,
): StateSnapshot {
  return {
    session: getSessionPersistenceSnapshot(session),
    isProcessing,
    messageQueueLength,
    pendingPermission,
  };
}

/**
 * Check if a session has meaningful content for saving
 */
function hasSessionContent(session: Session): boolean {
  if (!session.history || session.history.length === 0) {
    return false;
  }

  const nonSystemMessages = session.history.filter(
    (item) => item.message.role !== "system",
  );

  return nonSystemMessages.length > 0;
}

/**
 * Save the current session to file
 */
export function saveSession(): void {
  let sessionId = "";
  try {
    const manager = SessionManager.getInstance();
    if (!manager.hasSession()) {
      return;
    }

    const session = manager.getCurrentSession();
    if (!hasSessionContent(session)) {
      return;
    }
    sessionId = session.sessionId;

    const sessionToSave = getSessionPersistenceSnapshot(session);
    historyManager.save(sessionToSave);
  } catch (error) {
    logger.error("Error saving session:", error);
    // A full disk or a folder that cannot be written fails on every
    // message: say it once for this session, where the person will see it.
    userNotice(sessionNotSavedNotice(error), `session-not-saved:${sessionId}`);
  }
}

/** The line shown once when a session cannot be written. */
export function sessionNotSavedNotice(error: unknown): string {
  const folder = path.join(env.continueHome, "sessions");
  const reason = error instanceof Error ? error.message : String(error);
  return `This session is not being saved (${folder}): ${reason}. The conversation continues in memory and is saved again as soon as a write succeeds.`;
}

const gitRootCache = new Map<string, string | undefined>();

/**
 * The folder holding `.git` (a directory, or the file of a worktree) at or
 * above `dir`; `undefined` outside a repository. Walks the file system
 * instead of running git, so ordering many sessions stays cheap.
 */
export function findGitRoot(dir: string): string | undefined {
  if (!dir || URI_PATTERN.test(dir)) return undefined;
  const start = path.resolve(dir);
  if (gitRootCache.has(start)) return gitRootCache.get(start);
  let found: string | undefined;
  let current = start;
  for (;;) {
    try {
      if (fs.existsSync(path.join(current, ".git"))) {
        found = current;
        break;
      }
    } catch {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  gitRootCache.set(start, found);
  return found;
}

const URI_PATTERN = /^[a-z][a-z0-9+.-]+:\/\//i;

/** How this machine compares a session's folder with the one the CLI runs in. */
export function workspaceMatchOptions(): WorkspaceMatchOptions {
  return {
    caseInsensitive: isCaseInsensitivePlatform(process.platform),
    homeDir: os.homedir(),
    gitRootOf: findGitRoot,
  };
}

/** A relative path resolved; URIs (sessions saved by the IDE) as they are. */
function resolveSessionDir(dir: string): string {
  return URI_PATTERN.test(dir) ? dir : path.resolve(dir);
}

/** Whether a session saved in `sessionDir` belongs to `cwd` (or its repository). */
export function isSessionInWorkspace(
  sessionDir: string | undefined,
  cwd: string = process.cwd(),
): boolean {
  if (!sessionDir) return false;
  return sessionMatchesWorkspace(
    resolveSessionDir(sessionDir),
    [path.resolve(cwd)],
    workspaceMatchOptions(),
  );
}

function sessionTime(session: ExtendedSessionMetadata): number {
  const when = session.lastModified ?? session.dateCreated;
  const parsed = Date.parse(when);
  return Number.isNaN(parsed) ? Number(when) || 0 : parsed;
}

/**
 * Sessions in the order `continuous ls` and the `--resume` picker show them
 * (core/util/sessionWorkspace.ts): the sessions of the folder the CLI runs
 * in first, newest at the top, then each other folder by its newest session,
 * then sessions without a folder. Each is marked with its group.
 */
export function orderSessionsForWorkspace(
  sessions: ExtendedSessionMetadata[],
  cwd: string = process.cwd(),
): ExtendedSessionMetadata[] {
  const groups = groupSessionsByWorkspace(sessions, {
    ...workspaceMatchOptions(),
    workspaceDirs: [path.resolve(cwd)],
    getDirectory: (s) =>
      s.workspaceDirectory ? resolveSessionDir(s.workspaceDirectory) : "",
    getTime: sessionTime,
  });
  return groups.flatMap((group) =>
    group.sessions.map((session) => ({
      ...session,
      inWorkspace: group.isCurrent,
      workspaceGroup: group.label,
      workspaceGroupPath: group.path,
    })),
  );
}

/** `listSessions` in workspace order (`orderSessionsForWorkspace`). */
export async function listSessionsForWorkspace(
  limit: number = 100,
  cwd: string = process.cwd(),
): Promise<ExtendedSessionMetadata[]> {
  return orderSessionsForWorkspace(await listSessions(limit), cwd);
}

/**
 * The session the next `loadSession` resumes, chosen by id (`--resume <id>`,
 * the `--resume` picker, `continuous ls`).
 */
let resumeSessionId: string | undefined;

export function setResumeSessionId(sessionId: string | undefined): void {
  resumeSessionId = sessionId;
}

export function getResumeSessionId(): string | undefined {
  return resumeSessionId;
}

/** Whether a session with this id is saved (as .json, or the IDE's .jsonl). */
export function sessionExists(sessionId: string): boolean {
  if (!sessionId || /[\\/]/.test(sessionId)) return false;
  const dir = getSessionDir();
  return (
    fs.existsSync(path.join(dir, `${sessionId}.json`)) ||
    fs.existsSync(path.join(dir, `${sessionId}.jsonl`))
  );
}

export interface LoadSessionOptions {
  /** The folder whose sessions come first; `process.cwd()` by default */
  cwd?: string;
}

/**
 * The session `--resume` continues:
 * - the one chosen by id (`setResumeSessionId`), when there is one;
 * - otherwise the newest session saved in this folder, a folder inside or
 *   around it, or another folder of the same repository
 *   (`isSessionInWorkspace`);
 * - otherwise the newest session of any folder, with a notice naming the
 *   folder it came from.
 * A damaged file is set aside and the next one is tried, with a notice.
 */
export function loadSession(options: LoadSessionOptions = {}): Session | null {
  // Kept after use: the TUI may ask again while it starts, and must get the
  // same session
  const chosen = resumeSessionId;
  if (chosen) {
    const session = loadSessionById(chosen);
    if (session) SessionManager.getInstance().setSession(session);
    return session;
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  try {
    const sessionDir = getSessionDir();
    if (!fs.existsSync(sessionDir)) {
      return null;
    }

    const files = fs
      .readdirSync(sessionDir)
      // .json, or the IDE's .jsonl log (read here; the CLI saves .json)
      .filter(isSessionFileName)
      .map((f) => ({
        id: f.replace(/\.jsonl?$/, ""),
        path: path.join(sessionDir, f),
        mtime: fs.statSync(path.join(sessionDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    // The folder of each session from sessions.json, so a session of another
    // folder is passed over without reading its file
    const listedDirs = new Map<string, string>();
    try {
      for (const meta of historyManager.list({})) {
        if (meta.workspaceDirectory) {
          listedDirs.set(meta.sessionId, meta.workspaceDirectory);
        }
      }
    } catch (error) {
      logger.debug("sessions.json could not be read for --resume", error);
    }

    type SessionFile = (typeof files)[number];
    type Read = ReturnType<typeof readSessionFile> | { failed: true };
    const reads = new Map<string, Read>();
    const read = (file: SessionFile): Read => {
      if (reads.has(file.path)) return reads.get(file.path)!;
      let result: Read;
      try {
        result = readSessionFile(file.path);
      } catch (error) {
        // Could not be read, or could not be set aside: left where it is
        logger.error("Error loading session:", error);
        result = { failed: true };
      }
      reads.set(file.path, result);
      return result;
    };

    // Newest first. A damaged file is set aside (kept beside the others as
    // <id>.corrupt-<time>.json) and the next one is tried; the person is
    // told, because the session they get is not the one they last used.
    const passedOver: string[] = [];
    const sessionOf = (file: SessionFile): Session | undefined => {
      const result = read(file);
      if (!result) return undefined;
      if ("failed" in result) {
        if (!passedOver.includes(file.path)) passedOver.push(file.path);
        return undefined;
      }
      if ("damaged" in result) {
        const keptAt = result.damaged?.keptAt;
        if (keptAt && !passedOver.includes(keptAt)) passedOver.push(keptAt);
        return undefined;
      }
      return result.session;
    };

    const resume = (session: Session, otherFolder: boolean): Session => {
      SessionManager.getInstance().setSession(session);
      if (passedOver.length > 0) {
        userNotice(resumedEarlierNotice(passedOver, session));
      } else if (otherFolder) {
        userNotice(resumedOtherFolderNotice(cwd, session));
      }
      return session;
    };

    // 1. The newest session of this folder
    for (const file of files) {
      const listed = listedDirs.get(file.id);
      if (listed !== undefined && !isSessionInWorkspace(listed, cwd)) continue;
      const session = sessionOf(file);
      if (session && isSessionInWorkspace(session.workspaceDirectory, cwd)) {
        return resume(session, false);
      }
    }

    // 2. None here: the newest of any folder, and say where it is from
    for (const file of files) {
      const session = sessionOf(file);
      if (session) return resume(session, true);
    }

    if (passedOver.length > 0) {
      userNotice(
        `${couldNotBeRead(passedOver)} There is no earlier session to resume; starting a new one.`,
      );
    }
    return null;
  } catch (error) {
    logger.error("Error loading session:", error);
    return null;
  }
}

/** Said when this folder has no session and another folder's was resumed. */
export function resumedOtherFolderNotice(
  cwd: string,
  session: Session,
): string {
  const title = session.title || DEFAULT_SESSION_TITLE;
  const where = session.workspaceDirectory || "no folder";
  return `No session was started in ${cwd}; resumed the newest one instead: "${title}" from ${where}. \`continuous ls\` lists the others.`;
}

function couldNotBeRead(keptAt: string[]): string {
  return keptAt.length === 1
    ? `The newest session could not be read (kept at ${keptAt[0]}).`
    : `The ${keptAt.length} newest sessions could not be read (kept at ${keptAt.join(", ")}).`;
}

/** Said when --resume did not resume the session the person last used. */
function resumedEarlierNotice(keptAt: string[], session: Session): string {
  const title = session.title || DEFAULT_SESSION_TITLE;
  const where = session.workspaceDirectory
    ? ` from ${session.workspaceDirectory}`
    : "";
  return `${couldNotBeRead(keptAt)} Resumed the one before it: "${title}"${where}.`;
}

/**
 * Create a new session
 */
export function createSession(
  history: ChatHistoryItem[] = [],
  sessionId?: string,
): Session {
  const session: Session = {
    sessionId: sessionId ?? uuidv4(),
    title: DEFAULT_SESSION_TITLE,
    workspaceDirectory: process.cwd(),
    history,
    usage: {
      totalCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: {
        cachedTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };
  SessionManager.getInstance().setSession(session);
  return session;
}

/**
 * Clear the current session
 */
export function clearSession(): void {
  try {
    const manager = SessionManager.getInstance();
    if (manager.hasSession()) {
      const sessionFilePath = path.join(
        getSessionDir(),
        `${manager.getSessionId()}.json`,
      );
      if (fs.existsSync(sessionFilePath)) {
        fs.unlinkSync(sessionFilePath);
      }
      manager.clear();
    }
  } catch (error) {
    logger.error("Error clearing session:", error);
  }
}

/**
 * Check if a session exists for the current terminal
 */
export function hasSession(): boolean {
  const manager = SessionManager.getInstance();
  if (!manager.hasSession()) {
    return false;
  }
  const sessionFilePath = path.join(
    getSessionDir(),
    `${manager.getSessionId()}.json`,
  );
  return fs.existsSync(sessionFilePath);
}

/**
 * Get metadata from a session file with first user message preview
 */
function getSessionMetadataWithPreview(
  filePath: string,
): ExtendedSessionMetadata | null {
  try {
    const sessionData: Session = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const stats = fs.statSync(filePath);

    // Find the first user message for preview
    let firstUserMessage: string | undefined;
    for (const item of sessionData.history || []) {
      if (item.message.role === "user") {
        const content = item.message.content;
        // Handle both string and array content types
        if (typeof content === "string") {
          firstUserMessage = content;
        } else if (Array.isArray(content)) {
          // For array content, find the first text part
          const textPart = content.find((part) => part.type === "text");
          firstUserMessage =
            textPart && "text" in textPart
              ? textPart.text
              : "(multimodal message)";
        } else {
          firstUserMessage = "(unknown content type)";
        }
        break;
      }
    }

    return {
      sessionId: sessionData.sessionId,
      title: sessionData.title || DEFAULT_SESSION_TITLE,
      dateCreated: stats.birthtime.toISOString(),
      lastModified: stats.mtime.toISOString(),
      workspaceDirectory: sessionData.workspaceDirectory || "",
      firstUserMessage,
    };
  } catch (error) {
    logger.error(`Error reading session file ${filePath}:`, error);
    return null;
  }
}

/**
 * Remote sessions are no longer available (Hub integration removed).
 */
export async function getRemoteSessions(): Promise<ExtendedSessionMetadata[]> {
  return [];
}

/**
 * List all available sessions with metadata (both local and remote)
 */
export async function listSessions(
  limit: number = 100,
): Promise<ExtendedSessionMetadata[]> {
  try {
    // Get local sessions
    const localSessions = historyManager.list({ limit });

    // Add first user message preview to each local session
    const localSessionsWithPreview: ExtendedSessionMetadata[] = [];

    for (const sessionMeta of localSessions) {
      const sessionFilePath = path.join(
        getSessionDir(),
        `${sessionMeta.sessionId}.json`,
      );

      if (fs.existsSync(sessionFilePath)) {
        const metadata = getSessionMetadataWithPreview(sessionFilePath);
        if (metadata) {
          localSessionsWithPreview.push({
            ...metadata,
            isRemote: false,
          });
        }
      } else {
        // Fall back to basic metadata if file doesn't exist
        localSessionsWithPreview.push({
          ...sessionMeta,
          isRemote: false,
        });
      }
    }

    // Get remote sessions
    const remoteSessions = await getRemoteSessions();

    // Combine and sort by date (most recent first)
    const allSessions = [...localSessionsWithPreview, ...remoteSessions]
      .sort(
        (a, b) =>
          new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime(),
      )
      .slice(0, limit);

    return allSessions;
  } catch (error) {
    logger.error("Error listing sessions:", error);
    return [];
  }
}

/** What deleting a session from the picker did (`trashSessionById`). */
export type PickerTrashResult =
  | TrashSessionResult
  /** The session this process is in: not deleted, it would be saved again. */
  | { status: "current"; sessionId: string };

/**
 * Delete from the session picker (NI11): the session goes to the same trash
 * as the IDE's History page (core/util/sessionTrash.ts), restorable for 7
 * days. The session this process is in is refused, and one open in another
 * window or agent is moved only with `force`.
 */
export async function trashSessionById(
  sessionId: string,
  options: { force?: boolean } = {},
): Promise<PickerTrashResult> {
  const manager = SessionManager.getInstance();
  if (manager.hasSession() && manager.getSessionId() === sessionId) {
    return { status: "current", sessionId };
  }
  return historyManager.trash(sessionId, options);
}

/** Undo in the picker: the trashed session is back in the list. */
export function restoreTrashedSessionById(
  sessionId: string,
): BaseSessionMetadata {
  return historyManager.restore(sessionId);
}

/**
 * Load session by ID
 */
export function loadSessionById(sessionId: string): Session | null {
  try {
    const result = historyManager.loadWithStatus(sessionId);
    if (result.damaged) userNotice(damagedSessionNotice(result.damaged));
    return result.session;
  } catch (error) {
    logger.error("Error loading session by ID:", error);
    return null;
  }
}

/**
 * Load an existing session by ID or create a new one with that ID.
 * Useful for long-lived processes (e.g., cn serve) that need to
 * preserve chat history across restarts for the same storage/agent id.
 */
export function loadOrCreateSessionById(
  sessionId: string,
  history: ChatHistoryItem[] = [],
): Session {
  const existing = loadSessionById(sessionId);
  if (existing) {
    SessionManager.getInstance().setSession(existing);
    return existing;
  }

  return createSession(history, sessionId);
}

/**
 * Update the current session's history
 */
export function updateSessionHistory(history: ChatHistoryItem[]): void {
  SessionManager.getInstance().updateHistory(history);
}

/**
 * Update the current session's title
 */
export function updateSessionTitle(title: string): void {
  SessionManager.getInstance().updateTitle(title);
}

/**
 * Get the current session
 */
export function getCurrentSession(): Session {
  return SessionManager.getInstance().getCurrentSession();
}

/**
 * Start a new session with a new sessionId
 */
export function startNewSession(history: ChatHistoryItem[] = []): Session {
  const manager = SessionManager.getInstance();

  // Clear the current session from memory (don't delete the file)
  manager.clear();

  // Create a new session with a new sessionId
  const newSession: Session = {
    sessionId: uuidv4(),
    title: DEFAULT_SESSION_TITLE,
    workspaceDirectory: process.cwd(),
    history,
    usage: {
      totalCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      promptTokensDetails: {
        cachedTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  };

  manager.setSession(newSession);
  return newSession;
}

/**
 * Fork `parent` into a new session and make the fork the current one. The
 * fork keeps what `startNewSession` dropped: the mode, the chat model, the
 * task plan and the prompt cache record (core/util/forkSession.ts has the
 * copy table). Its history is the parent's, unchanged, so its first request
 * starts with the same bytes and can read the parent's cache. The parent's
 * file is not touched. Permission levels are the process's, not the
 * session's, so a fork keeps them (an IDGAF set for this run stays set).
 */
export function forkIntoNewSession(parent: Session): Session {
  const manager = SessionManager.getInstance();
  const fork = forkSession(parent, { sessionId: uuidv4() });
  fork.workspaceDirectory = process.cwd();

  manager.clear();
  manager.setSession(fork);
  saveSession();
  return fork;
}

type TaskPlanListener = (plan: TaskPlan | undefined) => void;
const taskPlanListeners = new Set<TaskPlanListener>();

function notifyTaskPlanListeners(plan: TaskPlan | undefined): void {
  for (const listener of taskPlanListeners) {
    try {
      listener(plan);
    } catch (error) {
      logger.error("Task list listener failed:", error);
    }
  }
}

/**
 * The current session's task list (see core/util/taskPlan.ts). It lives on
 * the session, outside the history, so compaction cannot lose it.
 */
export function getSessionTaskPlan(): TaskPlan | undefined {
  return SessionManager.getInstance().getCurrentSession().taskPlan;
}

/** Replaces the current session's task list and saves the session. */
export function updateSessionTaskPlan(plan: TaskPlan | undefined): void {
  SessionManager.getInstance().updateTaskPlan(plan);
}

/** URI of the plan file the current session works from (core/util/planFile.ts). */
export function getSessionPlanFile(): string | undefined {
  return SessionManager.getInstance().getCurrentSession().planFile;
}

/** Records the current session's plan file and saves the session. */
export function updateSessionPlanFile(planFile: string | undefined): void {
  SessionManager.getInstance().updatePlanFile(planFile);
}

/** Calls `listener` whenever the task list changes; returns an unsubscribe. */
export function onTaskPlanChange(listener: TaskPlanListener): () => void {
  taskPlanListeners.add(listener);
  return () => taskPlanListeners.delete(listener);
}

type LoopListener = (loop: LoopState | undefined) => void;
const loopListeners = new Set<LoopListener>();

function notifyLoopListeners(loop: LoopState | undefined): void {
  for (const listener of loopListeners) {
    try {
      listener(loop);
    } catch (error) {
      logger.error("Loop listener failed:", error);
    }
  }
}

/** The current session's Loop mode state (core/util/loopMode.ts). */
export function getSessionLoop(): LoopState | undefined {
  return SessionManager.getInstance().getCurrentSession().loop;
}

/**
 * Replaces the current session's loop and saves the session. Callers go
 * through src/loop/loopSession.ts commitLoop, which also keeps the task list
 * in step with the loop.
 */
export function updateSessionLoop(loop: LoopState | undefined): void {
  SessionManager.getInstance().updateLoop(loop);
}

/** Calls `listener` whenever the loop changes; returns an unsubscribe. */
export function onLoopChange(listener: LoopListener): () => void {
  loopListeners.add(listener);
  return () => loopListeners.delete(listener);
}

/**
 * Track cost and tokens for the current session. `provider` and `model` let
 * the input total count what the provider's own `promptTokens` leaves out.
 */
export function trackSessionUsage(
  cost: number,
  usage: Usage,
  provider?: string,
  model?: string,
  how: boolean | TrackHow = false,
): void {
  SessionManager.getInstance().trackUsage(cost, usage, provider, model, how);
}

/**
 * Get the total cost for the current session
 */
export function getTotalSessionCost(): number {
  return SessionManager.getInstance().getTotalCost();
}

/**
 * Get the full usage statistics for the current session
 */
export function getSessionUsage(): SessionUsage {
  return SessionManager.getInstance().getUsage();
}
