/**
 * Session leases (#868) with the append-only session log (#869): every save
 * to the log, the webview's mid-turn checkpoints (`history/saveDelta`)
 * included, records the session as open, so a cleanup run elsewhere leaves
 * it alone; and a turn that saves every few seconds does not rewrite the
 * lease file each time.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatHistoryItem, Session } from "../index.js";

import { HistoryManager } from "./history.js";
import {
  LEASE_REFRESH_MS,
  leaseDir,
  markSessionOpen,
  openSessions,
  resetOwnLease,
} from "./sessionLeases.js";

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}

function assistant(text: string): ChatHistoryItem {
  return { message: { role: "assistant", content: text }, contextItems: [] };
}

function session(history: ChatHistoryItem[]): Session {
  return {
    sessionId: uuidv4(),
    title: "t",
    workspaceDirectory: "/ws",
    history,
  };
}

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "session-leases-"));
  resetOwnLease();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  resetOwnLease();
});

function ownLeaseFile(): string {
  const dir = leaseDir(root);
  const [name] = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  return path.join(dir, name);
}

function recorded(): Record<string, number> {
  return JSON.parse(fs.readFileSync(ownLeaseFile(), "utf8")).sessions;
}

describe("markSessionOpen refresh", () => {
  it("does not rewrite the record for the newest session within the refresh interval", () => {
    const t0 = 1_000_000;
    markSessionOpen("a", { root, now: t0 });
    markSessionOpen("a", { root, now: t0 + 3_000 });
    markSessionOpen("a", { root, now: t0 + LEASE_REFRESH_MS - 1 });
    expect(recorded()).toEqual({ a: t0 });
  });

  it("rewrites it once the interval has passed", () => {
    const t0 = 1_000_000;
    markSessionOpen("a", { root, now: t0 });
    markSessionOpen("a", { root, now: t0 + LEASE_REFRESH_MS });
    expect(recorded()).toEqual({ a: t0 + LEASE_REFRESH_MS });
  });

  it("writes at once when another session becomes the newest", () => {
    const t0 = 1_000_000;
    markSessionOpen("a", { root, now: t0 });
    markSessionOpen("b", { root, now: t0 + 1_000 });
    markSessionOpen("a", { root, now: t0 + 2_000 });
    expect(recorded()).toEqual({ a: t0 + 2_000, b: t0 + 1_000 });
  });

  it("writes again when the record was deleted", () => {
    const t0 = 1_000_000;
    markSessionOpen("a", { root, now: t0 });
    fs.rmSync(ownLeaseFile());
    markSessionOpen("a", { root, now: t0 + 1_000 });
    expect(recorded()).toEqual({ a: t0 + 1_000 });
  });
});

describe("saves to the session log record the session as open", () => {
  // HistoryManager records leases under the global folder (the test one)
  function openNow(id: string): boolean {
    return openSessions().has(id);
  }

  it("a whole-session save to the log", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const s = session([user("q")]);
    m.save(s);
    await m.flush(s.sessionId);
    expect(openNow(s.sessionId)).toBe(true);
  });

  it("a mid-turn delta save makes its session the newest again", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const s = session([user("q")]);
    const { rev } = m.save(s);
    // Another session saved after it: s is no longer this process's newest
    const other = session([user("other")]);
    m.save(other);
    const before = openSessions().get(s.sessionId)!.at;

    const result = m.saveDelta({
      sessionId: s.sessionId,
      baseRev: rev!,
      length: 2,
      items: [{ index: 1, item: assistant("partial") }],
      meta: { title: s.title, workspaceDirectory: s.workspaceDirectory },
    });
    expect(result.needFull).toBeFalsy();
    await m.flush();
    const lease = openSessions().get(s.sessionId)!;
    expect(lease.at).toBeGreaterThanOrEqual(before);
    const own = [...openSessions().values()].filter(
      (l) => l.pid === process.pid,
    );
    const newest = Math.max(...own.map((l) => l.at));
    expect(lease.at).toBe(newest);
  });
});
