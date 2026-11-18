import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import historyManager from "core/util/history.js";
import { getSessionFilePath, getSessionsListPath } from "core/util/paths.js";
import { leaseDir } from "core/util/sessionLeases.js";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionsPruneCommand } from "./sessionsPrune.js";

let out: string[] = [];
let err: string[] = [];
const io = () => ({
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const mine = new Set<string>();
const leaseFiles: string[] = [];

/** A saved session last written `daysAgo` days ago (file and list entry). */
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
  const at = new Date(NOW - daysAgo * DAY);
  fs.utimesSync(getSessionFilePath(sessionId), at, at);
  const listFile = getSessionsListPath();
  const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
  for (const entry of list) {
    if (entry.sessionId === sessionId) entry.dateCreated = String(+at);
  }
  fs.writeFileSync(listFile, JSON.stringify(list));
  mine.add(sessionId);
  return sessionId;
}

/** Another live process (this test's parent) has the session open. */
function openElsewhere(sessionId: string): void {
  const dir = leaseDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `prune-test-${process.ppid}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: process.ppid,
      host: os.hostname(),
      sessions: { [sessionId]: Date.now() },
    }),
  );
  leaseFiles.push(file);
}

const listed = (id: string) =>
  historyManager.list({}).some((s) => s.sessionId === id);
const trashed = (id: string) =>
  historyManager.listTrash().some((s) => s.sessionId === id);

afterEach(() => {
  vi.restoreAllMocks();
  for (const f of leaseFiles.splice(0)) fs.rmSync(f, { force: true });
  for (const id of mine) {
    if (trashed(id)) historyManager.deleteFromTrash(id);
    if (listed(id)) historyManager.delete(id);
  }
  mine.clear();
  out = [];
  err = [];
});

describe("continuous sessions prune --older-than (V11)", () => {
  it("lists only sessions older than the age and moves nothing without --yes", async () => {
    const old = saved("Old one", 400);
    const recent = saved("Recent one", 2);
    const code = await sessionsPruneCommand(
      { olderThan: "365d", interactive: false },
      io(),
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(old);
    expect(text).toContain("Old one");
    expect(text).not.toContain(recent);
    expect(text).toContain("Run with --yes");
    expect(listed(old)).toBe(true);
    expect(trashed(old)).toBe(false);
  });

  it("--yes moves the old sessions to the trash, never deletes, and keeps the recent", async () => {
    const old = saved("Old one", 400);
    const recent = saved("Recent one", 2);
    expect(
      await sessionsPruneCommand({ olderThan: "52w", yes: true }, io()),
    ).toBe(0);
    expect(listed(old)).toBe(false);
    expect(trashed(old)).toBe(true);
    expect(fs.existsSync(getSessionFilePath(old))).toBe(false);
    expect(listed(recent)).toBe(true);
    expect(out.join("\n")).toContain("Moved");
    // the result line says how to undo it, for how long, and what then
    expect(out.join("\n")).toContain(
      "Each can be restored with continuous sessions restore <id> for 7 days",
    );
    expect(out.join("\n")).toContain("after that it is removed for good");

    // and it comes back from the trash whole
    historyManager.restore(old);
    expect(listed(old)).toBe(true);
    expect(historyManager.load(old).title).toBe("Old one");
  });

  it("asks on a terminal and moves only on yes", async () => {
    const old = saved("Asked about", 100);
    const asked: string[] = [];
    await sessionsPruneCommand(
      {
        olderThan: "90d",
        interactive: true,
        confirm: async (q) => (asked.push(q), false),
      },
      io(),
    );
    expect(asked[0]).toMatch(/Move \d+ session\(s\) to the trash\?/);
    // before the question: restorable for 7 days, then removed for good
    expect(out.join("\n")).toContain(
      "each can be restored with continuous sessions restore <id> for 7 days, and is then removed for good",
    );
    expect(out.join("\n")).toContain("Nothing moved.");
    expect(listed(old)).toBe(true);

    out = [];
    await sessionsPruneCommand(
      { olderThan: "90d", interactive: true, confirm: async () => true },
      io(),
    );
    expect(trashed(old)).toBe(true);
  });

  it("--dry-run only lists, even with --yes", async () => {
    const old = saved("Dry", 100);
    await sessionsPruneCommand(
      { olderThan: "90d", dryRun: true, yes: true },
      io(),
    );
    expect(out.join("\n")).toContain("Dry run: nothing moved.");
    expect(listed(old)).toBe(true);
  });

  it("leaves a session open in another window or agent alone (sessions-open lease)", async () => {
    const open = saved("Open elsewhere", 400);
    const other = saved("Not open", 400);
    openElsewhere(open);
    await sessionsPruneCommand({ olderThan: "365d", yes: true }, io());
    const text = out.join("\n");
    expect(text).toContain("Left alone, open in another window or agent");
    expect(text).toContain(`pid ${process.ppid}`);
    expect(listed(open)).toBe(true);
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
    expect(
      await sessionsPruneCommand({ olderThan: "365d", yes: true }, io()),
    ).toBe(0);
    for (const call of trash.mock.calls) expect(call[1]).toBeUndefined();
    expect(out.join("\n")).toContain(
      `Left alone: ${old} was opened by pid 4242 on box`,
    );
    expect(listed(old)).toBe(true);
  });

  it("--json reports and moves only with --yes", async () => {
    const old = saved("Json", 400);
    await sessionsPruneCommand({ olderThan: "365d", json: true }, io());
    const report = JSON.parse(out[0]);
    expect(report.applied).toBe(false);
    expect(report.candidates.map((c: any) => c.id)).toContain(old);
    expect(listed(old)).toBe(true);

    out = [];
    await sessionsPruneCommand(
      { olderThan: "365d", json: true, yes: true },
      io(),
    );
    const done = JSON.parse(out[0]);
    expect(done.applied).toBe(true);
    expect(done.moved.map((c: any) => c.id)).toContain(old);
    expect(trashed(old)).toBe(true);
  });

  it("says so when nothing is that old", async () => {
    saved("Fresh", 1);
    expect(
      await sessionsPruneCommand({ olderThan: "3650d", yes: true }, io()),
    ).toBe(0);
    expect(out.join("\n")).toContain("No session was last used before");
  });

  it("refuses an age it cannot read", async () => {
    expect(await sessionsPruneCommand({ olderThan: "soon" }, io())).toBe(2);
    expect(err[0]).toContain('Bad --older-than "soon"');
  });
});
