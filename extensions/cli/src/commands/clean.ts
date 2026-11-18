/**
 * `continuous clean [--older-than 30d] [--yes]` (ROADMAP X15): remove the
 * product's own persisted files older than an age. Dry run unless `--yes`.
 * Prints counts, sizes and paths, never contents. Only sessions, dev_data and
 * logs under the global folder are touched.
 *
 * Sessions are not deleted: each goes to the trash with `HistoryManager.trash`
 * (core/util/sessionTrash.ts, through `moveToTrash` shared with
 * `continuous sessions prune`), never forced, so a clean can be undone for
 * 7 days and a session open in another window or agent (a lease in
 * `sessions-open/`) is left alone. Logs and dev_data are deleted as before.
 */
import fs from "node:fs";
import path from "node:path";

import type { Command } from "commander";
import {
  DEFAULT_RETENTION_DAYS,
  parseAge,
  planClean,
  runClean,
  type CleanEntry,
  type CleanPlan,
  type CleanResult,
} from "core/util/cleanStores.js";
import historyManager from "core/util/history.js";
import { getGlobalDirPath } from "core/util/paths.js";
import type { Io } from "core/util/secretScan/secretsCli.js";
import { openSessions } from "core/util/sessionLeases.js";

import { gracefulExit } from "../util/exit.js";

import {
  describeTrashResult,
  moveToTrash,
  TRASH_RESTORE_LINE,
  type PruneCandidate,
  type TrashResult,
} from "./sessionsPrune.js";

