import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, writePrivate } from "../../../util/privateFiles";
import {
  EMPTY_DAY,
  IDGAF_OBJECTION_KEY,
  keysOfEvent,
  type DayCounts,
  type EventKeys,
} from "./auditIndexKeys";
import { listAuditFiles, type AuditFileInfo } from "./reader";
import { AUDIT_VERSION, type DecisionEvent } from "./record";

/**
 * The incremental index of the audit trail (ROADMAP B75): a small derived file
 * in the audit directory that holds, per rule text and per call shape and per
 * day, how many times a call asked, was allowed, was denied, who answered, and
 * when it was last seen. The Permissions page reads this file instead of the
 * trail, so its cost does not grow with the trail.
 *
 * Built incrementally. For every audit file the index remembers its size, its
 * mtime, a hash of its first bytes and the byte offset up to which it has been
 * read (always just after a newline). A run reads only the bytes after that
 * offset. If a file is smaller than it was, or its first bytes changed, it was
 * rotated or replaced: the index is thrown away and built again from scratch.
 *
 * Derived data, so it is safe to lose. It is written to a temporary file in the
 * same folder and renamed over the index (owner-only, like the trail). When
 * two processes update at once, each writes a whole, self-consistent file (its
 * counts and its offsets are in the same file) and the last rename wins; the
 * other's work is read again by the next run. Nothing is ever counted twice,
 * because counts and offsets are replaced together.
 *
 * Only masked keys are stored (see auditIndexKeys.ts). The file is capped at
 * MAX_INDEX_BYTES: the keys seen longest ago are dropped first.
 */
export const INDEX_FILE = "audit-index.json";
export const INDEX_VERSION = 1;
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** Day buckets older than this are dropped */
export const KEEP_DAYS = 90;
/** Bytes of the trail one run reads; the rest is read by the next run */
export const RUN_BYTES = 16 * 1024 * 1024;

const DAY_MS = 86_400_000;
const CHUNK = 1024 * 1024;
const HEAD_BYTES = 64;
const DECISION_EVENT = /"ev":"decision"/;

export interface IndexedFile {
  size: number;
  mtimeMs: number;
  /** Hash of the first bytes, once the file has that many; empty before */
  head: string;
  /** Bytes consumed: the position just after the last complete line read */
  offset: number;
}

export interface IndexKey {
  /** Last time seen, ISO */
  last: string;
  days: Record<string, DayCounts>;
}

export interface AuditIndex {
  v: typeof INDEX_VERSION;
  updatedAt: string;
  /** Earliest day with an event in the index */
  since?: string;
  /** False until every file has been read to its end */
  complete: boolean;
  /** Keys were dropped to keep the file under its cap */
  trimmed?: boolean;
  /** By path relative to the audit directory */
  files: Record<string, IndexedFile>;
  rules: Record<string, IndexKey>;
  calls: Record<string, IndexKey>;
}

export interface IndexRunStats {
  bytesRead: number;
  filesRead: number;
  rebuilt: boolean;
  wrote: boolean;
}

export const indexPath = (dir: string) => path.join(dir, INDEX_FILE);

export function emptyIndex(now: Date = new Date()): AuditIndex {
  return {
    v: INDEX_VERSION,
    updatedAt: now.toISOString(),
    complete: false,
    files: {},
    rules: {},
    calls: {},
  };
}

/** The index as stored, or undefined when it is missing, unreadable or of another version. */
export function readIndex(dir: string): AuditIndex | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(dir), "utf8"));
    if (
      raw?.v === INDEX_VERSION &&
      raw.files &&
      raw.rules &&
      raw.calls &&
      typeof raw.files === "object"
    ) {
      return raw as AuditIndex;
    }
  } catch {
    // missing or damaged: a derived file, built again
  }
  return undefined;
}

function headOf(file: string, size: number): string {
  if (size < HEAD_BYTES) return "";
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Call `onLine` for each complete line from `start`, reading at most
 * `maxBytes`. Returns the offset just after the last complete line, so the
 * next run begins on a line. A final line with no newline yet is left alone.
 */
export function readLinesFrom(
  file: string,
  start: number,
  maxBytes: number,
  onLine: (line: string) => void,
): { offset: number; bytes: number } {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { offset: start, bytes: 0 };
  }
  let position = start;
  let offset = start;
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry: Buffer = Buffer.alloc(0);
    while (position - start < maxBytes) {
      const want = Math.min(CHUNK, maxBytes - (position - start));
      const n = fs.readSync(fd, buf, 0, want, position);
      if (n <= 0) break;
      position += n;
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, n)])
        : Buffer.from(buf.subarray(0, n));
      const nl = data.lastIndexOf(10);
      if (nl < 0) {
        carry = data;
        continue;
      }
      let from = 0;
      for (;;) {
        const next = data.indexOf(10, from);
        if (next < 0 || next > nl) break;
        onLine(data.toString("utf8", from, next));
        from = next + 1;
      }
      offset = position - (data.length - (nl + 1));
      carry = Buffer.from(data.subarray(nl + 1));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { offset, bytes: position - start };
}

function bump(
  map: Record<string, IndexKey>,
  key: string,
  day: string,
  ts: string,
  counts: DayCounts,
): void {
  const k = (map[key] ??= { last: ts, days: {} });
  if (ts > k.last) k.last = ts;
  const d = (k.days[day] ??= EMPTY_DAY());
  for (let i = 0; i < d.length; i++) d[i] += counts[i];
}

