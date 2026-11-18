import * as fs from "fs";
import * as path from "path";

import { v4 as uuidv4 } from "uuid";

import { Session } from "..";
import { NEW_SESSION_TITLE } from "./constants";
import historyManager, {
  damagedSessionNotice,
  HistoryManager,
} from "./history";
import {
  getSessionFilePath,
  getSessionsFolderPath,
  getSessionsListPath,
} from "./paths";
import { serializeSession } from "./sessionFile";

const sessionId = uuidv4();
const testSession: Session = {
  history: [],
  title: `${sessionId} title`,
  workspaceDirectory: "workspaceDir",
  sessionId: sessionId,
};

describe("No sessions have been created", () => {
  const testSessionId = "invalid";
  const testSessionPath = getSessionFilePath(testSessionId);

  test("Listing all sessions returns empty list", () => {
    const sessions = historyManager.list({});
    expect(sessions).toEqual([]);
  });

  test("Deleting session throws error", () => {
    expect(() => {
      historyManager.delete(testSessionId);
    }).toThrow(`Session file ${testSessionPath} does not exist`);
  });

  test("Loading session returns default session", () => {
    const session = historyManager.load(testSessionId);
    expect(session).toEqual({
      history: [],
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      sessionId: testSessionId,
    });
  });
});

describe("Full session lifecycle", () => {
  test("Creating and listing a session", () => {
    // save and list
    historyManager.save(testSession);
    const sessions = historyManager.list({});
    const sessionExists = sessions.some(
      (session) => session?.sessionId === testSession.sessionId,
    );
    expect(sessionExists).toBe(true);
  });

  test("Loading session by ID returns correct object", () => {
    const retrievedSession = historyManager.load(testSession.sessionId);
    expect(retrievedSession).toEqual(testSession);
  });

  test("Saving session with new title updates session", () => {
    const modifiedSession = { ...testSession };
    modifiedSession.title = `Edited: ${testSession.title}`;
    historyManager.save(modifiedSession);
    const session = historyManager.load(testSession.sessionId);

    expect(session.title).toBe(modifiedSession.title);
  });

  test("The prompt cache record is saved and loaded with the session", () => {
    const promptCache = {
      lastRequestAt: 1_700_000_000_000,
      lastInputTokens: 366_000,
      lastTtl: "5m" as const,
    };
    historyManager.save({ ...testSession, promptCache });
    expect(historyManager.load(testSession.sessionId).promptCache).toEqual(
      promptCache,
    );
  });

  test("A session saved without a prompt cache record loads without one", () => {
    historyManager.save(testSession);
    expect(
      historyManager.load(testSession.sessionId).promptCache,
    ).toBeUndefined();
  });

  test("The task list is saved and loaded with the session", () => {
    const taskPlan = {
      items: [
        { id: "1", text: "Write the migration", status: "completed" as const },
        {
          id: "2",
          text: "Run it",
          status: "in_progress" as const,
          activeForm: "Running it",
        },
        {
          id: "3",
          text: "Deploy",
          status: "blocked" as const,
          note: "waiting for keys",
        },
      ],
      updatedAt: "2026-11-06T12:00:00.000Z",
      updatedBy: "user" as const,
    };
    historyManager.save({ ...testSession, taskPlan });
    expect(historyManager.load(testSession.sessionId).taskPlan).toEqual(
      taskPlan,
    );
  });

  test("The plan file is saved and loaded with the session", () => {
    const planFile = "file:///work/repo/.continuous/plans/add-retry.md";
    historyManager.save({ ...testSession, planFile });
    expect(historyManager.load(testSession.sessionId).planFile).toBe(planFile);
  });

  test("An empty task list is not written", () => {
    historyManager.save({
      ...testSession,
      taskPlan: { items: [], updatedAt: "2026-11-06T12:00:00.000Z" },
    });
    expect(historyManager.load(testSession.sessionId).taskPlan).toBeUndefined();
  });

  test("Queued messages are saved and loaded with the session, and cleared when empty", () => {
    const queuedMessages = [
      {
        id: "q1",
        editorState: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "next" }] },
          ],
        },
        modifiers: { useCodebase: false, noContext: false },
      },
    ];
    historyManager.save({ ...testSession, queuedMessages });
    expect(historyManager.load(testSession.sessionId).queuedMessages).toEqual(
      queuedMessages,
    );

    historyManager.save({ ...testSession, queuedMessages: [] });
    expect(
      historyManager.load(testSession.sessionId).queuedMessages,
    ).toBeUndefined();
  });

  test("Deleting session", () => {
    historyManager.delete(testSession.sessionId);
    const sessions = historyManager.list({});
    const sessionWasDeleted = sessions.every(
      (session) => session?.sessionId !== testSession.sessionId,
    );
    expect(sessionWasDeleted).toEqual(true);
  });
});

