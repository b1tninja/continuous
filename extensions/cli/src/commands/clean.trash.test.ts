import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import historyManager from "core/util/history.js";
import {
  getGlobalDirPath,
  getSessionFilePath,
  getSessionsFolderPath,
} from "core/util/paths.js";
import { leaseDir } from "core/util/sessionLeases.js";
import { trashDir } from "core/util/sessionTrash.js";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanCommand } from "./clean.js";

/* `continuous clean --yes` moves old sessions to the trash (restorable for
   7 days) instead of deleting them, and leaves sessions open elsewhere. */

let out: string[] = [];
let err: string[] = [];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

const DAY = 24 * 60 * 60 * 1000;
const mine = new Set<string>();
const extraFiles: string[] = [];

/** A saved session whose file was last written `daysAgo` days ago. */
function saved(title: string, daysAgo: number): string {
  const sessionId = uuidv4();
  historyManager.save({
    sessionId,
    title,
    workspaceDirectory: "/code/proj",
    history: [
      { message: { role: "user", content: "hello" }, contextItems: [] },
    ],
  });
  const at = new Date(Date.now() - daysAgo * DAY);
  fs.utimesSync(getSessionFilePath(sessionId), at, at);
  mine.add(sessionId);
  return sessionId;
}

function openElsewhere(sessionId: string): void {
  const dir = leaseDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `clean-test-${process.ppid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: process.ppid,
      host: os.hostname(),
      sessions: { [sessionId]: Date.now() },
    }),
  );
  extraFiles.push(file);
}

function oldLog(): string {
  const dir = path.join(getGlobalDirPath(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `clean-trash-test-${uuidv4()}.log`);
  fs.writeFileSync(f, "x");
  const t = new Date(Date.now() - 400 * DAY);
  fs.utimesSync(f, t, t);
  extraFiles.push(f);
  return f;
}

const listed = (id: string) =>
  historyManager.list({}).some((s) => s.sessionId === id);
const trashed = (id: string) =>
  historyManager.listTrash().some((s) => s.sessionId === id);

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of extraFiles.splice(0)) fs.rmSync(f, { force: true });
  for (const id of mine) {
    if (trashed(id)) historyManager.deleteFromTrash(id);
    if (listed(id)) historyManager.delete(id);
  }
  mine.clear();
  out = [];
  err = [];
});

describe("continuous clean: sessions go to the trash", () => {
  it("--yes moves old sessions to the trash, nothing is hard-deleted, and they restore", async () => {
    const old = saved("Old one", 400);
    const recent = saved("Recent one", 1);
    const log = oldLog();
    expect(await cleanCommand({ olderThan: "365d", yes: true }, io())).toBe(0);

    // the session left sessions/ for the trash, whole
    expect(fs.existsSync(getSessionFilePath(old))).toBe(false);
    expect(listed(old)).toBe(false);
    expect(trashed(old)).toBe(true);
    expect(
      fs.existsSync(path.join(trashDir(), old, "files", `${old}.json`)),
    ).toBe(true);
    expect(listed(recent)).toBe(true);
    // logs are still deleted as before
    expect(fs.existsSync(log)).toBe(false);

    const text = out.join("\n");
    expect(text).toContain("Moved");
    expect(text).toContain("continuous sessions restore <id>");
    expect(text).toContain("removed for good");

    historyManager.restore(old);
    expect(historyManager.load(old).title).toBe("Old one");
  });

  it("never unlinks a session file itself", async () => {
    const old = saved("Watched", 400);
    const unlink = vi.spyOn(fs, "unlinkSync");
    const rm = vi.spyOn(fs, "rmSync");
    await cleanCommand({ olderThan: "365d", yes: true }, io());
    const sessionsDir = getSessionsFolderPath();
    for (const [p] of [...unlink.mock.calls, ...rm.mock.calls]) {
      expect(String(p).startsWith(path.join(sessionsDir, old))).toBe(false);
    }
    expect(trashed(old)).toBe(true);
  });

  it("leaves a session open in another window or agent (lease) alone", async () => {
    const open = saved("Open elsewhere", 400);
    const other = saved("Not open", 400);
    openElsewhere(open);
    await cleanCommand({ olderThan: "365d", yes: true }, io());
    expect(out.join("\n")).toContain(
      "Left alone, open in another window or agent",
    );
    expect(listed(open)).toBe(true);
    expect(fs.existsSync(getSessionFilePath(open))).toBe(true);
    expect(trashed(open)).toBe(false);
    expect(trashed(other)).toBe(true);
  });

  it("never forces: a session opened after the report is left alone", async () => {
    const old = saved("Opened meanwhile", 400);
    const trash = vi.spyOn(historyManager, "trash").mockResolvedValue({
      status: "open-elsewhere",
      sessionId: old,
      pid: 4242,
      host: "box",
      at: Date.now(),
    });
    await cleanCommand({ olderThan: "365d", yes: true }, io());
    for (const call of trash.mock.calls) expect(call[1]).toBeUndefined();
    expect(out.join("\n")).toContain(`Left alone: ${old} was opened by pid`);
    expect(fs.existsSync(getSessionFilePath(old))).toBe(true);
  });

  it("a dry run lists the sessions, says they would go to the trash, and moves nothing", async () => {
    const old = saved("Dry", 400);
    await cleanCommand({ olderThan: "365d" }, io());
    const text = out.join("\n");
    expect(text).toContain(old);
    expect(text).toContain("to the trash");
    expect(text).toContain("Dry run: nothing deleted or moved");
    expect(listed(old)).toBe(true);
  });

  it("--json reports the moves", async () => {
    const old = saved("Json", 400);
    await cleanCommand({ olderThan: "365d", yes: true, json: true }, io());
    const report = JSON.parse(out[0]);
    expect(report.applied).toBe(true);
    expect(report.sessions.moved).toContain(old);
    expect(report.entries.some((e: any) => e.store === "sessions")).toBe(false);
    expect(trashed(old)).toBe(true);
  });

  it("leaves sessions alone in a folder that is not the global one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-clean-root-"));
    try {
      fs.mkdirSync(path.join(root, "sessions"));
      const f = path.join(root, "sessions", "abc.json");
      fs.writeFileSync(f, "{}");
      const t = new Date(Date.now() - 400 * DAY);
      fs.utimesSync(f, t, t);
      await cleanCommand({ root, olderThan: "365d", yes: true }, io());
      expect(fs.existsSync(f)).toBe(true);
      expect(out.join("\n")).toContain("only in the global folder");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
