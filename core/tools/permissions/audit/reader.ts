import fs from "node:fs";
import path from "node:path";
import {
  AUDIT_VERSION,
  type AuditAgent,
  type AuditRecord,
  type DecisionEvent,
  type OutcomeEvent,
} from "./record";
import { modernizeLevelText } from "../policy";
import { readAuditFile } from "./writer";

/**
 * Reading the audit directory back (plans/reviewer-audit.md, P12d): the files
 * `AuditWriter` wrote, joined into one row per call, and the prune the
 * retention setting asks for.
 */
export interface AuditFileInfo {
  file: string;
  /** yyyy-mm */
  month: string;
  session: string;
  index: number;
  bytes: number;
  mtimeMs: number;
}

const FILE_RE = /^(.*?)(?:\.(\d+))?\.jsonl$/;

/** Every audit file under `dir`, oldest month first, a session's parts in order. */
export function listAuditFiles(dir: string): AuditFileInfo[] {
  const out: AuditFileInfo[] = [];
  let months: string[];
  try {
    months = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const month of months.filter((m) => /^\d{4}-\d{2}$/.test(m)).sort()) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, month));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const file = path.join(dir, month, name);
      try {
        const st = fs.statSync(file);
        out.push({
          file,
          month,
          session: m[1],
          index: m[2] ? Number(m[2]) : 0,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.month.localeCompare(b.month) ||
      a.session.localeCompare(b.session) ||
      a.index - b.index,
  );
}

/** All records of one session, across months and rotated parts, in order. */
export function readAuditSession(dir: string, session: string): AuditRecord[] {
  return listAuditFiles(dir)
    .filter((f) => f.session === session)
    .flatMap((f) => readAuditFile(f.file));
}

export interface AuditCallRow {
  session: string;
  callId: string;
  tool: string;
  /** Time of the first decision */
  ts: string;
  /** The final decision: the person's answer or the reviewer's, when there was one */
  policy: DecisionEvent["policy"];
  by: DecisionEvent["by"];
  /** An earlier decision for the call was an ask */
  asked: boolean;
  source?: string;
  rule?: string;
  reason?: string;
  reviewerModel?: string;
  argsMasked: string;
  /** Which agent made the call; absent for a record that predates it */
  agent?: AuditAgent;
  ran?: boolean;
  exit?: number;
  durMs?: number;
  decisions: DecisionEvent[];
  outcome?: OutcomeEvent;
}

/**
 * Entries written by 2.14.x say `yolo` and "set to YOLO". The file keeps what
 * was written; readers show the current name.
 */
function displaySource(source: string | undefined): string | undefined {
  return source === "yolo" ? "idgaf" : source;
}

function displayReason(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : modernizeLevelText(reason);
}

/** One row per call, from a session's records. An outcome with no decision is skipped. */
export function callRows(records: readonly AuditRecord[]): AuditCallRow[] {
  const byCall = new Map<string, AuditCallRow>();
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  for (const r of ordered) {
    if (r.ev === "decision") {
      const row = byCall.get(r.callId);
      if (!row) {
        byCall.set(r.callId, {
          session: r.session,
          callId: r.callId,
          tool: r.tool,
          ts: r.ts,
          policy: r.policy,
          by: r.by,
          asked: r.policy === "ask",
          source: displaySource(r.source),
          rule: r.rule,
          reason: displayReason(r.reason),
          reviewerModel: r.reviewer?.model,
          argsMasked: r.argsMasked,
          ...(r.agent ? { agent: r.agent } : {}),
          decisions: [r],
        });
      } else {
        row.asked ||= row.policy === "ask";
        row.policy = r.policy;
        row.by = r.by;
        row.source = displaySource(r.source) ?? row.source;
        row.rule = r.rule ?? row.rule;
        row.reason = displayReason(r.reason) ?? row.reason;
        row.reviewerModel = r.reviewer?.model ?? row.reviewerModel;
        row.decisions.push(r);
      }
    } else if (r.ev === "outcome") {
      const row = byCall.get(r.callId);
      if (!row) continue;
      row.outcome = r;
      row.ran = r.ran;
      row.exit = r.exit;
      row.durMs = r.durMs;
    }
  }
  return [...byCall.values()];
}

export interface AuditFilter {
  session?: string;
  /** allow, ask, deny, or reviewer */
  decision?: string;
  tool?: string;
  /** An agent's role, id or kind ("Explore", "sub-call_1", "loop-worker") */
  agent?: string;
  /** Inclusive, ISO date or timestamp */
  since?: string;
  /** Inclusive, ISO date or timestamp; a bare date covers that whole day */
  until?: string;
}

export const DECISION_FILTERS = ["allow", "ask", "deny", "reviewer"] as const;

function endOfDay(until: string): number {
  const t = Date.parse(until);
  return /^\d{4}-\d{2}-\d{2}$/.test(until) ? t + 24 * 3600 * 1000 - 1 : t;
}

export function matchesFilter(row: AuditCallRow, f: AuditFilter): boolean {
  if (f.session && row.session !== f.session) return false;
  if (f.tool && row.tool !== f.tool) return false;
  if (f.agent) {
    const a = row.agent;
    if (!a || (a.role !== f.agent && a.id !== f.agent && a.kind !== f.agent)) {
      return false;
    }
  }
  if (f.decision) {
    const d = f.decision;
    const hit =
      d === "reviewer"
        ? row.decisions.some((x) => x.by === "reviewer")
        : d === "ask"
          ? row.asked || row.policy === "ask"
          : row.policy === d;
    if (!hit) return false;
  }
  const t = Date.parse(row.ts);
  if (f.since && t < Date.parse(f.since)) return false;
  if (f.until && t > endOfDay(f.until)) return false;
  return true;
}

/**
 * Rows of the directory (or one session) that pass the filter, oldest first.
 * The read is bounded (see bounded.ts): by default the last 90 days, at most
 * 32 MB and 100,000 records, newest first.
 */
export function listCalls(
  dir: string,
  f: AuditFilter = {},
  limits: ReadLimits = {},
): AuditCallRow[] {
  return listCallsBounded(dir, f, limits).rows;
}

export interface PruneResult {
  deleted: string[];
  bytes: number;
}

/** Delete whole files last written more than `retentionDays` ago, and empty month folders. */
export function pruneAudit(
  dir: string,
  opts: { retentionDays: number; now?: Date; dryRun?: boolean },
): PruneResult {
  const cutoff =
    (opts.now ?? new Date()).getTime() - opts.retentionDays * 24 * 3600 * 1000;
  const deleted: string[] = [];
  let bytes = 0;
  for (const f of listAuditFiles(dir)) {
    if (f.mtimeMs >= cutoff) continue;
    try {
      if (!opts.dryRun) fs.unlinkSync(f.file);
      deleted.push(f.file);
      bytes += f.bytes;
    } catch {
      // in use or already gone
    }
  }
  if (!opts.dryRun) {
    for (const monthDir of new Set(deleted.map((d) => path.dirname(d)))) {
      try {
        fs.rmdirSync(monthDir);
      } catch {
        // not empty
      }
    }
  }
  return { deleted, bytes };
}

/**
 * A bounded read of the audit directory (ROADMAP B27): the cost of a read is
 * set by the limits, never by how much the directory holds. A 1 GB trail must
 * not hang `continuous audit suggest` or the Permissions page.
 *
 * - Files older than `maxAgeDays` are not opened (their mtime says when they
 *   were last written, so a stat is enough).
 * - Newest files are read first, and reading stops at `maxBytes`. A file larger
 *   than what is left is read from its tail, so what is dropped is the oldest.
 * - At most `maxRows` records are kept, newest first.
 * - Lines are read in chunks, never the whole file as one string.
 *
 * A call whose records were split across two rotated parts, or cut by a limit,
 * joins with what was read; the stats say a limit was hit so the caller can
 * say the figures are partial.
 */
export interface ReadLimits {
  /** Bytes of audit files to read in all; the oldest part is dropped first */
  maxBytes?: number;
  /** Skip files last written longer ago than this */
  maxAgeDays?: number;
  /** Records to keep */
  maxRows?: number;
  now?: Date;
}

export const DEFAULT_READ_LIMITS = {
  maxBytes: 32 * 1024 * 1024,
  maxAgeDays: 90,
  maxRows: 100_000,
} as const;

export interface ReadStats {
  filesSeen: number;
  filesRead: number;
  filesSkippedByAge: number;
  bytesRead: number;
  records: number;
  /** The limit that cut the read short, when one did */
  truncatedBy?: "bytes" | "rows";
}

const CHUNK = 1024 * 1024;
/** Cheap test before JSON.parse: a decision or outcome line, the only ones joined into rows. */
const CALL_EVENT = /"ev":"(?:decision|outcome)"/;

/**
 * Call `onLine` for each complete line of `file` from byte `start`, in chunks.
 * `onLine` returns false to stop. Returns the bytes read.
 */
export function forEachLine(
  file: string,
  start: number,
  onLine: (line: string) => boolean | void,
): number {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  let read = 0;
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry: Buffer = Buffer.alloc(0);
    let position = start;
    // Starting inside a file: the first line is a fragment and is dropped
    let dropFirst = start > 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, position);
      if (n <= 0) break;
      position += n;
      read += n;
      let data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, n)])
        : Buffer.from(buf.subarray(0, n));
      let nl = data.lastIndexOf(10);
      if (nl < 0) {
        carry = data;
        continue;
      }
      carry = Buffer.from(data.subarray(nl + 1));
      data = data.subarray(0, nl);
      let from = 0;
      for (;;) {
        const next = data.indexOf(10, from);
        const end = next < 0 ? data.length : next;
        if (dropFirst) dropFirst = false;
        else if (onLine(data.toString("utf8", from, end)) === false) {
          return read;
        }
        if (next < 0) break;
        from = next + 1;
      }
    }
    if (carry.length && !dropFirst) onLine(carry.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
  return read;
}

