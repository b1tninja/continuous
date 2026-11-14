import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Session } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "./env.js";
import { loadSession, loadSessionById } from "./session.js";
import { resetUserNotices, setUserNoticeSink } from "./util/userNotice.js";

// Real files in the test run's own global folder (vitest.global-dir-setup.ts)
const dir = path.join(env.continueHome, "sessions");

function writeSession(id: string, title: string, mtime: Date): string {
  const session: Session = {
    sessionId: id,
    title,
    workspaceDirectory: "/work/project",
    history: [{ message: { role: "user", content: "hi" }, contextItems: [] }],
  };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(session));
  fs.utimesSync(file, mtime, mtime);
  return file;
}

function writeDamaged(id: string, mtime: Date): string {
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, '{"sessionId":"' + id + '","history":[{"mess');
  fs.utimesSync(file, mtime, mtime);
  return file;
}

describe("--resume and a damaged session file", () => {
  let notices: string[];
  const savedTestFlag = process.env.CONTINUE_CLI_TEST;

  beforeEach(() => {
    // session.ts uses another folder when CONTINUE_CLI_TEST and HOME are set
    delete process.env.CONTINUE_CLI_TEST;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    notices = [];
    resetUserNotices();
    setUserNoticeSink((text) => notices.push(text));
  });

  afterEach(() => {
    resetUserNotices();
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTestFlag !== undefined) {
      process.env.CONTINUE_CLI_TEST = savedTestFlag;
    }
  });

  it("resumes the newest session without a notice when it is readable", () => {
    writeSession("older", "Older", new Date("2026-01-01"));
    writeSession("newest", "Newest", new Date("2026-01-03"));
    expect(loadSession()?.sessionId).toBe("newest");
    expect(notices).toEqual([]);
  });

  it("sets a damaged newest file aside, resumes the one before it and says so", () => {
    writeSession("older", "Refactor the parser", new Date("2026-01-01"));
    const damaged = writeDamaged("newest", new Date("2026-01-03"));
    const bytes = fs.readFileSync(damaged, "utf8");

    const session = loadSession();

    expect(session?.sessionId).toBe("older");
    const kept = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^newest\.corrupt-\d+(-\d+)?\.json$/);
    expect(fs.readFileSync(path.join(dir, kept[0]), "utf8")).toBe(bytes);
    expect(fs.existsSync(damaged)).toBe(false);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("The newest session could not be read");
    expect(notices[0]).toContain(path.join(dir, kept[0]));
    expect(notices[0]).toContain(
      'Resumed the one before it: "Refactor the parser" from /work/project.',
    );

    // The file that was set aside is never a candidate again
    notices.length = 0;
    resetUserNotices();
    setUserNoticeSink((text) => notices.push(text));
    expect(loadSession()?.sessionId).toBe("older");
    expect(notices).toEqual([]);
    expect(
      fs.readdirSync(dir).filter((n) => n.includes(".corrupt-")),
    ).toHaveLength(1);
  });

  it("says so when the only session is damaged", () => {
    writeDamaged("only", new Date("2026-01-03"));
    expect(loadSession()).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("The newest session could not be read");
    expect(notices[0]).toContain("starting a new one");
  });

  it("opening a damaged session by id keeps its bytes and says where", () => {
    const damaged = writeDamaged("picked", new Date("2026-01-03"));
    const bytes = fs.readFileSync(damaged, "utf8");

    const session = loadSessionById("picked");

    expect(session?.history).toEqual([]);
    const kept = fs.readdirSync(dir).filter((n) => n.includes(".corrupt-"));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, kept[0]), "utf8")).toBe(bytes);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("damaged and was not loaded");
    expect(notices[0]).toContain(path.join(dir, kept[0]));
  });

  it("writes the notice to stderr, not stdout, when no UI is up", () => {
    resetUserNotices();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeDamaged("only", new Date("2026-01-03"));
      loadSession();
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0][0])).toContain(
        "The newest session could not be read",
      );
      expect(out).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});

describe("--resume and the extension's session log", () => {
  const savedTestFlag = process.env.CONTINUE_CLI_TEST;

  beforeEach(() => {
    delete process.env.CONTINUE_CLI_TEST;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTestFlag !== undefined) {
      process.env.CONTINUE_CLI_TEST = savedTestFlag;
    }
  });

  it("resumes a .jsonl session, reading its blobs", () => {
    writeSession("older", "Older", new Date("2026-01-01"));
    const output = "x".repeat(20_000);
    const hash = createHash("sha256").update(output).digest("hex");
    fs.mkdirSync(path.join(dir, "from-ide", "blobs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "from-ide", "blobs", hash), output);
    const lines = [
      {
        t: "header",
        format: "continuous-session",
        v: 1,
        sessionId: "from-ide",
      },
      { t: "meta", k: "title", v: "From the IDE" },
      { t: "meta", k: "workspaceDirectory", v: "/work/project" },
      {
        t: "item",
        i: 0,
        v: { message: { role: "user", content: "read it" }, contextItems: [] },
      },
      {
        t: "item",
        i: 1,
        v: {
          message: {
            role: "tool",
            content: { $blob: hash, n: output.length },
            toolCallId: "c",
          },
          contextItems: [],
        },
      },
    ];
    const file = path.join(dir, "from-ide.jsonl");
    fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    const newest = new Date("2026-01-03");
    fs.utimesSync(file, newest, newest);

    const session = loadSession();
    expect(session?.sessionId).toBe("from-ide");
    expect(session?.title).toBe("From the IDE");
    expect(session?.history[1].message.content).toBe(output);
  });
});
