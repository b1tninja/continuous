/**
 * The session trash (NI10): a delete moves a session, its blobs included,
 * beside `sessions/`; it can be restored for 7 days and is removed lazily
 * after that. A session open in another process is not moved without
 * `force`, and cleanup never sees a trashed session as live.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatHistoryItem, Session } from "../index.js";
import { HistoryManager } from "./history.js";
import {
  getGlobalDirPath,
  getSessionBlobFolderPath,
  getSessionFilePath,
  getSessionLogFilePath,
} from "./paths.js";
import { BLOB_THRESHOLD_CHARS } from "./sessionBlobs.js";
import { applyCleanup, scanForCleanup } from "./sessionCleanup/index.js";
import { leaseDir, markSessionOpen, resetOwnLease } from "./sessionLeases.js";
import {
  deleteFromTrash,
  emptyTrash,
  isSafeSessionId,
  listTrash,
  moveSessionToTrash,
  purgeExpiredTrash,
  restoreSessionFromTrash,
  TRASH_KEEP_MS,
  trashDir,
} from "./sessionTrash.js";

const NOW = Date.UTC(2026, 10, 14, 12);
const meta = (id: string, title = "A chat") => ({
  sessionId: id,
  title,
  dateCreated: String(NOW - 60_000),
  workspaceDirectory: "file:///ws",
  messageCount: 1,
});

describe("sessionTrash on a folder", () => {
  let root: string;
  const sessions = () => path.join(root, "sessions");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "session-trash-"));
    fs.mkdirSync(sessions());
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function writeLog(id: string): void {
    fs.writeFileSync(path.join(sessions(), `${id}.jsonl`), '{"t":"header"}\n');
    fs.mkdirSync(path.join(sessions(), id, "blobs"), { recursive: true });
    fs.writeFileSync(path.join(sessions(), id, "blobs", "a".repeat(64)), "x");
  }

  it("moves a .jsonl with its blob folder and restores both", () => {
    writeLog("s1");
    const t = moveSessionToTrash("s1", meta("s1"), { root, now: NOW });
    expect(t.deletedAt).toBe(NOW);
    expect(t.purgeAfter).toBe(NOW + TRASH_KEEP_MS);
    expect(t.bytes).toBeGreaterThan(0);
    expect(fs.readdirSync(sessions())).toEqual([]);
    expect(
      fs.existsSync(
        path.join(trashDir(root), "s1", "files", "s1", "blobs", "a".repeat(64)),
      ),
    ).toBe(true);
    expect(listTrash({ root, now: NOW }).map((e) => e.metadata.title)).toEqual([
      "A chat",
    ]);

    const back = restoreSessionFromTrash("s1", { root });
    expect(back.metadata.sessionId).toBe("s1");
    expect(fs.existsSync(path.join(sessions(), "s1.jsonl"))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(sessions(), "s1", "blobs", "a".repeat(64)),
        "utf8",
      ),
    ).toBe("x");
    expect(listTrash({ root, now: NOW })).toEqual([]);
  });

  it("moves and restores a .json session", () => {
    fs.writeFileSync(path.join(sessions(), "s2.json"), "{}");
    moveSessionToTrash("s2", meta("s2"), { root, now: NOW });
    expect(fs.existsSync(path.join(sessions(), "s2.json"))).toBe(false);
    restoreSessionFromTrash("s2", { root });
    expect(fs.readFileSync(path.join(sessions(), "s2.json"), "utf8")).toBe(
      "{}",
    );
  });

  it("keeps a session for 7 days and removes it after", () => {
    writeLog("s3");
    moveSessionToTrash("s3", meta("s3"), { root, now: NOW });
    expect(
      purgeExpiredTrash({ root, now: NOW + TRASH_KEEP_MS - 1 }).removed,
    ).toEqual([]);
    expect(listTrash({ root, now: NOW + TRASH_KEEP_MS - 1 })).toHaveLength(1);
    // Read lazily: listing after the 7 days removes it
    expect(listTrash({ root, now: NOW + TRASH_KEEP_MS })).toEqual([]);
    expect(fs.existsSync(path.join(trashDir(root), "s3"))).toBe(false);
  });

  it("does not restore over a session that exists again", () => {
    fs.writeFileSync(path.join(sessions(), "s4.json"), '{"old":1}');
    moveSessionToTrash("s4", meta("s4"), { root, now: NOW });
    fs.writeFileSync(path.join(sessions(), "s4.json"), '{"new":1}');
    expect(() => restoreSessionFromTrash("s4", { root })).toThrow(
      /exists again/,
    );
    expect(fs.readFileSync(path.join(sessions(), "s4.json"), "utf8")).toBe(
      '{"new":1}',
    );
    expect(listTrash({ root, now: NOW })).toHaveLength(1);
  });

  it("deletes one entry or the whole trash for good", () => {
    fs.writeFileSync(path.join(sessions(), "a.json"), "{}");
    fs.writeFileSync(path.join(sessions(), "b.json"), "{}");
    moveSessionToTrash("a", meta("a"), { root, now: NOW });
    moveSessionToTrash("b", meta("b"), { root, now: NOW + 1 });
    expect(listTrash({ root, now: NOW }).map((e) => e.sessionId)).toEqual([
      "b",
      "a",
    ]);
    expect(deleteFromTrash("a", { root })).toBe(true);
    expect(deleteFromTrash("a", { root })).toBe(false);
    expect(emptyTrash({ root })).toBe(1);
    expect(listTrash({ root, now: NOW })).toEqual([]);
  });

  it("refuses ids that are not one path segment", () => {
    expect(isSafeSessionId("../etc")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
    expect(isSafeSessionId(uuidv4())).toBe(true);
    expect(() => moveSessionToTrash("..", meta(".."), { root })).toThrow();
  });

  it("is not seen by cleanup, which removes expired entries", async () => {
    writeLog("gone");
    moveSessionToTrash("gone", meta("gone"), { root, now: NOW });
    const scan = await scanForCleanup({
      root,
      now: NOW,
      stores: ["sessions"],
      open: new Map(),
    });
    expect(scan.sessionFilesScanned).toBe(0);
    expect(scan.blobs).toEqual([]);
    expect(scan.skipped).toEqual([]);

    const kept = await applyCleanup(scan, { now: NOW, open: new Map() });
    expect(kept.trash).toBeUndefined();
    expect(listTrash({ root, now: NOW })).toHaveLength(1);

    const later = NOW + TRASH_KEEP_MS + 1;
    const result = await applyCleanup(
      await scanForCleanup({
        root,
        now: later,
        stores: ["sessions"],
        open: new Map(),
      }),
      { now: later, open: new Map() },
    );
    expect(result.trash).toEqual({ purged: 1, bytes: expect.any(Number) });
    expect(fs.existsSync(path.join(trashDir(root), "gone"))).toBe(false);
  });
});

function user(text: string): ChatHistoryItem {
  return { message: { role: "user", content: text }, contextItems: [] };
}
function assistant(text: string): ChatHistoryItem {
  return { message: { role: "assistant", content: text }, contextItems: [] };
}
function session(history: ChatHistoryItem[], title = "Trash me"): Session {
  return {
    sessionId: uuidv4(),
    title,
    workspaceDirectory: "file:///ws",
    history,
  };
}

/** A lease record of another live process on this machine. */
function leaseOfAnotherProcess(sessionId: string): void {
  const dir = leaseDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `other-${process.ppid}.json`),
    JSON.stringify({
      pid: process.ppid,
      host: os.hostname(),
      sessions: { [sessionId]: Date.now() },
    }),
  );
}