function parseLine(line: string): AuditRecord | undefined {
  if (!CALL_EVENT.test(line)) return undefined;
  try {
    const rec = JSON.parse(line);
    return rec && typeof rec === "object" && rec.v === AUDIT_VERSION
      ? (rec as AuditRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Decision and outcome records of the directory, within the limits, grouped by session. */
export function readCallRecordsBounded(
  dir: string,
  limits: ReadLimits = {},
  sessionOnly?: string,
): { bySession: Map<string, AuditRecord[]>; stats: ReadStats } {
  const maxBytes = limits.maxBytes ?? DEFAULT_READ_LIMITS.maxBytes;
  const maxRows = limits.maxRows ?? DEFAULT_READ_LIMITS.maxRows;
  const maxAgeDays = limits.maxAgeDays ?? DEFAULT_READ_LIMITS.maxAgeDays;
  const cutoff = (limits.now ?? new Date()).getTime() - maxAgeDays * 86_400_000;
  const stats: ReadStats = {
    filesSeen: 0,
    filesRead: 0,
    filesSkippedByAge: 0,
    bytesRead: 0,
    records: 0,
  };
  const bySession = new Map<string, AuditRecord[]>();
  const files = listAuditFiles(dir)
    .filter((f) => !sessionOnly || f.session === sessionOnly)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  stats.filesSeen = files.length;
  for (const f of files) {
    if (f.mtimeMs < cutoff) {
      stats.filesSkippedByAge++;
      continue;
    }
    const left = maxBytes - stats.bytesRead;
    if (left <= 0) {
      stats.truncatedBy = "bytes";
      break;
    }
    const start = f.bytes > left ? f.bytes - left : 0;
    if (start > 0) stats.truncatedBy = "bytes";
    stats.filesRead++;
    const kept: AuditRecord[] = [];
    stats.bytesRead += forEachLine(f.file, start, (line) => {
      const rec = parseLine(line);
      if (!rec) return true;
      kept.push(rec);
      if (stats.records + kept.length >= maxRows) {
        stats.truncatedBy = "rows";
        return false;
      }
      return true;
    });
    stats.records += kept.length;
    const list = bySession.get(f.session) ?? [];
    list.push(...kept);
    bySession.set(f.session, list);
    if (stats.truncatedBy === "rows") break;
  }
  return { bySession, stats };
}

/** The joined rows of the directory within the limits, oldest first, with what was read. */
export function listCallsBounded(
  dir: string,
  filter: AuditFilter = {},
  limits: ReadLimits = {},
): { rows: AuditCallRow[]; stats: ReadStats } {
  // An explicit --since is honoured even when it is older than the default age
  const sinceMs = filter.since ? Date.parse(filter.since) : NaN;
  const sinceDays = Number.isNaN(sinceMs)
    ? 0
    : Math.ceil(((limits.now ?? new Date()).getTime() - sinceMs) / 86_400_000);
  const { bySession, stats } = readCallRecordsBounded(
    dir,
    {
      ...limits,
      maxAgeDays: Math.max(
        limits.maxAgeDays ?? DEFAULT_READ_LIMITS.maxAgeDays,
        sinceDays,
      ),
    },
    filter.session,
  );
  const rows = [...bySession.values()]
    .flatMap((records) => callRows(records))
    .filter((row) => matchesFilter(row, filter))
    .sort(
      (a, b) => a.ts.localeCompare(b.ts) || a.session.localeCompare(b.session),
    );
  return { rows, stats };
}

/** A change to the permission settings or rules, as `continuous audit changes` lists it. */
export interface AuditChangeRow {
  ts: string;
  session: string;
  /** "setting", "policy" or "taint": the record's own `ev` */
  ev: string;
  /** What changed: a kind such as `level`, or `rule` for a rule edit; an unknown kind shows as written */
  kind: string;
  /** The surface: cli-policy, flag, gui-settings, file, cli-command, or a rule edit's source */
  source: string;
  summary: string;
  loosens: boolean;
}

function changeRow(r: AuditRecord): AuditChangeRow | undefined {
  const rec = r as unknown as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  if (r.ev === "setting") {
    const arrow =
      rec.from !== undefined || rec.to !== undefined
        ? `: ${str(rec.from) ?? "-"} -> ${str(rec.to) ?? "-"}`
        : "";
    const how = rec.confirmed ? ` (confirmed: ${String(rec.confirmed)})` : "";
    return {
      ts: r.ts,
      session: r.session,
      ev: r.ev,
      kind: str(rec.kind) ?? "unknown",
      source: str(rec.source) ?? "unknown",
      summary: `${str(rec.op) ?? "set"} ${str(rec.name) ?? "?"}${arrow}${how}`,
      loosens: rec.loosens === true,
    };
  }
  if (r.ev === "taint") {
    const why = str(rec.reason) ? ` (${str(rec.reason)})` : "";
    return {
      ts: r.ts,
      session: r.session,
      ev: r.ev,
      kind: "taint",
      source: str(rec.source) ?? "unknown",
      summary: `${str(rec.op) ?? "change"} ${str(rec.label) ?? "?"}${why}`,
      // A clear lets calls run unasked that asked before
      loosens: rec.op === "clear",
    };
  }
  if (r.ev === "policy") {
    return {
      ts: r.ts,
      session: r.session,
      ev: r.ev,
      kind: "rule",
      source: str(rec.source) ?? "unknown",
      summary:
        `${str(rec.op) ?? "change"} ${str(rec.decision) ?? ""} ${str(rec.rule) ?? ""}`.trim(),
      loosens: rec.loosens === true,
    };
  }
  return undefined;
}

/**
 * Setting and rule changes, and taint labels added and cleared, across all
 * sessions, oldest first. Records of a
 * kind this reader does not know are skipped by the `ev` check, the way every
 * reader here skips them; a `setting` record with a kind it does not know is
 * listed with that kind as written.
 */
export function listChanges(
  dir: string,
  filter: { since?: string; until?: string } = {},
): AuditChangeRow[] {
  const since = filter.since ? Date.parse(filter.since) : undefined;
  const until = filter.until ? endOfDay(filter.until) : undefined;
  const rows: AuditChangeRow[] = [];
  for (const f of listAuditFiles(dir)) {
    for (const r of readAuditFile(f.file)) {
      const row = changeRow(r);
      if (!row) continue;
      const t = Date.parse(row.ts);
      if (since !== undefined && t < since) continue;
      if (until !== undefined && t > until) continue;
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.ts.localeCompare(b.ts));
}