export interface CleanCommandOptions {
  olderThan?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Global folder; default the real one (tests pass a temp dir). */
  root?: string;
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

export const CLEAN_NOTE =
  "Deleting is not secure erasure: SSDs, journals, snapshots and backups can keep the bytes. Rotate any credential that was in a file you removed.";

/** The old sessions of a plan, by id, split into what moves and what is open. */
interface SessionPlan {
  toTrash: PruneCandidate[];
  open: (PruneCandidate & { pid: number; host: string })[];
  /**
   * Set when `root` is not the global folder `HistoryManager` works on:
   * sessions there are left alone rather than deleted.
   */
  notGlobal?: string;
}

const sessionIdOf = (file: string) =>
  path.basename(file).replace(/\.jsonl?$/, "");

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function planSessions(entries: CleanEntry[], root: string): SessionPlan {
  const plan: SessionPlan = { toTrash: [], open: [] };
  if (!entries.length) return plan;
  if (!sameFolder(root, getGlobalDirPath())) {
    plan.notGlobal = root;
    return plan;
  }
  const titles = new Map(
    historyManager.list({}).map((s) => [s.sessionId, s.title]),
  );
  const byId = new Map<string, PruneCandidate>();
  for (const e of entries) {
    const id = sessionIdOf(e.file);
    const c = byId.get(id) ?? {
      sessionId: id,
      title: titles.get(id) || "(untitled)",
      lastUsed: 0,
      bytes: 0,
    };
    c.bytes += e.bytes;
    c.lastUsed = Math.max(c.lastUsed, mtimeMs(e.file));
    byId.set(id, c);
  }
  const leases = openSessions({ root, exceptPid: process.pid });
  for (const c of byId.values()) {
    const lease = leases.get(c.sessionId);
    if (lease) plan.open.push({ ...c, pid: lease.pid, host: lease.host });
    else plan.toTrash.push(c);
  }
  return plan;
}

/** The plan without its session files: what is deleted. */
function withoutSessions(plan: CleanPlan): CleanPlan {
  const entries = plan.entries.filter((e) => e.store !== "sessions");
  return {
    ...plan,
    entries,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}

function describeSessions(sessions: SessionPlan): string[] {
  const bytes = sessions.toTrash.reduce((n, c) => n + c.bytes, 0);
  const lines = [
    `sessions: ${sessions.toTrash.length} session(s), ${bytes} bytes, to the trash`,
  ];
  for (const c of sessions.toTrash) lines.push(`  ${c.sessionId}  ${c.title}`);
  if (sessions.open.length) {
    lines.push(
      `  Left alone, open in another window or agent: ${sessions.open.map((c) => `${c.sessionId} (pid ${c.pid} on ${c.host})`).join(", ")}`,
    );
  }
  if (sessions.notGlobal) {
    lines.push(
      `  Left alone: sessions are moved to the trash only in the global folder, and ${sessions.notGlobal} is not it`,
    );
  }
  return lines;
}

function summarize(plan: CleanPlan, sessions: SessionPlan): string[] {
  const lines = describeSessions(sessions);
  for (const store of ["dev_data", "logs"] as const) {
    const es = plan.entries.filter((e) => e.store === store);
    const bytes = es.reduce((n, e) => n + e.bytes, 0);
    const dropped = es
      .filter((e) => e.action === "lines")
      .reduce((n, e) => n + (e.lines ?? 0), 0);
    lines.push(
      `${store}: ${es.length} file(s), ${bytes} bytes${dropped ? `, ${dropped} old line(s) inside kept files` : ""}`,
    );
  }
  return lines;
}

function jsonOf(
  plan: CleanPlan,
  sessions: SessionPlan,
  result: CleanResult | undefined,
  trashed: TrashResult | undefined,
): string {
  const ids = (cs: PruneCandidate[]) => cs.map((c) => c.sessionId);
  return JSON.stringify({
    root: plan.root,
    cutoff: plan.cutoff.toISOString(),
    applied: !!result,
    entries: plan.entries,
    bytes: plan.bytes,
    sessions: {
      toTrash: sessions.toTrash.map(({ sessionId, title, bytes }) => ({
        id: sessionId,
        title,
        bytes,
      })),
      open: sessions.open.map((c) => ({ id: c.sessionId, pid: c.pid })),
      leftAloneOutsideGlobalFolder: !!sessions.notGlobal,
      moved: trashed ? ids(trashed.moved) : [],
      skipped: trashed ? ids(trashed.skipped) : [],
      failed: trashed ? ids(trashed.failed) : [],
    },
    result,
  });
}

function retentionLine(ms: number | undefined, cutoff: Date): string {
  return ms
    ? `Older than: ${cutoff.toISOString()} (--older-than, all stores)`
    : `Retention defaults used: ${Object.entries(DEFAULT_RETENTION_DAYS)
        .map(([s, d]) => `${s} ${d}d`)
        .join(", ")}. --older-than overrides all of them.`;
}

export async function cleanCommand(
  options: CleanCommandOptions,
  io: Io = consoleIo,
): Promise<number> {
  const ms = options.olderThan ? parseAge(options.olderThan) : undefined;
  if (options.olderThan && !ms) {
    io.err(`Bad --older-than "${options.olderThan}": use 30d, 12h or 2w.`);
    return 2;
  }
  const root = options.root ?? getGlobalDirPath();
  const full = planClean(root, ms);
  const sessions = planSessions(
    full.entries.filter((e) => e.store === "sessions"),
    root,
  );
  const plan = withoutSessions(full);
  const apply = !!options.yes && !options.dryRun;
  const result = apply ? runClean(plan) : undefined;
  const trashed = apply ? await moveToTrash(sessions.toTrash) : undefined;
  const failed = (result?.failed.length ?? 0) + (trashed?.failed.length ?? 0);
  if (options.json) {
    io.out(jsonOf(plan, sessions, result, trashed));
    return failed ? 1 : 0;
  }
  io.out(`Global folder: ${root}`);
  io.out(retentionLine(ms, full.cutoff));
  for (const l of summarize(plan, sessions)) io.out(l);
  if (!result || !trashed) {
    io.out(
      `Dry run: nothing deleted or moved. ${plan.entries.length} file(s), ${plan.bytes} bytes would be deleted, and ${sessions.toTrash.length} session(s) moved to the trash. Run with --yes to do it.`,
    );
    if (sessions.toTrash.length) io.out(TRASH_RESTORE_LINE);
    io.out(CLEAN_NOTE);
    return 0;
  }
  io.out(
    `Deleted ${result.deletedFiles} file(s) of logs and dev_data, dropped ${result.droppedLines} line(s), ${result.bytes} bytes.${result.failed.length ? ` ${result.failed.length} failed.` : ""}`,
  );
  describeTrashResult(trashed, io);
  io.out(CLEAN_NOTE);
  return failed ? 1 : 0;
}

/** Adds `continuous clean` to the program. */
export function registerCleanCommand(program: Command): void {
  program
    .command("clean")
    .description(
      "Move this product's own sessions older than an age to the trash (restorable for 7 days, then removed for good) and delete its dev_data and logs older than an age; dry run unless --yes. Sessions open in a window or agent are left alone. Not secure erasure on SSDs. Never runs by itself. input_history.json and file:// data destinations are not touched",
    )
    .option(
      "--older-than <age>",
      "One age for every store: 30d, 12h, 2w. Default: sessions 30d, logs 14d, dev_data 90d",
    )
    .option("--dry-run", "List only (the default)")
    .option("--yes", "Move the sessions to the trash and delete the rest")
    .option("--json", "Machine-readable output")
    .action(async (options) => {
      await gracefulExit(await cleanCommand(options));
    });
}
