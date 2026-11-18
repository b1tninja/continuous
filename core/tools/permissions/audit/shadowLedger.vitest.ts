import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEDGER_FILE, LOCK_FILE, SpendLedger } from "./shadowLedger";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-ledger-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-11T12:00:00Z");
const file = () => path.join(dir, LEDGER_FILE);

describe("SpendLedger", () => {
  it("reserves, settles and sums", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    const r = await l.reserve({
      callId: "c1",
      estimateUsd: 0.01,
      capUsd: 0.05,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(l.summary()).toMatchObject({ reservedUsd: 0.01, spentUsd: 0 });
    await l.settle(r.reservation, 0.004);
    expect(l.summary()).toEqual({
      spentUsd: 0.004,
      reservedUsd: 0,
      reviews: 1,
    });
  });

  it("refuses a reservation that would pass the cap, counting live reservations", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    const a = await l.reserve({ callId: "a", estimateUsd: 0.03, capUsd: 0.05 });
    const b = await l.reserve({ callId: "b", estimateUsd: 0.03, capUsd: 0.05 });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, reason: "over-budget" });
    if (a.ok) await l.release(a.reservation);
    const c = await l.reserve({ callId: "c", estimateUsd: 0.03, capUsd: 0.05 });
    expect(c.ok).toBe(true);
  });

  it("lets one call start under a cap smaller than the estimate", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    const r = await l.reserve({
      callId: "a",
      estimateUsd: 0.01,
      capUsd: 0.002,
    });
    expect(r.ok).toBe(true);
  });

  it("holds the cap with two processes hammering one directory", async () => {
    const cap = 0.1;
    const price = 0.007;
    const procs = [1, 2].map(
      (pid) => new SpendLedger({ dir, pid, now: () => T0 }),
    );
    let granted = 0;
    let maxSeen = 0;
    const work = async (l: SpendLedger, who: number) => {
      for (let i = 0; i < 30; i++) {
        const r = await l.reserve({
          callId: `${who}-${i}`,
          estimateUsd: price,
          capUsd: cap,
        });
        if (!r.ok) continue;
        granted++;
        // In flight: never more than the cap, whoever else is reserving
        const s = l.summary();
        maxSeen = Math.max(maxSeen, s.spentUsd + s.reservedUsd);
        await l.settle(r.reservation, price);
      }
    };
    await Promise.all([
      work(procs[0], 1),
      work(procs[1], 2),
      work(procs[0], 3),
    ]);
    const total = procs[0].summary();
    expect(total.spentUsd).toBeLessThanOrEqual(cap + 1e-9);
    expect(maxSeen).toBeLessThanOrEqual(cap + 1e-9);
    expect(total.reviews).toBe(granted);
    expect(granted).toBe(Math.floor(cap / price));
    expect(total.reservedUsd).toBe(0);
  });

  it("never lets in-flight reservations of several processes pass the cap", async () => {
    const ls = [1, 2, 3].map(
      (pid) => new SpendLedger({ dir, pid, now: () => T0 }),
    );
    const results = await Promise.all(
      ls.map((l) => l.reserve({ callId: "x", estimateUsd: 0.04, capUsd: 0.1 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("counts a reservation whose process died as spent once it expires", async () => {
    let now = T0;
    const l = new SpendLedger({
      dir,
      now: () => now,
      reservationTtlMs: 60_000,
    });
    const r = await l.reserve({ callId: "a", estimateUsd: 0.02, capUsd: 1 });
    expect(r.ok).toBe(true);
    now = T0 + 30_000;
    expect(l.summary()).toMatchObject({ reservedUsd: 0.02, spentUsd: 0 });
    now = T0 + 61_000;
    expect(l.summary()).toEqual({ spentUsd: 0.02, reservedUsd: 0, reviews: 1 });
  });

  it("takes over a lock left by a dead process", async () => {
    const lock = path.join(dir, LOCK_FILE);
    fs.writeFileSync(lock, "999:0:dead");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const l = new SpendLedger({ dir, now: () => T0, lockStaleMs: 1000 });
    const r = await l.reserve({ callId: "a", estimateUsd: 0.01, capUsd: 1 });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("fails closed when the lock is held and fresh", async () => {
    fs.writeFileSync(path.join(dir, LOCK_FILE), "999:0:alive");
    const l = new SpendLedger({ dir, now: () => T0, lockWaitMs: 60 });
    const r = await l.reserve({ callId: "a", estimateUsd: 0.01, capUsd: 1 });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
  });

  it("fails closed for a cap or estimate that is not a usable number", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    for (const [estimateUsd, capUsd] of [
      [Number.NaN, 1],
      [0.01, Number.POSITIVE_INFINITY],
      [-1, 1],
    ]) {
      expect(await l.reserve({ callId: "a", estimateUsd, capUsd })).toEqual({
        ok: false,
        reason: "unavailable",
      });
    }
  });

  it("skips a torn line and keeps the rest", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    const r = await l.reserve({ callId: "a", estimateUsd: 0.01, capUsd: 1 });
    if (r.ok) await l.settle(r.reservation, 0.01);
    fs.appendFileSync(file(), '{"t":"set","id":"zz","usd":');
    expect(l.summary().spentUsd).toBe(0.01);
  });

  it("forgets spend older than the retention window", async () => {
    let now = T0;
    const l = new SpendLedger({ dir, now: () => now, retentionDays: 30 });
    const r = await l.reserve({ callId: "a", estimateUsd: 0.01, capUsd: 1 });
    if (r.ok) await l.settle(r.reservation, 0.01);
    now = T0 + 29 * 24 * 3600 * 1000;
    expect(l.summary().spentUsd).toBe(0.01);
    now = T0 + 32 * 24 * 3600 * 1000;
    expect(l.summary()).toEqual({ spentUsd: 0, reservedUsd: 0, reviews: 0 });
  });

  it("compacts a long file to day totals without losing spend or open reservations", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    for (let i = 0; i < 70; i++) {
      const r = await l.reserve({
        callId: `c${i}`,
        estimateUsd: 0.001,
        capUsd: 10,
      });
      if (r.ok) await l.settle(r.reservation, 0.002);
    }
    const open = await l.reserve({
      callId: "open",
      estimateUsd: 0.5,
      capUsd: 10,
    });
    expect(open.ok).toBe(true);
    const lines = fs.readFileSync(file(), "utf8").trim().split("\n");
    expect(lines.length).toBeLessThan(130);
    const s = l.summary();
    expect(s.spentUsd).toBeCloseTo(0.14, 9);
    expect(s.reviews).toBe(70);
    expect(s.reservedUsd).toBe(0.5);
  });

  it("starts from the retained trail spend once, when no ledger exists", async () => {
    let reads = 0;
    const seed = () => {
      reads++;
      return { usd: 0.12, reviews: 5 };
    };
    const l = new SpendLedger({ dir, now: () => T0, seed });
    await l.ensureSeeded();
    const r = await l.reserve({
      callId: "a",
      estimateUsd: 0.01,
      capUsd: 0.125,
    });
    expect(r).toEqual({ ok: false, reason: "over-budget" });
    const again = new SpendLedger({ dir, now: () => T0, seed });
    await again.reserve({ callId: "b", estimateUsd: 0.001, capUsd: 1 });
    expect(reads).toBe(1);
    expect(l.summary()).toMatchObject({ spentUsd: 0.12, reviews: 5 });
  });

  it("holds only amounts, a model id and the call id, owner-only", async () => {
    const l = new SpendLedger({ dir, now: () => T0 });
    const r = await l.reserve({
      callId: "call-1",
      model: "claude-haiku-4-5",
      estimateUsd: 0.01,
      capUsd: 1,
    });
    if (r.ok) await l.settle(r.reservation, 0.003);
    const text = fs.readFileSync(file(), "utf8");
    for (const line of text.trim().split("\n")) {
      for (const k of Object.keys(JSON.parse(line))) {
        expect(["t", "id", "at", "usd", "call", "model", "d", "n"]).toContain(
          k,
        );
      }
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(file()).mode & 0o077).toBe(0);
    }
  });
});
