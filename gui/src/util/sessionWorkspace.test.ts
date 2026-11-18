import type { BaseSessionMetadata, Session } from "core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { newSession } from "../redux/slices/sessionSlice";
import { setupStore } from "../redux/store";
import {
  loadLastSession,
  restoreWorkspaceSession,
} from "../redux/thunks/session";
import {
  groupHistoryByWorkspace,
  lastSessionCandidates,
  MAX_REMEMBERED_WORKSPACES,
  rememberLastSession,
  sessionBelongsToWorkspace,
  workspaceKey,
} from "./sessionWorkspace";

const HERE = "file:///home/me/code/proj";
const OTHER = "file:///home/me/code/other";

const meta = (
  sessionId: string,
  workspaceDirectory: string,
  at: number,
): BaseSessionMetadata => ({
  sessionId,
  title: sessionId,
  dateCreated: String(at),
  workspaceDirectory,
});

const saved = (sessionId: string, workspaceDirectory: string): Session => ({
  sessionId,
  title: sessionId,
  workspaceDirectory,
  history: [
    {
      message: { id: `${sessionId}-m`, role: "user", content: "hi" },
      contextItems: [],
    } as any,
  ],
});

describe("which sessions belong to this window's workspace", () => {
  it("keys a workspace by its first folder, normalised", () => {
    expect(workspaceKey(["file:///c%3A/Code/Proj/", OTHER], true)).toBe(
      "c:/code/proj",
    );
    expect(workspaceKey([], true)).toBe("");
  });

  it("matches any folder of a multi-root workspace, and a CLI path", () => {
    expect(sessionBelongsToWorkspace(OTHER, [HERE, OTHER], false)).toBe(true);
    expect(
      sessionBelongsToWorkspace(
        "C:\\Code\\Proj",
        ["file:///c%3A/code/proj"],
        true,
      ),
    ).toBe(true);
    expect(sessionBelongsToWorkspace(OTHER, [HERE], false)).toBe(false);
  });

  it("gives a window with no folder the sessions saved without one", () => {
    expect(sessionBelongsToWorkspace("", [], false)).toBe(true);
    expect(sessionBelongsToWorkspace(HERE, [], false)).toBe(false);
  });

  it("groups the History list with this workspace first", () => {
    const groups = groupHistoryByWorkspace(
      [
        meta("other-new", OTHER, 300),
        meta("here-old", HERE, 100),
        meta("here-new", HERE, 200),
        meta("none", "", 400),
      ],
      [HERE],
      false,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "…/code/proj",
      "…/code/other",
      "No folder",
    ]);
    expect(groups[0].isCurrent).toBe(true);
    expect(groups[0].sessions.map((s) => s.sessionId)).toEqual([
      "here-new",
      "here-old",
    ]);
  });
});

describe("lastSessionCandidates", () => {
  const sessions = [
    meta("here-new", HERE, 200),
    meta("here-old", HERE, 100),
    meta("other", OTHER, 300),
  ];

  it("prefers the last session of this workspace", () => {
    expect(
      lastSessionCandidates({
        byWorkspace: { [workspaceKey([HERE], false)]: "here-old" },
        legacyLastSessionId: "other",
        sessions,
        workspaceDirs: [HERE],
        caseInsensitive: false,
      }),
    ).toEqual(["here-old", "here-new"]);
  });

  it("uses the old single lastSessionId only when it is a session of this workspace", () => {
    const input = {
      byWorkspace: undefined,
      sessions,
      workspaceDirs: [HERE],
      caseInsensitive: false,
    };
    expect(
      lastSessionCandidates({ ...input, legacyLastSessionId: "other" }),
    ).toEqual(["here-new"]);
    expect(
      lastSessionCandidates({ ...input, legacyLastSessionId: "here-old" }),
    ).toEqual(["here-old", "here-new"]);
  });

  it("offers nothing in a workspace without sessions", () => {
    expect(
      lastSessionCandidates({
        byWorkspace: { [workspaceKey([OTHER], false)]: "other" },
        legacyLastSessionId: "other",
        sessions,
        workspaceDirs: ["file:///home/me/code/new"],
        caseInsensitive: false,
      }),
    ).toEqual([]);
  });

  it("remembers a bounded number of workspaces, the newest kept", () => {
    let map: Record<string, string> | undefined;
    for (let i = 0; i < MAX_REMEMBERED_WORKSPACES + 3; i++) {
      map = rememberLastSession(map, `/w/${i}`, `s${i}`);
    }
    map = rememberLastSession(map, "/w/5", "again");
    expect(Object.keys(map!)).toHaveLength(MAX_REMEMBERED_WORKSPACES);
    expect(map!["/w/0"]).toBeUndefined();
    expect(map!["/w/5"]).toBe("again");
    expect(Object.keys(map!).at(-1)).toBe("/w/5");
  });
});

