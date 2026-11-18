import fs from "node:fs";
import path from "node:path";
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
} from "../../../util/privateFiles";

/**
 * The shadow reviewer's spend ledger (ROADMAP B68): one small file in the audit
 * directory that every process (the CLI, each IDE window) reserves against
 * BEFORE it makes a shadow call and settles after, so the dollar cap holds
 * across processes instead of being read once per process from the trail.
 *
 * Layout: `shadow-spend.jsonl`, append-only lines, folded on read:
 *
 *   {"t":"day","d":"2026-11-11","usd":0.04,"n":7}      settled, one per day
 *   {"t":"res","id":"..","at":ms,"usd":0.01,"call":"..","model":".."}
 *   {"t":"set","id":"..","at":ms,"usd":0.0073}          the real cost
 *   {"t":"rel","id":".."}                               nothing was spent
 *
 * Only amounts, a model id and the call id: no tool arguments, no text.
 *
 * Writers take `shadow-spend.lock`, created with O_EXCL (atomic on every
 * platform, no dependency). The critical section is a read of a file of a few
 * kilobytes and one append, so a lock older than `lockStaleMs` belongs to a
 * process that died and is taken over. Readers never lock: appends are single
 * short writes and compaction replaces the file by rename.
 *
 * A reservation whose process died is not forgotten: after `reservationTtlMs`
 * it counts as spent at the reserved estimate (a crash mid-call most likely
 * billed). Spend ages out after `retentionDays`, like the trail it replaces.
 */
export const LEDGER_FILE = "shadow-spend.jsonl";
export const LOCK_FILE = "shadow-spend.lock";

const DAY_MS = 24 * 3600 * 1000;
const COMPACT_AFTER_LINES = 120;

export interface LedgerOptions {
  dir: string;
  now?: () => number;
  /** Settled spend older than this is forgotten (the trail's retention) */
  retentionDays?: number;
  /** A reservation with no settle after this long is counted as spent */
  reservationTtlMs?: number;
  /** A lock older than this is a dead process's */
  lockStaleMs?: number;
  /** How long a writer waits for the lock before giving up */
  lockWaitMs?: number;
  /** Spend already in the retained audit trail, read once when no ledger exists */
  seed?: () => { usd: number; reviews: number };
  pid?: number;
}

export interface Reservation {
  id: string;
  usd: number;
}

export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "over-budget" | "unavailable" };

export interface LedgerSummary {
  /** Settled, plus reservations whose process never settled them */
  spentUsd: number;
  /** In flight right now, in any process */
  reservedUsd: number;
  reviews: number;
}

