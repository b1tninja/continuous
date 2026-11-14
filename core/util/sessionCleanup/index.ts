/**
 * "Clean up old sessions": the VS Code command and `continuous sessions
 * clean` share this module, so the two say and do the same thing.
 *
 * `scanForCleanup` is the dry run. It reads, never writes, and reports:
 * - sessions whose history still holds prompt logs with the full prompt
 *   (every request's, kept by releases before the prompt log fix), measured
 *   by streaming each file, so a session past V8's string limit is read too.
 *   A cleaned file keeps what the product writes now: the marker in place of
 *   each prompt, model and completion as they were;
 * - `dev_data` lines older than the dev data retention (90 days by default),
 *   and full prompts in kept `chatInteraction` lines, which now keep sizes
 *   and a hash instead;
 * - files in `logs/` older than the log retention (14 days by default).
 *
 * `applyCleanup` does what a scan found, file by file. Each file is
 * rewritten to a temporary file, checked (a session must parse and hold the
 * same items and message ids), and renamed over the original; the original
 * is kept in `<global folder>/cleanup-backups/<date>/` first. A session open
 * in another window or used by a running agent, or written in the last few
 * minutes, is skipped, and so is any file that changed while it was being
 * rewritten. Nothing runs by itself: both callers ask first.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { summarizeChatInteraction } from "../../data/chatInteractionSummary.js";
import { DAY_MS, DEFAULT_RETENTION_DAYS } from "../cleanStores.js";
import { getGlobalDirPath } from "../paths.js";
import { openSessions, type OpenSession } from "../sessionLeases.js";
import { JsonScanError } from "./jsonStreamScan.js";
import {
  scanSessionFile,
  verifySessionCopy,
  writeWithEdits,
  type SessionFileScan,
} from "./sessionFile.js";

export { DROPPED_PROMPT_MARKER } from "./sessionFile.js";

/** The after-update notice is shown only above this. */
export const CLEANUP_NOTICE_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const CLEANUP_BACKUP_DIR = "cleanup-backups";
/** A session written this recently may be mid-conversation somewhere. */
export const RECENTLY_WRITTEN_MS = 10 * 60 * 1000;

export type CleanupStore = "sessions" | "dev_data" | "logs";

export interface CleanupOptions {
  /** The global folder; default the real one. */
  root?: string;
  now?: number;
  /** Dev data lines older than this many days go. Default 90. */
  devDataDays?: number;
  /** Log files older than this many days go. Default 14. */
  logsDays?: number;
  /** Which stores to look at; all by default. */
  stores?: readonly CleanupStore[];
  /** Sessions open elsewhere; default read from `sessions-open/`. */
  open?: Map<string, OpenSession>;
  signal?: AbortSignal;
  onProgress?: (file: string, done: number, total: number) => void;
}

export interface SessionFinding {
  file: string;
  sessionId: string;
  bytes: number;
  mtimeMs: number;
  promptLogs: number;
  fullPrompts: number;
  reclaimableBytes: number;
}

export interface DevDataFinding {
  file: string;
  bytes: number;
  mtimeMs: number;
  oldLines: number;
  oldBytes: number;
  /** Kept chatInteraction lines that still hold the prompt text. */
  promptLines: number;
  promptBytes: number;
  reclaimableBytes: number;
}

export interface LogFinding {
  file: string;
  bytes: number;
  mtimeMs: number;
}

export type SkipReason =
  | "open elsewhere"
  | "written in the last 10 minutes"
  | "not a readable session"
  | "changed during cleanup"
  | "nothing to remove";

export interface Skipped {
  file: string;
  store: CleanupStore;
  reason: SkipReason;
  bytes: number;
}

