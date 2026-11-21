import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditCallDetail, auditListPage } from "./listing";
import { decisionDraft, outcomeDraft } from "./record";
import { AuditWriter } from "./writer";

/**
 * How a command ended, through the real audit path: written, read back and
 * listed. A command that exits has a code. One a signal ended has no code but
 * has the signal, and one the time limit ended says so.
 */
let dir: string;
const NOW = new Date("2026-11-11T12:00:00Z");
const at = (minutesAgo: number) =>
  new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ending-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(
  id: string,
  ending: {
    exit?: number;
    signal?: string;
    timedOut?: true;
    error?: string;
  },
  minutesAgo: number,
) {
  const w = new AuditWriter({ dir, now: () => NOW });
  w.write({
    ...decisionDraft({
      session: "s1",
      callId: id,
      tool: "runTerminalCommand",
      args: "npm test",
      policy: "allow",
      by: "rules",
    }),
    ts: at(minutesAgo),
  });
  w.write({
    ...outcomeDraft({
      session: "s1",
      callId: id,
      tool: "runTerminalCommand",
      ran: true,
      output: "out",
      ...ending,
    }),
    ts: at(minutesAgo - 1),
  });
}

/** The lines the writer saved, parsed. */
function saved(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        for (const l of fs.readFileSync(p, "utf8").split("\n")) {
          if (l.trim()) out.push(JSON.parse(l));
        }
      }
    }
  };
  walk(dir);
  return out;
}

const outcomeOf = (id: string) =>
  saved().find((r) => r.ev === "outcome" && r.callId === id)!;

describe("the outcome of a command, as written", () => {
  it("a clean exit has its code and nothing about signals", () => {
    record("a", { exit: 0 }, 10);
    const o = outcomeOf("a");
    expect(o.exit).toBe(0);
    expect("signal" in o).toBe(false);
    expect("timedOut" in o).toBe(false);
  });

  it("a command ended by a signal has the signal and no exit code", () => {
    record("b", { signal: "SIGKILL", error: "Killed" }, 10);
    const o = outcomeOf("b");
    expect(o.signal).toBe("SIGKILL");
    expect("exit" in o).toBe(false);
    expect(typeof o.errSig).toBe("string");
  });

  it("a command the time limit ended says so", () => {
    record("c", { signal: "SIGTERM", timedOut: true, error: "timed out" }, 10);
    const o = outcomeOf("c");
    expect(o.timedOut).toBe(true);
    expect(o.signal).toBe("SIGTERM");
    expect("exit" in o).toBe(false);
  });

  it("a code and a signal together are both kept", () => {
    record("d", { exit: 143, signal: "SIGTERM" }, 10);
    const o = outcomeOf("d");
    expect(o.exit).toBe(143);
    expect(o.signal).toBe("SIGTERM");
  });

  it("an old outcome with none of the new fields still reads", () => {
    record("e", { exit: 1, error: "boom" }, 10);
    const o = outcomeOf("e");
    expect(o.exit).toBe(1);
    expect("signal" in o).toBe(false);
  });
});

describe("the outcome of a command, as listed", () => {
  it("a row carries the signal and the time-out", () => {
    record("t1", { signal: "SIGTERM", timedOut: true, error: "timed out" }, 30);
    const row = auditListPage(dir, { limit: 10 }).rows.find(
      (r) => r.callId === "t1",
    )!;
    expect(row.signal).toBe("SIGTERM");
    expect(row.timedOut).toBe(true);
    expect(row.exit).toBeUndefined();
    expect(row.ran).toBe(true);
  });

  it("a row for a normal exit carries only the code", () => {
    record("t2", { exit: 3, error: "boom" }, 20);
    const row = auditListPage(dir, { limit: 10 }).rows.find(
      (r) => r.callId === "t2",
    )!;
    expect(row.exit).toBe(3);
    expect(row.signal).toBeUndefined();
    expect(row.timedOut).toBeUndefined();
  });

  it("the call's detail carries them too", () => {
    record("t3", { signal: "SIGKILL", error: "Killed" }, 15);
    const detail = auditCallDetail(dir, { session: "s1", callId: "t3" });
    expect(detail?.outcome?.signal).toBe("SIGKILL");
    expect(detail?.outcome?.exit).toBeUndefined();
    expect(detail?.outcome?.errSig).toBeDefined();
  });

  it("lists commands that ended in different ways side by side", () => {
    record("m1", { exit: 0 }, 40);
    record("m2", { exit: 1, error: "bad" }, 30);
    record("m3", { signal: "SIGKILL", error: "Killed" }, 20);
    record("m4", { signal: "SIGTERM", timedOut: true, error: "timed out" }, 10);
    const rows = auditListPage(dir, { limit: 10 }).rows;
    const by = Object.fromEntries(rows.map((r) => [r.callId, r]));
    expect(by.m1.exit).toBe(0);
    expect(by.m2.exit).toBe(1);
    expect(by.m3.signal).toBe("SIGKILL");
    expect(by.m4.timedOut).toBe(true);
  });
});
