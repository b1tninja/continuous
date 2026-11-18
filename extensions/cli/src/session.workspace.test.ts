import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Session } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  prepareResume,
  resolveResumeArgument,
} from "./commands/resumePicker.js";
import { env } from "./env.js";
import {
  type ExtendedSessionMetadata,
  getResumeSessionId,
  isSessionInWorkspace,
  loadSession,
  orderSessionsForWorkspace,
  setResumeSessionId,
} from "./session.js";
import { resetUserNotices, setUserNoticeSink } from "./util/userNotice.js";

// Real files in the test run's own global folder (vitest.global-dir-setup.ts)
const dir = path.join(env.continueHome, "sessions");

const PROJECT = path.resolve("/home/me/code/proj");
const OTHER = path.resolve("/home/me/code/other");

function writeSession(
  id: string,
  title: string,
  workspaceDirectory: string,
  mtime: Date,
): void {
  const session: Session = {
    sessionId: id,
    title,
    workspaceDirectory,
    history: [{ message: { role: "user", content: "hi" }, contextItems: [] }],
  };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(session));
  fs.utimesSync(file, mtime, mtime);
}

describe("--resume picks the session of the folder it runs in", () => {
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
    setResumeSessionId(undefined);
  });

  afterEach(() => {
    setResumeSessionId(undefined);
    resetUserNotices();
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTestFlag !== undefined) {
      process.env.CONTINUE_CLI_TEST = savedTestFlag;
    }
  });

  it("resumes the newest session of this folder, not a newer one from elsewhere", () => {
    writeSession("here-old", "Old here", PROJECT, new Date("2026-01-01"));
    writeSession("here-new", "New here", PROJECT, new Date("2026-01-02"));
    writeSession("elsewhere", "Elsewhere", OTHER, new Date("2026-01-05"));

    expect(loadSession({ cwd: PROJECT })?.sessionId).toBe("here-new");
    expect(notices).toEqual([]);
    expect(loadSession({ cwd: OTHER })?.sessionId).toBe("elsewhere");
  });

  it("resumes from a subfolder of the session's folder", () => {
    writeSession("here", "Here", PROJECT, new Date("2026-01-01"));
    writeSession("elsewhere", "Elsewhere", OTHER, new Date("2026-01-05"));

    expect(
      loadSession({ cwd: path.join(PROJECT, "src", "lib") })?.sessionId,
    ).toBe("here");
    expect(notices).toEqual([]);
  });

  it("falls back to the newest session of any folder and names that folder", () => {
    writeSession("older", "Older", PROJECT, new Date("2026-01-01"));
    writeSession("newest", "Fix the parser", OTHER, new Date("2026-01-05"));
    const cwd = path.resolve("/home/me/code/third");

    expect(loadSession({ cwd })?.sessionId).toBe("newest");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`No session was started in ${cwd}`);
    expect(notices[0]).toContain(`"Fix the parser" from ${OTHER}`);
  });

  it("resumes the session chosen by id, whatever the folder", () => {
    writeSession("chosen", "Chosen", OTHER, new Date("2026-01-01"));
    writeSession("here", "Here", PROJECT, new Date("2026-01-05"));

    setResumeSessionId("chosen");
    expect(loadSession({ cwd: PROJECT })?.sessionId).toBe("chosen");
    // Asked again while the terminal UI starts: the same session
    expect(loadSession({ cwd: PROJECT })?.sessionId).toBe("chosen");
    expect(notices).toEqual([]);
  });

  it("matches another folder of the same git repository", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cn-resume-repo-"));
    try {
      fs.mkdirSync(path.join(repo, ".git"));
      fs.mkdirSync(path.join(repo, "packages", "a"), { recursive: true });
      fs.mkdirSync(path.join(repo, "packages", "b"), { recursive: true });
      const a = path.join(repo, "packages", "a");
      const b = path.join(repo, "packages", "b");
      expect(isSessionInWorkspace(a, b)).toBe(true);
      expect(isSessionInWorkspace(OTHER, b)).toBe(false);

      writeSession("in-a", "In a", a, new Date("2026-01-01"));
      writeSession("elsewhere", "Elsewhere", OTHER, new Date("2026-01-05"));
      expect(loadSession({ cwd: b })?.sessionId).toBe("in-a");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("orderSessionsForWorkspace (continuous ls, the --resume picker)", () => {
  const meta = (
    sessionId: string,
    workspaceDirectory: string,
    lastModified: string,
  ): ExtendedSessionMetadata => ({
    sessionId,
    title: sessionId,
    dateCreated: "2020-01-01T00:00:00.000Z",
    lastModified,
    workspaceDirectory,
  });

  it("lists this folder first, newest on top, then others by their newest, no folder last", () => {
    const ordered = orderSessionsForWorkspace(
      [
        meta("other-new", OTHER, "2026-01-05T00:00:00.000Z"),
        meta("none", "", "2026-01-09T00:00:00.000Z"),
        meta("here-old", PROJECT, "2026-01-01T00:00:00.000Z"),
        meta("here-new", path.join(PROJECT, "src"), "2026-01-03T00:00:00.000Z"),
        meta("other-old", OTHER, "2026-01-02T00:00:00.000Z"),
      ],
      PROJECT,
    );
    expect(ordered.map((s) => s.sessionId)).toEqual([
      "here-new",
      "here-old",
      "other-new",
      "other-old",
      "none",
    ]);
    expect(ordered.map((s) => s.inWorkspace)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(ordered[4].workspaceGroup).toBe("No folder");
    expect(ordered[2].workspaceGroupPath).toBe(OTHER.replace(/\\/g, "/"));
  });
});

describe("resolveResumeArgument", () => {
  beforeEach(() => {
    delete process.env.CONTINUE_CLI_TEST;
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("takes a saved session's id as the session to resume", () => {
    const id = "0b5a6c1e-1111-4222-8333-444455556666";
    writeSession(id, "Saved", PROJECT, new Date("2026-01-01"));
    expect(resolveResumeArgument(id, "go on")).toEqual({
      sessionId: id,
      prompt: "go on",
    });
  });

  it("refuses an id no session has", () => {
    const result = resolveResumeArgument(
      "0b5a6c1e-9999-4222-8333-444455556666",
      undefined,
    );
    expect("error" in result && result.error).toContain("no saved session");
  });

  it("with -p, takes the id given and opens no picker", async () => {
    const id = "0b5a6c1e-1111-4222-8333-444455556666";
    writeSession(id, "Saved", PROJECT, new Date("2026-01-01"));
    const options: { resume?: boolean | string; print?: boolean } = {
      resume: id,
      print: true,
    };
    try {
      expect(await prepareResume(options, "go on")).toBe("go on");
      expect(options.resume).toBe(true);
      expect(getResumeSessionId()).toBe(id);
    } finally {
      setResumeSessionId(undefined);
    }
  });

  it("keeps a value that is not an id as the prompt", () => {
    expect(resolveResumeArgument("fix the tests", undefined)).toEqual({
      sessionId: undefined,
      prompt: "fix the tests",
    });
    expect(resolveResumeArgument("fix", "the tests")).toEqual({
      sessionId: undefined,
      prompt: "fix the tests",
    });
  });
});