export interface CleanupScan {
  root: string;
  scannedAt: number;
  stores: CleanupStore[];
  devDataDays: number;
  logsDays: number;
  sessionFilesScanned: number;
  sessions: SessionFinding[];
  devData: DevDataFinding[];
  logs: LogFinding[];
  skipped: Skipped[];
  /** The largest session file seen, cleaned or not. */
  largestSession?: { file: string; bytes: number };
  totals: {
    sessionsBytes: number;
    devDataBytes: number;
    logsBytes: number;
    reclaimableBytes: number;
  };
}

export interface CleanupResult {
  backupDir: string;
  sessions: { cleaned: number; bytes: number };
  devData: { cleaned: number; bytes: number };
  logs: { moved: number; bytes: number };
  skipped: Skipped[];
  failed: { file: string; reason: string }[];
}

function storesOf(options: CleanupOptions): CleanupStore[] {
  return [...(options.stores ?? ["sessions", "dev_data", "logs"])];
}

/** Regular files under `dir`, depth first, symbolic links left out. */
async function walk(
  dir: string,
  skipDirs: Set<string> = new Set(),
): Promise<string[]> {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!skipDirs.has(p)) out.push(...(await walk(p, skipDirs)));
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Session files: `sessions/<id>.json`, not the list, temporaries or set-aside copies. */
export async function listSessionFiles(root: string): Promise<string[]> {
  const dir = path.join(root, "sessions");
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter(
      (n) =>
        n.endsWith(".json") &&
        n !== "sessions.json" &&
        !n.includes(".tmp") &&
        !n.includes(".corrupt-"),
    )
    .sort()
    .map((n) => path.join(dir, n));
}

const TIMESTAMP_RE = /"timestamp"\s*:\s*"([^"]+)"/;

function lineTime(line: string): number | undefined {
  const m = TIMESTAMP_RE.exec(line);
  if (!m) return undefined;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * What to do with one dev data line: drop it (older than the cutoff), keep it
 * as it is, or replace it with a shorter one (a chatInteraction record that
 * still holds the prompt text).
 */
function devDataLine(
  line: string,
  cutoff: number,
  isChatInteraction: boolean,
): { drop: true } | { drop: false; text: string } {
  const t = lineTime(line);
  if (t !== undefined && t < cutoff) return { drop: true };
  if (
    isChatInteraction &&
    (line.includes('"prompt"') || line.includes('"completion"'))
  ) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record && typeof record === "object" && !Array.isArray(record)) {
        return {
          drop: false,
          text: JSON.stringify(summarizeChatInteraction(record)),
        };
      }
    } catch {
      // a line that does not parse is kept as it is
    }
  }
  return { drop: false, text: line };
}

function lines(file: string, start = 0, end?: number) {
  return readline.createInterface({
    input: fs.createReadStream(file, { start, end }),
    crlfDelay: Infinity,
  });
}

async function scanDevDataFile(
  file: string,
  cutoff: number,
  signal?: AbortSignal,
): Promise<DevDataFinding | undefined> {
  const st = await fsp.stat(file);
  const isChat = path.basename(file) === "chatInteraction.jsonl";
  const f: DevDataFinding = {
    file,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    oldLines: 0,
    oldBytes: 0,
    promptLines: 0,
    promptBytes: 0,
    reclaimableBytes: 0,
  };
  for await (const line of lines(file, 0, st.size > 0 ? st.size - 1 : 0)) {
    signal?.throwIfAborted();
    if (!line) continue;
    const bytes = Buffer.byteLength(line) + 1;
    const d = devDataLine(line, cutoff, isChat);
    if (d.drop) {
      f.oldLines++;
      f.oldBytes += bytes;
    } else if (d.text !== line) {
      f.promptLines++;
      f.promptBytes += bytes - Buffer.byteLength(d.text) - 1;
    }
  }
  f.reclaimableBytes = f.oldBytes + f.promptBytes;
  return f.reclaimableBytes > 0 ? f : undefined;
}

function sessionIdOf(file: string): string {
  return path.basename(file, ".json");
}

