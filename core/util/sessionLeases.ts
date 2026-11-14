/**
 * Which sessions a running process has open, so that a cleanup run elsewhere
 * leaves them alone. Each process that loads or saves a session through
 * `HistoryManager` (a VS Code window, the terminal agent, a subagent or loop
 * run inside either) keeps one small file,
 * `<global folder>/sessions-open/<host>-<pid>.json`, listing the sessions it
 * touched and when.
 *
 * A session counts as open when a live process on this machine listed it as
 * its newest, or touched it within `OPEN_WITHIN_MS`. Files of processes that
 * are gone are removed by the next reader. Nothing here is ever a reason to
 * fail a load or a save.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getGlobalDirPath } from "./paths.js";

export const OPEN_WITHIN_MS = 2 * 60 * 60 * 1000;
/** Entries older than this are dropped from a process's own file. */
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;

interface LeaseFile {
  pid: number;
  host: string;
  /** sessionId -> last load or save, epoch ms. */
  sessions: Record<string, number>;
}

export function leaseDir(root: string = getGlobalDirPath()): string {
  return path.join(root, "sessions-open");
}

function safeHost(): string {
  return os.hostname().replace(/[^A-Za-z0-9.-]/g, "_") || "host";
}

let own: LeaseFile | undefined;

/** Records that this process has `sessionId` open. Best effort. */
export function markSessionOpen(
  sessionId: string,
  options: { root?: string; now?: number; pid?: number } = {},
): void {
  try {
    const now = options.now ?? Date.now();
    const pid = options.pid ?? process.pid;
    if (!own || own.pid !== pid)
      own = { pid, host: os.hostname(), sessions: {} };
    own.sessions[sessionId] = now;
    const kept = Object.entries(own.sessions)
      .filter(([, at]) => now - at < FORGET_AFTER_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    own.sessions = Object.fromEntries(kept);
    const dir = leaseDir(options.root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${safeHost()}-${pid}.json`);
    const tmp = `${file}.${now}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(own), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // a session that cannot be marked is still loaded and saved
  }
}

/** Forget this process's own record (for tests). */
export function resetOwnLease(): void {
  own = undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is someone else's
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface OpenSession {
  pid: number;
  host: string;
  at: number;
}

/**
 * Sessions open in a running process, keyed by session id. `exceptPid`
 * leaves out one process (a cleanup run's own, when it should not count).
 */
export function openSessions(
  options: {
    root?: string;
    now?: number;
    exceptPid?: number;
    alive?: (pid: number) => boolean;
  } = {},
): Map<string, OpenSession> {
  const now = options.now ?? Date.now();
  const alive = options.alive ?? isAlive;
  const host = os.hostname();
  const result = new Map<string, OpenSession>();
  const dir = leaseDir(options.root);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let lease: LeaseFile;
    try {
      lease = JSON.parse(fs.readFileSync(file, "utf8")) as LeaseFile;
    } catch {
      continue;
    }
    if (!lease || typeof lease.pid !== "number" || !lease.sessions) continue;
    if (lease.pid === options.exceptPid && lease.host === host) continue;
    const local = lease.host === host;
    if (local && !alive(lease.pid)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // another reader removed it
      }
      continue;
    }
    const entries = Object.entries(lease.sessions).filter(
      ([, at]) => typeof at === "number",
    );
    const newest = entries.reduce(
      (best, e) => (e[1] > best ? e[1] : best),
      -Infinity,
    );
    for (const [id, at] of entries) {
      // On another machine (a shared home folder) only recent use counts.
      const open = now - at < OPEN_WITHIN_MS || (local && at === newest);
      if (open) result.set(id, { pid: lease.pid, host: lease.host, at });
    }
  }
  return result;
}