function apply(index: AuditIndex, ts: string, keys: EventKeys): void {
  if (!index.since || keys.day < index.since) index.since = keys.day;
  if (keys.ruleKey) bump(index.rules, keys.ruleKey, keys.day, ts, keys.counts);
  if (keys.idgafObjected) {
    const one = EMPTY_DAY();
    one[1] = 1;
    bump(index.rules, IDGAF_OBJECTION_KEY, keys.day, ts, one);
  }
  if (keys.callKey && keys.callCounts) {
    bump(index.calls, keys.callKey, keys.day, ts, keys.callCounts);
  }
}

function parseDecision(line: string): DecisionEvent | undefined {
  if (!DECISION_EVENT.test(line)) return undefined;
  try {
    const rec = JSON.parse(line);
    return rec?.v === AUDIT_VERSION && rec.ev === "decision"
      ? (rec as DecisionEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Was any file replaced or shortened since the index last read it? */
function needsRebuild(
  index: AuditIndex,
  files: AuditFileInfo[],
  dir: string,
): boolean {
  for (const f of files) {
    const prior = index.files[path.relative(dir, f.file)];
    if (!prior) continue;
    if (f.bytes < prior.size || f.bytes < prior.offset) return true;
    if (prior.head && headOf(f.file, f.bytes) !== prior.head) return true;
  }
  return false;
}

function prune(index: AuditIndex, now: Date, existing: Set<string>): void {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  for (const map of [index.rules, index.calls]) {
    for (const [key, v] of Object.entries(map)) {
      for (const day of Object.keys(v.days)) {
        if (day < cutoff) delete v.days[day];
      }
      if (Object.keys(v.days).length === 0) delete map[key];
    }
  }
  for (const rel of Object.keys(index.files)) {
    if (!existing.has(rel)) delete index.files[rel];
  }
}

/** Drop the keys seen longest ago until the file fits under the cap. */
function fit(index: AuditIndex): string {
  let text = JSON.stringify(index);
  while (text.length > MAX_INDEX_BYTES) {
    index.trimmed = true;
    const all = [
      ...Object.entries(index.rules).map(([k, v]) => ["rules", k, v.last]),
      ...Object.entries(index.calls).map(([k, v]) => ["calls", k, v.last]),
    ].sort((a, b) => a[2].localeCompare(b[2]));
    if (all.length === 0) break;
    for (const [map, key] of all.slice(0, Math.ceil(all.length * 0.1))) {
      delete (map === "rules" ? index.rules : index.calls)[key];
    }
    text = JSON.stringify(index);
  }
  return text;
}

/** Write-temp-then-rename, owner-only. A failed write leaves the old index. */
export function writeIndex(dir: string, index: AuditIndex): boolean {
  const target = indexPath(dir);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    ensurePrivateDir(dir);
    writePrivate(tmp, fit(index));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    return false;
  }
}

/**
 * Read what was appended to the audit files since the last run and fold it
 * into the index, then save it. `maxBytes` bounds the work of one run; when it
 * is hit the index says `complete: false` and the next run goes on.
 */
export function updateIndex(
  dir: string,
  opts: { now?: Date; maxBytes?: number; write?: boolean } = {},
): { index: AuditIndex; stats: IndexRunStats } {
  const now = opts.now ?? new Date();
  const budget = opts.maxBytes ?? RUN_BYTES;
  const cutoff = now.getTime() - KEEP_DAYS * DAY_MS;
  const listed = listAuditFiles(dir);
  const stored = readIndex(dir);
  let index = stored ?? emptyIndex(now);
  const stats: IndexRunStats = {
    bytesRead: 0,
    filesRead: 0,
    rebuilt: false,
    wrote: false,
  };
  if (needsRebuild(index, listed, dir)) {
    index = emptyIndex(now);
    stats.rebuilt = true;
  }
  const cache = new Map<string, string>();
  let complete = true;
  // Newest first, so a limited run covers what the page shows first
  const files = listed
    .filter((f) => f.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    const rel = path.relative(dir, f.file);
    const prior = index.files[rel];
    if (prior && f.bytes === prior.offset) {
      prior.size = f.bytes;
      prior.mtimeMs = f.mtimeMs;
      continue;
    }
    const left = budget - stats.bytesRead;
    if (left <= 0) {
      complete = false;
      continue;
    }
    const got = readLinesFrom(f.file, prior?.offset ?? 0, left, (line) => {
      const ev = parseDecision(line);
      const keys = ev && keysOfEvent(ev, cache);
      if (ev && keys) apply(index, ev.ts, keys);
    });
    stats.bytesRead += got.bytes;
    stats.filesRead++;
    if (got.bytes >= left && got.offset < f.bytes) complete = false;
    index.files[rel] = {
      size: f.bytes,
      mtimeMs: f.mtimeMs,
      head: headOf(f.file, f.bytes),
      offset: got.offset,
    };
  }
  index.complete = complete;
  index.updatedAt = now.toISOString();
  prune(index, now, new Set(listed.map((f) => path.relative(dir, f.file))));
  // No trail and no index: nothing to remember, and no folder to create
  if (opts.write !== false && (stored || listed.length > 0))
    stats.wrote = writeIndex(dir, index);
  return { index, stats };
}