/** The dry run. Reads only. */
export async function scanForCleanup(
  options: CleanupOptions = {},
): Promise<CleanupScan> {
  const root = options.root ?? getGlobalDirPath();
  const now = options.now ?? Date.now();
  const stores = storesOf(options);
  const devDataDays = options.devDataDays ?? DEFAULT_RETENTION_DAYS.dev_data;
  const logsDays = options.logsDays ?? DEFAULT_RETENTION_DAYS.logs;
  const open = options.open ?? openSessions({ root, now });
  const scan: CleanupScan = {
    root,
    scannedAt: now,
    stores,
    devDataDays,
    logsDays,
    sessionFilesScanned: 0,
    sessions: [],
    devData: [],
    logs: [],
    skipped: [],
    totals: {
      sessionsBytes: 0,
      devDataBytes: 0,
      logsBytes: 0,
      reclaimableBytes: 0,
    },
  };

  const sessionFiles = stores.includes("sessions")
    ? await listSessionFiles(root)
    : [];
  const devFiles = stores.includes("dev_data")
    ? (await walk(path.join(root, "dev_data"))).filter((f) =>
        f.endsWith(".jsonl"),
      )
    : [];
  const logFiles = stores.includes("logs")
    ? await walk(path.join(root, "logs"))
    : [];
  const total = sessionFiles.length + devFiles.length + logFiles.length;
  let done = 0;
  const progress = (file: string) => options.onProgress?.(file, ++done, total);

  for (const file of sessionFiles) {
    options.signal?.throwIfAborted();
    progress(file);
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    if (!scan.largestSession || st.size > scan.largestSession.bytes) {
      scan.largestSession = { file, bytes: st.size };
    }
    const skip = sessionSkipReason(file, st, open, now);
    if (skip) {
      scan.skipped.push({
        file,
        store: "sessions",
        reason: skip,
        bytes: st.size,
      });
      continue;
    }
    let s: SessionFileScan;
    try {
      s = await scanSessionFile(file, { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      scan.skipped.push({
        file,
        store: "sessions",
        reason: "not a readable session",
        bytes: st.size,
      });
      continue;
    }
    scan.sessionFilesScanned++;
    if (s.reclaimableBytes <= 0) continue;
    scan.sessions.push({
      file,
      sessionId: s.sessionId ?? sessionIdOf(file),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      promptLogs: s.promptLogs,
      fullPrompts: s.fullPrompts,
      reclaimableBytes: s.reclaimableBytes,
    });
    scan.totals.sessionsBytes += s.reclaimableBytes;
  }

  const devCutoff = now - devDataDays * DAY_MS;
  for (const file of devFiles) {
    options.signal?.throwIfAborted();
    progress(file);
    try {
      const f = await scanDevDataFile(file, devCutoff, options.signal);
      if (f) {
        scan.devData.push(f);
        scan.totals.devDataBytes += f.reclaimableBytes;
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }

  const logCutoff = now - logsDays * DAY_MS;
  for (const file of logFiles) {
    progress(file);
    try {
      const st = await fsp.stat(file);
      if (st.mtimeMs < logCutoff) {
        scan.logs.push({ file, bytes: st.size, mtimeMs: st.mtimeMs });
        scan.totals.logsBytes += st.size;
      }
    } catch {
      // gone since the listing
    }
  }

  scan.totals.reclaimableBytes =
    scan.totals.sessionsBytes +
    scan.totals.devDataBytes +
    scan.totals.logsBytes;
  return scan;
}

function sessionSkipReason(
  file: string,
  st: fs.Stats,
  open: Map<string, OpenSession>,
  now: number,
): SkipReason | undefined {
  if (open.has(sessionIdOf(file))) return "open elsewhere";
  if (now - st.mtimeMs < RECENTLY_WRITTEN_MS)
    return "written in the last 10 minutes";
  return undefined;
}

/** An upper bound, from file sizes alone: if it is under the threshold, a scan cannot be over it. */
export async function quickCleanupEstimate(
  options: CleanupOptions = {},
): Promise<number> {
  const root = options.root ?? getGlobalDirPath();
  let bytes = 0;
  const add = async (file: string) => {
    try {
      bytes += (await fsp.stat(file)).size;
    } catch {
      // gone
    }
  };
  for (const f of await listSessionFiles(root)) await add(f);
  for (const f of await walk(path.join(root, "dev_data"))) {
    if (f.endsWith(".jsonl")) await add(f);
  }
  for (const f of await walk(path.join(root, "logs"))) await add(f);
  return bytes;
}

/** `cleanup-backups/2026-11-14`: one folder a day, sortable. */
export function backupDayFolder(root: string, now: number): string {
  return path.join(
    root,
    CLEANUP_BACKUP_DIR,
    new Date(now).toISOString().slice(0, 10),
  );
}

/** Where a file's original goes: the same path under the backup folder, never over an existing backup. */
function backupPathFor(root: string, backupDir: string, file: string): string {
  const rel = path.relative(root, file);
  let target = path.join(backupDir, rel);
  for (let n = 1; fs.existsSync(target); n++) {
    target = path.join(backupDir, `${rel}.${n}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

/** Keep the original's bytes at `target`: a hard link, or a copy where links do not work. */
function keepOriginal(file: string, target: string): void {
  try {
    fs.linkSync(file, target);
  } catch {
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
  }
}

function removeQuietly(file: string | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // nothing to undo
  }
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

export interface ApplyOptions extends CleanupOptions {
  /** The check of a rewritten session; tests replace it. */
  verifySession?: typeof verifySessionCopy;
}

/**
 * Does what `scan` found. Re-reads every file (it may have changed since the
 * scan), and re-checks which sessions are open.
 */
export async function applyCleanup(
  scan: CleanupScan,
  options: ApplyOptions = {},
): Promise<CleanupResult> {
  const root = scan.root;
  const now = options.now ?? Date.now();
  const open = options.open ?? openSessions({ root, now });
  const verify = options.verifySession ?? verifySessionCopy;
  const backupDir = backupDayFolder(root, now);
  const result: CleanupResult = {
    backupDir,
    sessions: { cleaned: 0, bytes: 0 },
    devData: { cleaned: 0, bytes: 0 },
    logs: { moved: 0, bytes: 0 },
    skipped: [],
    failed: [],
  };
  const total = scan.sessions.length + scan.devData.length + scan.logs.length;
  let done = 0;
  const progress = (file: string) => options.onProgress?.(file, ++done, total);

  for (const finding of scan.sessions) {
    options.signal?.throwIfAborted();
    progress(finding.file);
    await applySession(finding, {
      root,
      now,
      open,
      verify,
      backupDir,
      result,
      signal: options.signal,
    });
  }

  const cutoff = now - scan.devDataDays * DAY_MS;
  for (const finding of scan.devData) {
    options.signal?.throwIfAborted();
    progress(finding.file);
    await applyDevData(finding, {
      root,
      cutoff,
      backupDir,
      result,
      signal: options.signal,
    });
  }

  for (const finding of scan.logs) {
    progress(finding.file);
    try {
      const st = fs.statSync(finding.file);
      if (st.mtimeMs !== finding.mtimeMs) {
        result.skipped.push({
          file: finding.file,
          store: "logs",
          reason: "changed during cleanup",
          bytes: st.size,
        });
        continue;
      }
      fs.renameSync(finding.file, backupPathFor(root, backupDir, finding.file));
      result.logs.moved++;
      result.logs.bytes += st.size;
    } catch (error) {
      result.failed.push({ file: finding.file, reason: codeOf(error) });
    }
  }
  return result;
}

async function applySession(
  finding: SessionFinding,
  ctx: {
    root: string;
    now: number;
    open: Map<string, OpenSession>;
    verify: typeof verifySessionCopy;
    backupDir: string;
    result: CleanupResult;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { file } = finding;
  const { result } = ctx;
  let before: fs.Stats;
  try {
    before = fs.statSync(file);
  } catch (error) {
    result.failed.push({ file, reason: codeOf(error) });
    return;
  }
  const skip = sessionSkipReason(file, before, ctx.open, ctx.now);
  if (skip) {
    result.skipped.push({
      file,
      store: "sessions",
      reason: skip,
      bytes: before.size,
    });
    return;
  }
  const tmp = `${file}.cleanup-${process.pid}.tmp`;
  let backup: string | undefined;
  try {
    const s = await scanSessionFile(file, { signal: ctx.signal });
    if (!s.edits.length) {
      result.skipped.push({
        file,
        store: "sessions",
        reason: "nothing to remove",
        bytes: before.size,
      });
      return;
    }
    removeQuietly(tmp);
    await writeWithEdits(file, tmp, s.edits, { signal: ctx.signal });
    await ctx.verify(s, tmp, { signal: ctx.signal });
    if (!sameFile(before, fs.statSync(file))) {
      removeQuietly(tmp);
      result.skipped.push({
        file,
        store: "sessions",
        reason: "changed during cleanup",
        bytes: before.size,
      });
      return;
    }
    backup = backupPathFor(ctx.root, ctx.backupDir, file);
    keepOriginal(file, backup);
    fs.renameSync(tmp, file);
    result.sessions.cleaned++;
    result.sessions.bytes += s.reclaimableBytes;
  } catch (error) {
    // Roll back: the original was never replaced, so drop the copy and the backup.
    removeQuietly(tmp);
    removeQuietly(backup);
    if (ctx.signal?.aborted) throw error;
    result.failed.push({
      file,
      reason: error instanceof JsonScanError ? "not valid JSON" : codeOf(error),
    });
  }
}

async function applyDevData(
  finding: DevDataFinding,
  ctx: {
    root: string;
    cutoff: number;
    backupDir: string;
    result: CleanupResult;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { file } = finding;
  const { result } = ctx;
  const tmp = `${file}.cleanup-${process.pid}.tmp`;
  let backup: string | undefined;
  try {
    const before = fs.statSync(file);
    const isChat = path.basename(file) === "chatInteraction.jsonl";
    removeQuietly(tmp);
    const out = await fsp.open(tmp, "wx", 0o600);
    let saved = 0;
    try {
      let pending: string[] = [];
      let pendingBytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        await out.write(pending.join(""));
        pending = [];
        pendingBytes = 0;
      };
      if (before.size > 0) {
        for await (const line of lines(file, 0, before.size - 1)) {
          ctx.signal?.throwIfAborted();
          if (!line) continue;
          const d = devDataLine(line, ctx.cutoff, isChat);
          if (d.drop) {
            saved += Buffer.byteLength(line) + 1;
            continue;
          }
          saved += Buffer.byteLength(line) - Buffer.byteLength(d.text);
          pending.push(`${d.text}\n`);
          pendingBytes += d.text.length + 1;
          if (pendingBytes > 1 << 20) await flush();
        }
      }
      await flush();
      // Lines appended while this ran are carried over as they are.
      const now = fs.statSync(file);
      if (now.size < before.size) throw new Error("the file got shorter");
      if (now.size > before.size) {
        const input = await fsp.open(file, "r");
        try {
          const tail = Buffer.alloc(now.size - before.size);
          await input.read(tail, 0, tail.length, before.size);
          await out.write(tail);
        } finally {
          await input.close();
        }
      }
      await out.sync();
    } finally {
      await out.close();
    }
    backup = backupPathFor(ctx.root, ctx.backupDir, file);
    keepOriginal(file, backup);
    fs.renameSync(tmp, file);
    result.devData.cleaned++;
    result.devData.bytes += saved;
  } catch (error) {
    removeQuietly(tmp);
    removeQuietly(backup);
    if (ctx.signal?.aborted) throw error;
    result.failed.push({ file, reason: codeOf(error) });
  }
}

/**
 * Deletes backup folders older than `olderThanMs`. Returns what went. Only
 * `cleanup-backups/<YYYY-MM-DD>` folders are ever touched.
 */
export function pruneCleanupBackups(
  root: string,
  olderThanMs: number,
  now = Date.now(),
): { removed: string[]; bytes: number } {
  const dir = path.join(root, CLEANUP_BACKUP_DIR);
  const out = { removed: [] as string[], bytes: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const day = Date.parse(`${name}T00:00:00Z`);
    if (Number.isNaN(day) || now - day < olderThanMs) continue;
    const p = path.join(dir, name);
    out.bytes += folderBytes(p);
    fs.rmSync(p, { recursive: true, force: true });
    out.removed.push(p);
  }
  return out;
}

function folderBytes(dir: string): number {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += folderBytes(p);
    else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The dry run's report, the same lines in the terminal and in VS Code. */
export function describeScan(scan: CleanupScan): string[] {
  const out: string[] = [];
  if (scan.stores.includes("sessions")) {
    const largest = scan.largestSession
      ? `, largest session file ${formatMegabytes(scan.largestSession.bytes)}`
      : "";
    out.push(
      `Sessions: ${scan.sessions.length} session(s) with old prompt logs, ${formatMegabytes(scan.totals.sessionsBytes)} of old prompt logs${largest}.`,
    );
    const skipped = scan.skipped.filter((s) => s.store === "sessions");
    if (skipped.length) {
      const open = skipped.filter((s) => s.reason === "open elsewhere").length;
      const recent = skipped.filter(
        (s) => s.reason === "written in the last 10 minutes",
      ).length;
      const bad = skipped.length - open - recent;
      const parts = [
        open && `${open} open in a window or agent`,
        recent && `${recent} written in the last 10 minutes`,
        bad && `${bad} not readable`,
      ].filter(Boolean);
      out.push(`  Left alone: ${parts.join(", ")}.`);
    }
  }
  if (scan.stores.includes("dev_data")) {
    const old = scan.devData.reduce((n, f) => n + f.oldBytes, 0);
    const prompts = scan.devData.reduce((n, f) => n + f.promptBytes, 0);
    out.push(
      `Dev data: ${formatMegabytes(old)} older than ${scan.devDataDays} days, ${formatMegabytes(prompts)} of full prompts in chatInteraction records (kept as sizes and a hash).`,
    );
  }
  if (scan.stores.includes("logs")) {
    out.push(
      `Logs: ${scan.logs.length} file(s) older than ${scan.logsDays} days, ${formatMegabytes(scan.totals.logsBytes)}.`,
    );
  }
  out.push(`Reclaimable: ${formatMegabytes(scan.totals.reclaimableBytes)}.`);
  return out;
}

export function describeResult(result: CleanupResult): string[] {
  const out = [
    `Cleaned ${result.sessions.cleaned} session(s) (${formatMegabytes(result.sessions.bytes)}), ${result.devData.cleaned} dev data file(s) (${formatMegabytes(result.devData.bytes)}), moved ${result.logs.moved} log file(s) (${formatMegabytes(result.logs.bytes)}).`,
    `Originals are kept in ${result.backupDir}. The space is freed when that folder is deleted.`,
  ];
  if (result.skipped.length) {
    out.push(
      `Left alone: ${result.skipped.map((s) => `${path.basename(s.file)} (${s.reason})`).join(", ")}.`,
    );
  }
  if (result.failed.length) {
    out.push(
      `Not changed, because of an error: ${result.failed.map((f) => `${path.basename(f.file)} (${f.reason})`).join(", ")}.`,
    );
  }
  return out;
}
