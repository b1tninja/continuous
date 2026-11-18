/**
 * `continuous sessions prune --older-than <age>` (V11): moves sessions last
 * used before the cut-off to the trash (core/util/sessionTrash.ts), where
 * each can be restored for 7 days with `continuous sessions restore <id>`.
 * Nothing is deleted here, and nothing runs by itself: retention is off by
 * default (decisions-2026-11-15), so this is the way to thin the list.
 *
 * It reports first, then asks (or takes `--yes`). A session open in another
 * window or a running agent (a lease in `sessions-open/`) is left alone, and
 * so is one that becomes open between the report and the move:
 * `HistoryManager.trash` checks the lease again and is never forced.
 * Prints ids, titles, dates and sizes, never contents.
 */
import fs from "node:fs";

import type { BaseSessionMetadata } from "core/index.js";
import { parseAge } from "core/util/cleanStores.js";
import historyManager from "core/util/history.js";
import { getSessionFilePath, getSessionLogFilePath } from "core/util/paths.js";
import type { Io } from "core/util/secretScan/secretsCli.js";
import { formatMegabytes } from "core/util/sessionCleanup/index.js";
import { openSessions } from "core/util/sessionLeases.js";
import { TRASH_KEEP_DAYS } from "core/util/sessionTrash.js";

import { question } from "../util/prompt.js";

export interface SessionsPruneOptions {
  olderThan?: string;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** The clock the age is measured against (tests). */
  now?: number;
  /** Asks the person; default a question on the terminal. */
  confirm?: (prompt: string) => Promise<boolean>;
  /** Whether there is a terminal to ask in; default stdin and stdout are TTYs. */
  interactive?: boolean;
}

export interface PruneCandidate {
  sessionId: string;
  title: string;
  /** Epoch ms of the last write to the session file. */
  lastUsed: number;
  bytes: number;
}

