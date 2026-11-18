import fs from "node:fs";
import path from "node:path";
import { maskDeep } from "./mask";
import { AUDIT_VERSION, type AuditDraft, type AuditRecord } from "./record";

/**
 * The audit writer (plans/reviewer-audit.md, section 6): an append-only JSON
 * lines file per session and month under a directory the caller chooses.
 *
 * - One line per record, written with a single append, so a crash loses at most
 *   the last line, and `readAuditFile` skips a torn final line.
 * - `write` never throws and never blocks a tool call: it returns the failure.
 * - Strings are masked once more on the way out (masking is idempotent), so a
 *   caller that forgot to mask still cannot put a recognised credential in the
 *   file.
 * - A file that reaches `maxFileBytes` is not rewritten: the next record goes
 *   to `<session>.1.jsonl`, then `.2`, and `seq` keeps counting.
 * - Whole files are the unit of retention; nothing is edited in place.
 */
export interface AuditWriterOptions {
  /** The audit directory; files go under `<dir>/<yyyy-mm>/` */
  dir: string;
  maxFileBytes?: number;
  now?: () => Date;
  /** fsync outcomes and denials (default true); off for tests that count syscalls */
  syncImportant?: boolean;
}

export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export type WriteResult =
  { ok: true; file: string; seq: number } | { ok: false; error: string };

interface FileState {
  month: string;
  index: number;
  seq: number;
  size: number;
}

/** A session id becomes a file name: anything but `[A-Za-z0-9._-]` is replaced. */
export function safeSessionName(session: string): string {
  const name = session.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return name.length > 0 ? name.slice(0, 120) : "_";
}

function fileName(session: string, index: number): string {
  const base = safeSessionName(session);
  return index === 0 ? `${base}.jsonl` : `${base}.${index}.jsonl`;
}

function monthOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The records of one file, in order. A torn or unreadable line is skipped. */
export function readAuditFile(file: string): AuditRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === "object" && rec.v === AUDIT_VERSION) {
        out.push(rec as AuditRecord);
      }
    } catch {
      // a line cut short by a crash
    }
  }
  return out;
}

/** The last `seq` in a file, and whether it ends without a newline. */
function inspectTail(file: string): {
  seq: number;
  torn: boolean;
  size: number;
} {
  const size = fs.statSync(file).size;
  if (size === 0) return { seq: 0, torn: false, size };
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const tail = buf.toString("utf8");
    const torn = !tail.endsWith("\n");
    const lines = tail.split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (typeof rec?.seq === "number") return { seq: rec.seq, torn, size };
      } catch {
        // skip a torn line and look one earlier
      }
    }
    return { seq: 0, torn, size };
  } finally {
    fs.closeSync(fd);
  }
}

export class AuditWriter {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly syncImportant: boolean;
  private readonly sessions = new Map<string, FileState>();

  constructor(opts: AuditWriterOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.now = opts.now ?? (() => new Date());
    this.syncImportant = opts.syncImportant ?? true;
  }

  /** The path a session's current file would have, without creating it. */
  pathFor(session: string, month = monthOf(this.now()), index = 0): string {
    return path.join(this.dir, month, fileName(session, index));
  }

  write(draft: AuditDraft): WriteResult {
    try {
      return this.append(draft);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private open(session: string, month: string): FileState {
    const known = this.sessions.get(session);
    if (known && known.month === month) return known;

    // A new process, or a new month: find the newest file for this session.
    const monthDir = path.join(this.dir, month);
    fs.mkdirSync(monthDir, { recursive: true, mode: 0o700 });
    let index = 0;
    while (fs.existsSync(path.join(monthDir, fileName(session, index + 1)))) {
      index++;
    }
    const file = path.join(monthDir, fileName(session, index));
    let seq = known?.seq ?? 0;
    let size = 0;
    if (fs.existsSync(file)) {
      const tail = inspectTail(file);
      seq = Math.max(seq, tail.seq);
      size = tail.size;
      if (tail.torn) {
        // Close the line a crash cut short, so the next record starts clean.
        fs.appendFileSync(file, "\n");
        size += 1;
      }
    }
    const state = { month, index, seq, size };
    this.sessions.set(session, state);
    return state;
  }

  private append(draft: AuditDraft): WriteResult {
    const when = draft.ts ? new Date(draft.ts) : this.now();
    const month = monthOf(Number.isNaN(when.getTime()) ? this.now() : when);
    const state = this.open(draft.session, month);

    const seq = state.seq + 1;
    const record = maskDeep({
      ...draft,
      v: AUDIT_VERSION,
      ts: draft.ts ?? when.toISOString(),
      seq,
    }) as AuditRecord;
    // keep the envelope fields where a reader expects them
    const { v, ev, ts, session, seq: n, ...body } = record;
    const line = `${JSON.stringify({ v, ev, ts, session, seq: n, ...body })}\n`;
    const bytes = Buffer.byteLength(line, "utf8");

    if (state.size > 0 && state.size + bytes > this.maxBytes) {
      state.index += 1;
      state.size = 0;
    }
    const file = path.join(
      this.dir,
      month,
      fileName(draft.session, state.index),
    );
    const important =
      record.ev === "outcome" ||
      record.ev === "policy" ||
      record.ev === "setting" ||
      (record.ev === "taint" && record.op === "clear") ||
      (record.ev === "decision" && record.policy === "deny");
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeSync(fd, line);
      if (important && this.syncImportant) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    state.seq = seq;
    state.size += bytes;
    return { ok: true, file, seq };
  }
}
