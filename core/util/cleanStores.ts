/**
 * Retention for the product's own persisted files (ROADMAP X15). Node only.
 *
 * `planClean` lists what is older than a cutoff under the global folder and
 * `runClean` deletes it. Only three stores are touched: `sessions/*.json`
 * and `sessions/*.jsonl` (with the session's `sessions/<id>/` folder of blobs),
 * `dev_data/` jsonl files (by the `timestamp` of each line) and `logs/`.
 * Nothing outside the global folder is ever touched, symbolic links are
 * skipped, and neither function returns file contents: only counts, sizes
 * and paths.
 *
 * Deleting a file does not guarantee the bytes are gone: SSDs remap blocks,
 * and journals, snapshots and backups keep copies.
 */
import fs from "node:fs";
import path from "node:path";

export const DAY_MS = 86_400_000;
/** Used when no age is given: sessions 30 days, logs 14, dev_data 90. */
export const DEFAULT_RETENTION_DAYS = {
  sessions: 30,
  logs: 14,
  dev_data: 90,
} as const;

export type StoreName = "sessions" | "dev_data" | "logs";

export interface CleanEntry {
  store: StoreName;
  file: string;
  bytes: number;
  /** "file": delete it. "lines": drop `lines` old lines from this jsonl. */
  action: "file" | "lines";
  lines?: number;
}

export interface CleanPlan {
  root: string;
  /** The oldest cutoff of any store, for display. */
  cutoff: Date;
  /** Cutoff per store, as epoch ms. */
  cutoffs: Record<StoreName, number>;
  entries: CleanEntry[];
  /** Bytes of whole files to delete, plus bytes of dropped lines. */
  bytes: number;
  skipped: string[];
}

/** `30d`, `12h`, `2w` or a bare number of days. */
export function parseAge(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([hdw]?)$/.exec(text.trim());
  if (!m) return undefined;
  const unit = { h: DAY_MS / 24, d: DAY_MS, w: 7 * DAY_MS }[m[2] || "d"]!;
  const ms = Number(m[1]) * unit;
  return ms > 0 ? ms : undefined;
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function* walk(dir: string, skipped: string[]): Generator<string> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) skipped.push(p);
    else if (st.isDirectory()) yield* walk(p, skipped);
    else if (st.isFile()) yield p;
  }
}