export interface PrunePlan {
  cutoff: number;
  /** Older than the cut-off and not open elsewhere: what would move. */
  candidates: PruneCandidate[];
  /** Older than the cut-off, but open in another running process. */
  open: (PruneCandidate & { pid: number; host: string })[];
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function statOf(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/** The last write to the session file, or its creation date; undefined when it has no file. */
function candidateOf(entry: BaseSessionMetadata): PruneCandidate | undefined {
  const st =
    statOf(getSessionLogFilePath(entry.sessionId)) ??
    statOf(getSessionFilePath(entry.sessionId));
  if (!st) return undefined;
  const created =
    Number(entry.dateCreated) || Date.parse(entry.dateCreated) || 0;
  return {
    sessionId: entry.sessionId,
    title: entry.title || "(untitled)",
    lastUsed: Math.max(st.mtimeMs, created),
    bytes: entry.fileBytes ?? st.size,
  };
}

/** Which listed sessions were last used before `now - olderThanMs`, oldest first. */
export function planPrune(olderThanMs: number, now: number): PrunePlan {
  const cutoff = now - olderThanMs;
  const leases = openSessions({ now, exceptPid: process.pid });
  const plan: PrunePlan = { cutoff, candidates: [], open: [] };
  for (const entry of historyManager.list({})) {
    const c = candidateOf(entry);
    if (!c || c.lastUsed >= cutoff) continue;
    const lease = leases.get(c.sessionId);
    if (lease) plan.open.push({ ...c, pid: lease.pid, host: lease.host });
    else plan.candidates.push(c);
  }
  plan.candidates.sort((a, b) => a.lastUsed - b.lastUsed);
  return plan;
}

/**
 * What happens to a trashed session, said the same way by prune and
 * `continuous clean`: restorable for 7 days, then removed for good.
 */
export const TRASH_RESTORE_LINE = `Each can be restored with continuous sessions restore <id> for ${TRASH_KEEP_DAYS} days (list them with continuous sessions trash); after that it is removed for good.`;

export interface TrashResult {
  moved: PruneCandidate[];
  /** Opened elsewhere since the report. */
  skipped: (PruneCandidate & { pid: number; host: string })[];
  failed: (PruneCandidate & { error: string })[];
}

/**
 * Moves each session to the trash with `HistoryManager.trash`, never
 * forced: one a running process opened since the report is left alone.
 */
export async function moveToTrash(
  candidates: PruneCandidate[],
): Promise<TrashResult> {
  const result: TrashResult = { moved: [], skipped: [], failed: [] };
  for (const c of candidates) {
    try {
      const done = await historyManager.trash(c.sessionId);
      if (done.status === "trashed") result.moved.push(c);
      else result.skipped.push({ ...c, pid: done.pid, host: done.host });
    } catch (error) {
      result.failed.push({
        ...c,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

function describePlan(plan: PrunePlan, age: string, io: Io): void {
  const total = plan.candidates.reduce((n, c) => n + c.bytes, 0);
  io.out(
    plan.candidates.length
      ? `${plan.candidates.length} session(s) last used before ${day(plan.cutoff)} (older than ${age}), ${formatMegabytes(total)}:`
      : `No session was last used before ${day(plan.cutoff)} (older than ${age}).`,
  );
  for (const c of plan.candidates) {
    io.out(
      `  ${c.sessionId}  ${c.title}  last used ${day(c.lastUsed)}, ${formatMegabytes(c.bytes)}`,
    );
  }
  if (plan.open.length) {
    io.out(
      `Left alone, open in another window or agent: ${plan.open.length} session(s):`,
    );
    for (const c of plan.open) {
      io.out(`  ${c.sessionId}  ${c.title}  (pid ${c.pid} on ${c.host})`);
    }
  }
}

/** The result lines of a move to the trash (prune and `continuous clean`). */
export function describeTrashResult(result: TrashResult, io: Io): void {
  const total = result.moved.reduce((n, c) => n + c.bytes, 0);
  io.out(
    `Moved ${result.moved.length} session(s) to the trash, ${formatMegabytes(total)}. ${TRASH_RESTORE_LINE}`,
  );
  for (const c of result.skipped) {
    io.out(
      `  Left alone: ${c.sessionId} was opened by pid ${c.pid} on ${c.host}`,
    );
  }
  for (const c of result.failed) {
    io.err(`  Not moved: ${c.sessionId}: ${c.error}`);
  }
}

async function askOnTerminal(prompt: string): Promise<boolean> {
  return /^y(es)?$/i.test((await question(prompt)).trim());
}

/** Whether to go ahead: `--yes`, or the person's answer. */
async function mayMove(
  options: SessionsPruneOptions,
  count: number,
  io: Io,
): Promise<boolean> {
  if (options.yes) return true;
  const interactive =
    options.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  if (!interactive) {
    io.out("Nothing moved. Run with --yes to move them to the trash.");
    return false;
  }
  const ask = options.confirm ?? askOnTerminal;
  io.out(
    `They go to the trash: each can be restored with continuous sessions restore <id> for ${TRASH_KEEP_DAYS} days, and is then removed for good.`,
  );
  if (await ask(`Move ${count} session(s) to the trash? [y/N] `)) return true;
  io.out("Nothing moved.");
  return false;
}

function jsonOf(
  plan: PrunePlan,
  age: string,
  result: TrashResult | undefined,
): string {
  const c = ({ sessionId, title, lastUsed, bytes }: PruneCandidate) => ({
    id: sessionId,
    title,
    lastUsed: new Date(lastUsed).toISOString(),
    bytes,
  });
  return JSON.stringify({
    olderThan: age,
    cutoff: new Date(plan.cutoff).toISOString(),
    applied: !!result,
    candidates: plan.candidates.map(c),
    open: plan.open.map((o) => ({ ...c(o), pid: o.pid, host: o.host })),
    moved: result?.moved.map(c) ?? [],
    skipped: result?.skipped.map((o) => ({ ...c(o), pid: o.pid })) ?? [],
    failed: result?.failed.map((f) => ({ ...c(f), error: f.error })) ?? [],
  });
}

/** Returns the exit code: 0, 1 when a move failed, 2 for a bad age. */
export async function sessionsPruneCommand(
  options: SessionsPruneOptions,
  io: Io = consoleIo,
): Promise<number> {
  const age = options.olderThan ?? "";
  const ms = parseAge(age);
  if (!ms) {
    io.err(`Bad --older-than "${age}": use 90d, 2w, 12h or a number of days.`);
    return 2;
  }
  const plan = planPrune(ms, options.now ?? Date.now());
  const apply =
    plan.candidates.length > 0 &&
    !options.dryRun &&
    // --json never asks: it moves with --yes only
    (options.json ? !!options.yes : true);
  if (options.json) {
    const result = apply ? await moveToTrash(plan.candidates) : undefined;
    io.out(jsonOf(plan, age, result));
    return result?.failed.length ? 1 : 0;
  }
  describePlan(plan, age, io);
  if (!plan.candidates.length) return 0;
  if (!apply) {
    io.out("Dry run: nothing moved.");
    return 0;
  }
  if (!(await mayMove(options, plan.candidates.length, io))) return 0;
  const result = await moveToTrash(plan.candidates);
  describeTrashResult(result, io);
  return result.failed.length ? 1 : 0;
}