describe("HistoryManager.trash and restore", () => {
  beforeEach(() => resetOwnLease());
  afterEach(() => {
    fs.rmSync(leaseDir(), { recursive: true, force: true });
    emptyTrash({ root: getGlobalDirPath() });
    resetOwnLease();
  });

  it("moves a .json session out of the list and Undo puts it back", async () => {
    const m = new HistoryManager();
    const s = session([user("hello"), assistant("hi")]);
    m.save(s);
    const result = await m.trash(s.sessionId);
    expect(result).toMatchObject({ status: "trashed" });
    expect(fs.existsSync(getSessionFilePath(s.sessionId))).toBe(false);
    expect(m.list({}).some((e) => e.sessionId === s.sessionId)).toBe(false);
    expect(m.listTrash().map((e) => e.metadata.title)).toContain("Trash me");

    const restored = m.restore(s.sessionId);
    expect(restored.title).toBe("Trash me");
    expect(m.list({}).some((e) => e.sessionId === s.sessionId)).toBe(true);
    expect(m.load(s.sessionId).history).toHaveLength(2);
    m.delete(s.sessionId);
  });

  it("keeps a log session's blobs through trash and restore", async () => {
    const m = new HistoryManager();
    m.setSessionLog(true);
    const long = "word ".repeat(BLOB_THRESHOLD_CHARS / 4);
    const s = session([user("read it"), assistant(long)]);
    m.save(s);
    // Queued writes land before the move
    const result = await m.trash(s.sessionId);
    expect(result.status).toBe("trashed");
    expect(fs.existsSync(getSessionLogFilePath(s.sessionId))).toBe(false);
    expect(fs.existsSync(getSessionBlobFolderPath(s.sessionId))).toBe(false);

    m.restore(s.sessionId);
    const back = new HistoryManager().load(s.sessionId);
    expect(back.history[1].message.content).toBe(long);
    m.delete(s.sessionId);
  });

  it("asks first when another process has the session open, and moves it with force", async () => {
    const m = new HistoryManager();
    const s = session([user("busy")]);
    m.save(s);
    leaseOfAnotherProcess(s.sessionId);
    const asked = await m.trash(s.sessionId);
    expect(asked).toMatchObject({
      status: "open-elsewhere",
      pid: process.ppid,
    });
    expect(fs.existsSync(getSessionFilePath(s.sessionId))).toBe(true);

    expect((await m.trash(s.sessionId, { force: true })).status).toBe(
      "trashed",
    );
    m.deleteFromTrash(s.sessionId);
  });

  it("does not count this process's own lease", async () => {
    const m = new HistoryManager();
    const s = session([user("mine")]);
    m.save(s);
    markSessionOpen(s.sessionId);
    expect((await m.trash(s.sessionId)).status).toBe("trashed");
    // ...and forgets it, so other processes do not see it open here
    const own = fs
      .readdirSync(leaseDir())
      .map((f) => fs.readFileSync(path.join(leaseDir(), f), "utf8"))
      .join("");
    expect(own).not.toContain(s.sessionId);
  });

  it("throws for a session that does not exist", async () => {
    await expect(new HistoryManager().trash(uuidv4())).rejects.toThrow(
      /does not exist/,
    );
  });

  it("Clear chats empties the trash too", async () => {
    const m = new HistoryManager();
    const s = session([user("x")]);
    m.save(s);
    await m.trash(s.sessionId);
    expect(m.listTrash()).not.toEqual([]);
    m.clearAll();
    expect(m.listTrash()).toEqual([]);
  });
});