function lineTime(line: string): number | undefined {
  try {
    const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
    const t =
      typeof ts === "string" || typeof ts === "number" ? +new Date(ts) : NaN;
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

/** Count and size the lines of a jsonl file older than `cutoffMs`. Unparseable lines are kept. */
function oldLines(file: string, cutoffMs: number) {
  let old = 0;
  let oldBytes = 0;
  let kept = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const t = lineTime(line);
    if (t !== undefined && t < cutoffMs) {
      old++;
      oldBytes += Buffer.byteLength(line) + 1;
    } else kept++;
  }
  return { old, oldBytes, kept };
}

const STORES: [StoreName, (f: string) => boolean][] = [
  [
    "sessions",
    // A session's own file. Blobs under `sessions/<id>/` are written once and
    // never touched again, so they are not aged on their own: they go with
    // the session file that refers to them.
    (f) =>
      path.basename(path.dirname(f)) === "sessions" &&
      (f.endsWith(".json") || f.endsWith(".jsonl")) &&
      path.basename(f) !== "sessions.json",
  ],
  ["dev_data", (f) => f.endsWith(".jsonl")],
  ["logs", () => true],
];

function entryFor(
  store: StoreName,
  file: string,
  cutoffMs: number,
): CleanEntry | undefined {
  const st = fs.statSync(file);
  if (store !== "dev_data") {
    if (st.mtimeMs >= cutoffMs) return undefined;
    const bytes =
      st.size + (store === "sessions" ? folderBytes(sessionFolder(file)) : 0);
    return { store, file, bytes, action: "file" };
  }
  const { old, oldBytes, kept } = oldLines(file, cutoffMs);
  if (!old) return undefined;
  return kept
    ? { store, file, bytes: oldBytes, action: "lines", lines: old }
    : { store, file, bytes: st.size, action: "file", lines: old };
}

/** `sessions/<id>/`, the folder of a session file's blobs. */
function sessionFolder(file: string): string {
  return path.join(path.dirname(file), sessionIdOf(file));
}

function sessionIdOf(file: string): string {
  return path.basename(file).replace(/\.jsonl?$/, "");
}

/** Bytes of the regular files under `dir` (symbolic links not followed). */
function folderBytes(dir: string): number {
  let total = 0;
  for (const f of walk(dir, [])) {
    try {
      total += fs.lstatSync(f).size;
    } catch {
      // gone meanwhile
    }
  }
  return total;
}

/** One age for every store (a number), or the per-store defaults (undefined). */
export function planClean(
  root: string,
  olderThanMs?: number,
  now = Date.now(),
): CleanPlan {
  const cutoffs = Object.fromEntries(
    STORES.map(([s]) => [
      s,
      now - (olderThanMs ?? DEFAULT_RETENTION_DAYS[s] * DAY_MS),
    ]),
  ) as Record<StoreName, number>;
  const plan: CleanPlan = {
    root,
    cutoff: new Date(Math.min(...Object.values(cutoffs))),
    cutoffs,
    entries: [],
    bytes: 0,
    skipped: [],
  };
  for (const [store, wanted] of STORES) {
    for (const file of walk(path.join(root, store), plan.skipped)) {
      if (!inside(root, file) || !wanted(file)) continue;
      const e = entryFor(store, file, cutoffs[store]);
      if (!e) continue;
      plan.entries.push(e);
      plan.bytes += e.bytes;
    }
  }
  return plan;
}

function dropOldLines(file: string, cutoffMs: number): void {
  const kept = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => {
      if (!l) return false;
      const t = lineTime(l);
      return t === undefined || t >= cutoffMs;
    });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept.map((l) => `${l}\n`).join(""), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Deletes a session's blob folder once neither of its files is left. Only a
 * real folder inside the root: a symbolic link there is left alone.
 */
function removeSessionFolder(root: string, file: string): void {
  const id = sessionIdOf(file);
  const dir = path.dirname(file);
  if (
    fs.existsSync(path.join(dir, `${id}.json`)) ||
    fs.existsSync(path.join(dir, `${id}.jsonl`))
  ) {
    return;
  }
  const folder = sessionFolder(file);
  try {
    if (!inside(root, folder) || !fs.lstatSync(folder).isDirectory()) return;
  } catch {
    return;
  }
  fs.rmSync(folder, { recursive: true, force: true });
}

/** Forget deleted session files in sessions.json, if it parses as a list. */
function pruneSessionsList(root: string, deleted: Set<string>): void {
  const list = path.join(root, "sessions", "sessions.json");
  try {
    const items = JSON.parse(fs.readFileSync(list, "utf8"));
    if (!Array.isArray(items)) return;
    const next = items.filter((i) => !deleted.has(String(i?.sessionId)));
    if (next.length !== items.length) {
      fs.writeFileSync(list, JSON.stringify(next, undefined, 2), {
        mode: 0o600,
      });
    }
  } catch {
    // no list, or one the product rebuilds from the session files
  }
}

export interface CleanResult {
  deletedFiles: number;
  droppedLines: number;
  bytes: number;
  failed: string[];
}

/** Do what `plan` says. Re-checks every path is inside `plan.root`. */
export function runClean(plan: CleanPlan): CleanResult {
  const result: CleanResult = {
    deletedFiles: 0,
    droppedLines: 0,
    bytes: 0,
    failed: [],
  };
  const deletedSessions = new Set<string>();
  for (const e of plan.entries) {
    if (!inside(plan.root, e.file)) {
      result.failed.push(e.file);
      continue;
    }
    try {
      if (e.action === "file") {
        fs.unlinkSync(e.file);
        result.deletedFiles++;
        if (e.store === "sessions") {
          deletedSessions.add(sessionIdOf(e.file));
          removeSessionFolder(plan.root, e.file);
        }
      } else {
        dropOldLines(e.file, plan.cutoffs[e.store]);
      }
      result.droppedLines += e.lines ?? 0;
      result.bytes += e.bytes;
    } catch {
      result.failed.push(e.file);
    }
  }
  if (deletedSessions.size) pruneSessionsList(plan.root, deletedSessions);
  return result;
}