describe("Workspace directory filtering", () => {
  beforeAll(() => {
    historyManager.clearAll();
    historyManager.save({
      history: [],
      title: "Project A session 1",
      workspaceDirectory: "/home/user/project-a",
      sessionId: "ws-a-1",
    });
    historyManager.save({
      history: [],
      title: "Project B session 1",
      workspaceDirectory: "/home/user/project-b",
      sessionId: "ws-b-1",
    });
    historyManager.save({
      history: [],
      title: "Project A session 2",
      workspaceDirectory: "/home/user/project-a",
      sessionId: "ws-a-2",
    });
    historyManager.save({
      history: [],
      title: "No workspace",
      workspaceDirectory: "",
      sessionId: "ws-none",
    });
  });

  afterAll(() => {
    historyManager.clearAll();
  });

  test("Filter sessions by workspace directory", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/project-a",
    });
    expect(sessions.length).toBe(2);
    expect(
      sessions.every((s) => s.workspaceDirectory === "/home/user/project-a"),
    ).toBe(true);
  });

  test("Omitting workspace returns all sessions", () => {
    const sessions = historyManager.list({});
    expect(sessions.length).toBe(4);
  });

  test("Workspace filter is case-insensitive", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/HOME/USER/PROJECT-A",
    });
    expect(sessions.length).toBe(2);
  });

  test("Non-matching workspace returns empty list", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/nonexistent",
    });
    expect(sessions.length).toBe(0);
  });

  test("Workspace filter works with limit", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/project-a",
      limit: 1,
    });
    expect(sessions.length).toBe(1);
  });

  test("Workspace filter works with limit and offset", () => {
    const sessions = historyManager.list({
      workspaceDirectory: "/home/user/project-a",
      limit: 1,
      offset: 1,
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("ws-a-1");
  });
});

describe("Many sessions created", () => {
  test("Create 100 sessions and list all", () => {
    for (let i = 0; i < 100; i++) {
      historyManager.save({
        history: [],
        title: `${i}`,
        workspaceDirectory: "workspaceDir",
        sessionId: `${i}`,
      });
    }
    const sessions = historyManager.list({});
    expect(sessions.length).toBe(100);
  });

  test("List 10 sessions, offest by 10", () => {
    const limit = 10;
    const offset = 10;

    const sessions = historyManager.list({ offset: offset, limit: limit });
    // Sessions are now reversed, so newest (99) comes first
    const sessionIds = Array.from({ length: limit }, (_, i) =>
      (99 - offset - i).toString(),
    );
    const isSessionIdInList = (sessionId: string) =>
      sessions.some((session) => session.sessionId === sessionId);
    expect(sessionIds.every(isSessionIdInList)).toBe(true);
  });

  test("List 25 sessions, with no offset", () => {
    const limit = 25;

    const sessions = historyManager.list({ limit: limit });
    // Sessions are now reversed, so newest (99) comes first
    const sessionIds = Array.from({ length: limit }, (_, i) =>
      (99 - i).toString(),
    );

    const isSessionIdInList = (sessionId: string) =>
      sessions.some((session) => session.sessionId === sessionId);
    expect(sessionIds.every(isSessionIdInList)).toBe(true);
  });

  test("List sessions offset by 75", () => {
    const offset = 75;

    const sessions = historyManager.list({ offset: offset });
    const sessionIds = Array.from(
      { length: sessions.length - offset },
      (_, i) => (i + offset).toString(),
    );

    const isSessionIdInList = (sessionId: string) =>
      sessions.some((session) => session.sessionId === sessionId);
    expect(sessionIds.every(isSessionIdInList)).toBe(true);
  });

  test("Delete all sessions", () => {
    let sessions = historyManager.list({});

    for (let session of sessions) {
      historyManager.delete(session.sessionId);
    }
    sessions = historyManager.list({});
    expect(sessions.length).toBe(0);
  });
});