interface Folded {
  days: Map<string, { usd: number; n: number }>;
  open: Map<string, { at: number; usd: number }>;
  lines: number;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cents = (n: number) => Math.round(n * 1e9) / 1e9;

function finiteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export class SpendLedger {
  readonly file: string;
  private readonly lock: string;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly ttl: number;
  private readonly lockStale: number;
  private readonly lockWait: number;
  private readonly pid: number;
  private counter = 0;

  constructor(private readonly opts: LedgerOptions) {
    this.file = path.join(opts.dir, LEDGER_FILE);
    this.lock = path.join(opts.dir, LOCK_FILE);
    this.now = opts.now ?? Date.now;
    this.retentionMs = (opts.retentionDays ?? 30) * DAY_MS;
    this.ttl = opts.reservationTtlMs ?? 2 * 60_000;
    this.lockStale = opts.lockStaleMs ?? 10_000;
    this.lockWait = opts.lockWaitMs ?? 5_000;
    this.pid = opts.pid ?? process.pid;
  }

  /**
   * Reserve `estimateUsd` for one call. Granted only while settled spend,
   * every live reservation and this one fit under `capUsd`. Fails closed: a
   * ledger that cannot be read or locked grants nothing.
   */
  async reserve(input: {
    callId: string;
    model?: string;
    estimateUsd: number;
    capUsd: number;
  }): Promise<ReserveResult> {
    if (
      !finiteNonNegative(input.estimateUsd) ||
      !finiteNonNegative(input.capUsd)
    ) {
      return { ok: false, reason: "unavailable" };
    }
    try {
      return await this.locked(() => {
        const now = this.now();
        const folded = this.read(now);
        const sum = this.sum(folded, now);
        // One call is always allowed to start from nothing, however small the cap
        const estimate = Math.min(input.estimateUsd, input.capUsd);
        if (sum.spentUsd + sum.reservedUsd + estimate > input.capUsd) {
          return { ok: false as const, reason: "over-budget" as const };
        }
        const id = `${this.pid}-${now.toString(36)}-${(this.counter++).toString(36)}`;
        // Before the new line: compaction writes what was read, so a line
        // appended first would be dropped
        this.compactIfLong(folded, now);
        this.append({
          t: "res",
          id,
          at: now,
          usd: cents(estimate),
          call: input.callId,
          ...(input.model ? { model: input.model } : {}),
        });
        return { ok: true as const, reservation: { id, usd: estimate } };
      });
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * Replace a reservation with what the call cost. Never throws: a settle that
   * cannot be written leaves the reservation to expire into spent at the
   * estimate, which errs toward the cap.
   */
  async settle(reservation: Reservation, actualUsd: number): Promise<void> {
    if (!finiteNonNegative(actualUsd)) return;
    await this.tryLocked(() => {
      this.append({
        t: "set",
        id: reservation.id,
        at: this.now(),
        usd: cents(actualUsd),
      });
    });
  }

  /** Nothing was spent (the request never went out): give the reservation back. */
  async release(reservation: Reservation): Promise<void> {
    await this.tryLocked(() => {
      this.append({ t: "rel", id: reservation.id });
    });
  }

  /** Spent, in flight and the number of reviews. One small file read, no lock. */
  summary(): LedgerSummary {
    try {
      const now = this.now();
      return this.sum(this.read(now), now);
    } catch {
      return { spentUsd: 0, reservedUsd: 0, reviews: 0 };
    }
  }

  /**
   * Write the audit trail's retained spend into a ledger that does not exist
   * yet, once, so the cap keeps counting what was spent before the ledger.
   */
  async ensureSeeded(): Promise<void> {
    if (!this.opts.seed || fs.existsSync(this.file)) return;
    // Taking the lock seeds a missing file
    await this.tryLocked(() => undefined);
  }

  private async tryLocked(fn: () => void): Promise<void> {
    try {
      await this.locked(async () => fn());
    } catch {
      // best effort, see settle
    }
  }

  // The seed is read inside the lock on the first reserve too
  private async locked<T>(fn: () => T | Promise<T>): Promise<T> {
    ensurePrivateDir(this.opts.dir);
    const release = await this.acquire();
    try {
      this.seedIfMissing();
      return await fn();
    } finally {
      release();
    }
  }

  private seedIfMissing(): void {
    if (!this.opts.seed || fs.existsSync(this.file)) return;
    const seed = this.opts.seed();
    const line = {
      t: "day",
      d: dayOf(this.now()),
      usd: cents(Math.max(0, seed.usd)),
      n: Math.max(0, Math.floor(seed.reviews)),
    };
    this.writeFile(`${JSON.stringify(line)}\n`);
  }

  private async acquire(): Promise<() => void> {
    const started = Date.now();
    const token = `${this.pid}:${started}:${Math.random().toString(36).slice(2)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = fs.openSync(this.lock, "wx", PRIVATE_FILE_MODE);
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        return () => {
          try {
            if (fs.readFileSync(this.lock, "utf8") === token) {
              fs.unlinkSync(this.lock);
            }
          } catch {
            // already taken over as stale
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      this.takeOverIfStale();
      if (Date.now() - started > this.lockWait) throw new Error("lock busy");
      await sleep(Math.min(5 + attempt * 2, 25));
    }
  }

  /**
   * A lock whose file has not changed for `lockStaleMs` is a dead process's.
   * The file is renamed away (one taker wins the rename) and removed.
   */
  private takeOverIfStale(): void {
    try {
      const age = Date.now() - fs.statSync(this.lock).mtimeMs;
      if (age <= this.lockStale) return;
      const aside = `${this.lock}.stale.${this.pid}.${this.counter++}`;
      fs.renameSync(this.lock, aside);
      fs.rmSync(aside, { force: true });
    } catch {
      // someone else took it over first, or it was released
    }
  }

  private append(entry: Record<string, unknown>): void {
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, {
      mode: PRIVATE_FILE_MODE,
    });
  }

  private writeFile(text: string): void {
    const tmp = `${this.file}.${this.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: PRIVATE_FILE_MODE });
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  private read(now: number): Folded {
    const folded: Folded = { days: new Map(), open: new Map(), lines: 0 };
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return folded;
    }
    const addDay = (at: number, usd: number, n: number) => {
      const d = dayOf(at);
      const cur = folded.days.get(d) ?? { usd: 0, n: 0 };
      folded.days.set(d, { usd: cur.usd + usd, n: cur.n + n });
    };
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      let e: any;
      try {
        e = JSON.parse(raw);
      } catch {
        continue; // a torn last line is skipped, not fatal
      }
      folded.lines++;
      if (
        e.t === "day" &&
        typeof e.d === "string" &&
        finiteNonNegative(e.usd)
      ) {
        const cur = folded.days.get(e.d) ?? { usd: 0, n: 0 };
        folded.days.set(e.d, {
          usd: cur.usd + e.usd,
          n: cur.n + (finiteNonNegative(e.n) ? e.n : 0),
        });
      } else if (
        e.t === "res" &&
        finiteNonNegative(e.at) &&
        finiteNonNegative(e.usd)
      ) {
        folded.open.set(String(e.id), { at: e.at, usd: e.usd });
      } else if (e.t === "set" && finiteNonNegative(e.usd)) {
        const open = folded.open.get(String(e.id));
        if (open) {
          folded.open.delete(String(e.id));
          addDay(open.at, e.usd, 1);
        }
      } else if (e.t === "rel") {
        folded.open.delete(String(e.id));
      }
    }
    // A reservation nobody settled in time was most likely billed
    for (const [id, r] of folded.open) {
      if (now - r.at > this.ttl) {
        folded.open.delete(id);
        addDay(r.at, r.usd, 1);
      }
    }
    return folded;
  }

  private sum(folded: Folded, now: number): LedgerSummary {
    const cutoff = dayOf(now - this.retentionMs);
    let spentUsd = 0;
    let reviews = 0;
    for (const [d, v] of folded.days) {
      if (d < cutoff) continue;
      spentUsd += v.usd;
      reviews += v.n;
    }
    let reservedUsd = 0;
    for (const r of folded.open.values()) reservedUsd += r.usd;
    return {
      spentUsd: cents(spentUsd),
      reservedUsd: cents(reservedUsd),
      reviews,
    };
  }

  /** Fold settled lines into day totals so the file stays a few kilobytes. */
  private compactIfLong(folded: Folded, now: number): void {
    if (folded.lines < COMPACT_AFTER_LINES) return;
    try {
      const cutoff = dayOf(now - this.retentionMs);
      const lines: string[] = [];
      for (const [d, v] of [...folded.days].sort(([a], [b]) =>
        a < b ? -1 : 1,
      )) {
        if (d < cutoff) continue;
        lines.push(JSON.stringify({ t: "day", d, usd: cents(v.usd), n: v.n }));
      }
      for (const [id, r] of folded.open) {
        lines.push(JSON.stringify({ t: "res", id, at: r.at, usd: r.usd }));
      }
      this.writeFile(`${lines.join("\n")}\n`);
    } catch {
      // the long file is still correct, only larger
    }
  }
}

/** One ledger per audit directory in this process. */
const shared = new Map<string, SpendLedger>();

export function sharedLedger(
  dir: string,
  seed?: LedgerOptions["seed"],
): SpendLedger {
  let l = shared.get(dir);
  if (!l) {
    l = new SpendLedger({ dir, seed });
    shared.set(dir, l);
  }
  return l;
}