describe("lastSessionId per workspace (store and thunks)", () => {
  const savedPaths = window.workspacePaths;

  beforeEach(() => {
    window.workspacePaths = [HERE];
  });
  afterEach(() => {
    window.workspacePaths = savedPaths;
  });

  function setup(files: Session[]) {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses.getWorkspaceDirs = [HERE];
    ideMessenger.responses["history/list"] = files.map((s, i) =>
      meta(s.sessionId, s.workspaceDirectory, i),
    );
    ideMessenger.responseHandlers["history/load"] = async ({ id }: any) => {
      const found = files.find((s) => s.sessionId === id);
      if (!found) throw new Error(`no session ${id}`);
      return structuredClone(found) as any;
    };
    const store = setupStore({ ideMessenger });
    return { store, ideMessenger };
  }

  it("records the session left under this window's workspace", () => {
    const { store } = setup([]);
    store.dispatch(newSession(saved("here-1", HERE)));
    store.dispatch(newSession());
    const state = store.getState().session;
    expect(state.lastSessionId).toBe("here-1");
    expect(Object.values(state.lastSessionIdByWorkspace ?? {})).toEqual([
      "here-1",
    ]);
  });

  it("reopens this workspace's last session, not the newer one another window left", async () => {
    const { store } = setup([saved("here-1", HERE), saved("other-1", OTHER)]);
    store.dispatch(newSession(saved("here-1", HERE)));
    store.dispatch(newSession());
    // Another window (same shared storage) left a session of its workspace
    window.workspacePaths = [OTHER];
    store.dispatch(newSession(saved("other-1", OTHER)));
    store.dispatch(newSession());
    window.workspacePaths = [HERE];
    expect(store.getState().session.lastSessionId).toBe("other-1");

    await store.dispatch(loadLastSession());
    expect(store.getState().session.id).toBe("here-1");
  });

  it("migrates the old lastSessionId only when it is this workspace's", async () => {
    const { store } = setup([saved("other-1", OTHER), saved("here-1", HERE)]);
    // State persisted before sessions were remembered per workspace
    store.dispatch(newSession(saved("other-1", OTHER)));
    window.workspacePaths = [OTHER];
    store.dispatch(newSession());
    window.workspacePaths = [HERE];
    expect(store.getState().session.lastSessionIdByWorkspace).toEqual({
      [workspaceKey([OTHER])]: "other-1",
    });

    await store.dispatch(loadLastSession());
    // Falls through to the newest session of this workspace
    expect(store.getState().session.id).toBe("here-1");
  });

  it("does not restore another workspace's session when the window starts", async () => {
    const { store } = setup([saved("other-1", OTHER), saved("here-1", HERE)]);
    store.dispatch(newSession(saved("here-1", HERE)));
    // As the webview starts: the stored id, its messages not loaded yet
    store.dispatch(newSession({ ...saved("other-1", OTHER), history: [] }));
    // The stored id is other-1 (shared storage); this window is HERE
    await store.dispatch(restoreWorkspaceSession({ preferredId: "other-1" }));
    expect(store.getState().session.id).toBe("here-1");

    // A session of this workspace is restored as it was
    await store.dispatch(restoreWorkspaceSession({ preferredId: "here-1" }));
    expect(store.getState().session.id).toBe("here-1");
  });

  it("starts empty with a new id when the stored session is elsewhere and this workspace has none", async () => {
    const { store } = setup([saved("other-1", OTHER)]);
    store.dispatch(newSession({ ...saved("other-1", OTHER), history: [] }));
    await store.dispatch(restoreWorkspaceSession({ preferredId: "other-1" }));
    const state = store.getState().session;
    expect(state.id).not.toBe("other-1");
    expect(state.history).toEqual([]);
  });
});