describe("Session saves are atomic", () => {
  const session: Session = {
    history: [],
    title: "Atomic",
    workspaceDirectory: "workspaceDir",
    sessionId: "atomic-save",
  };

  test("the session file and the list are replaced, not written in place", () => {
    historyManager.save(session);
    const sessionFile = getSessionFilePath(session.sessionId);
    const listFile = getSessionsListPath();
    const sessionInode = fs.statSync(sessionFile).ino;
    const listInode = fs.statSync(listFile).ino;

    historyManager.save({ ...session, title: "Atomic 2" });

    // rename onto the destination gives it a new inode; writeFileSync in
    // place keeps the old one
    expect(fs.statSync(sessionFile).ino).not.toBe(sessionInode);
    expect(fs.statSync(listFile).ino).not.toBe(listInode);
    expect(
      fs
        .readdirSync(getSessionsFolderPath())
        .filter((name) => name.includes(".tmp")),
    ).toEqual([]);
    expect(JSON.parse(fs.readFileSync(sessionFile, "utf8")).title).toBe(
      "Atomic 2",
    );
  });

  test("a corrupt sessions.json is backed up and the list is rebuilt", () => {
    const listFile = getSessionsListPath();
    fs.writeFileSync(listFile, "{not json");
    expect(() =>
      historyManager.save({
        ...session,
        sessionId: "after-corrupt",
        title: "After",
      }),
    ).not.toThrow();

    const sessions = historyManager.list({});
    expect(sessions.some((s) => s.sessionId === "atomic-save")).toBe(true);
    expect(sessions.some((s) => s.sessionId === "after-corrupt")).toBe(true);
    expect(
      fs
        .readdirSync(getSessionsFolderPath())
        .some((name) => name.startsWith("sessions.json.corrupt-")),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(listFile, "utf8"))).toEqual(
      expect.any(Array),
    );
  });

  test("a stale lock does not block the next save", () => {
    const lock = `${getSessionsListPath()}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(() =>
      historyManager.save({
        ...session,
        sessionId: "after-lock",
        title: "Unlocked",
      }),
    ).not.toThrow();
    expect(fs.existsSync(lock)).toBe(false);
    expect(
      historyManager.list({}).some((s) => s.sessionId === "after-lock"),
    ).toBe(true);
  });
});

describe("a damaged session file is set aside, not replaced", () => {
  const folder = () => getSessionsFolderPath();
  const keptFiles = (id: string) =>
    fs.readdirSync(folder()).filter((n) => n.startsWith(`${id}.corrupt-`));

  test.each([
    ["truncated JSON", '{"sessionId":"x","history":[{"message":{"role":"us'],
    ["an empty file", ""],
    ["a list", "[1,2,3]"],
  ])("%s", (_name, bytes) => {
    const id = `damaged-${Math.random().toString(36).slice(2)}`;
    const file = getSessionFilePath(id);
    fs.writeFileSync(file, bytes);

    const result = historyManager.loadWithStatus(id);

    // An empty session under the same id, as before
    expect(result.session).toEqual({
      history: [],
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      sessionId: id,
    });
    // and the bytes are kept beside it
    const kept = keptFiles(id);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\.corrupt-\d+(-\d+)?\.json$/);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(folder(), kept[0]), "utf8")).toBe(bytes);
    expect(result.damaged?.keptAt).toBe(path.join(folder(), kept[0]));

    // The next save under that id replaces nothing
    historyManager.save({ ...result.session, title: "After" });
    expect(fs.readFileSync(path.join(folder(), kept[0]), "utf8")).toBe(bytes);
    expect(historyManager.load(id).title).toBe("After");
    expect(keptFiles(id)).toHaveLength(1);
  });

  test("the notice names the kept file and never quotes the session", () => {
    const id = "damaged-notice";
    fs.writeFileSync(getSessionFilePath(id), '{"title":"my secret plan",');
    const result = historyManager.loadWithStatus(id);
    const notice = damagedSessionNotice(result.damaged!);
    expect(notice).toContain(result.damaged!.keptAt);
    expect(notice).toContain("damaged and was not loaded");
    expect(notice).not.toContain("secret");
  });

  test("it is reported once: the second load finds no file", () => {
    const id = "damaged-once";
    fs.writeFileSync(getSessionFilePath(id), "{");
    expect(historyManager.loadWithStatus(id).damaged).toBeDefined();
    expect(historyManager.loadWithStatus(id).damaged).toBeUndefined();
  });

  test("load() warns once and still answers a session", () => {
    const id = "damaged-load";
    fs.writeFileSync(getSessionFilePath(id), "{");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(historyManager.load(id).history).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(".corrupt-");
    } finally {
      warn.mockRestore();
    }
  });

  test("a file that cannot be read is left alone and not opened", () => {
    const id = "unreadable";
    // A folder where the file should be: reading fails, and it is not JSON
    fs.mkdirSync(getSessionFilePath(id));
    try {
      expect(() => historyManager.load(id)).toThrow(/could not be read/);
      expect(fs.existsSync(getSessionFilePath(id))).toBe(true);
      expect(keptFiles(id)).toHaveLength(0);
    } finally {
      fs.rmdirSync(getSessionFilePath(id));
    }
  });

  test("a set-aside file is not listed as a session when the list is rebuilt", () => {
    const id = "damaged-rebuild";
    fs.writeFileSync(getSessionFilePath(id), "{");
    const kept = historyManager.loadWithStatus(id).damaged!.keptAt;
    // A set-aside file that happens to parse must still not come back
    fs.writeFileSync(
      kept,
      JSON.stringify({ sessionId: "ghost", title: "Ghost", history: [] }),
    );
    fs.writeFileSync(getSessionsListPath(), "{not json");
    historyManager.save({
      sessionId: "rebuild-trigger",
      title: "Trigger",
      workspaceDirectory: "",
      history: [],
    });
    const ids = historyManager.list({}).map((s) => s.sessionId);
    expect(ids).toContain("rebuild-trigger");
    expect(ids).not.toContain("ghost");
  });
});

describe("session file size (STOR8)", () => {
  const sized = (id: string, text: string): Session => ({
    sessionId: id,
    title: "Sized",
    workspaceDirectory: "",
    history: [{ message: { role: "user", content: text }, contextItems: [] }],
  });

  test("save reports the bytes it wrote and records them in the list", () => {
    const session = sized("size-recorded", "é".repeat(500));
    const { fileBytes } = historyManager.save(session);
    expect(fileBytes).toBe(
      fs.statSync(getSessionFilePath(session.sessionId)).size,
    );
    // Multi-byte text counts in bytes, not characters
    expect(fileBytes).toBe(Buffer.byteLength(serializeSession(session)));
    const listed = historyManager
      .list({})
      .find((s) => s.sessionId === session.sessionId);
    expect(listed?.fileBytes).toBe(fileBytes);
  });

  test("a listed session saved before sizes were recorded gets its size from the file", () => {
    const session = sized("size-from-file", "x".repeat(300));
    historyManager.save(session);
    const [filled] = historyManager.withFileSizes([
      {
        sessionId: session.sessionId,
        title: "Sized",
        dateCreated: "0",
        workspaceDirectory: "",
      },
    ]);
    expect(filled.fileBytes).toBe(
      fs.statSync(getSessionFilePath(session.sessionId)).size,
    );
    const [missing] = historyManager.withFileSizes([
      {
        sessionId: "no-such-file",
        title: "",
        dateCreated: "0",
        workspaceDirectory: "",
      },
    ]);
    expect(missing.fileBytes).toBeUndefined();
  });

  test("a save past the budget logs a warning once per session", () => {
    const manager = new HistoryManager(2_000);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      manager.save(sized("under-budget", "small"));
      expect(warn).not.toHaveBeenCalled();

      manager.save(sized("over-budget", "y".repeat(3_000)));
      manager.save(sized("over-budget", "y".repeat(4_000)));
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /over-budget file is \d+ KB, past the 2 KB session budget/,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
