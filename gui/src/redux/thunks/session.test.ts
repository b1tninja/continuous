import { Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setAllSessionMetadata,
  setLoadingSessionId,
} from "../slices/sessionSlice";
import { setupStore } from "../store";
import {
  loadLastSession,
  loadSession,
  MISSING_SESSION_NOTICE,
  restoreWorkspaceSession,
  UNREADABLE_SESSION_NOTICE,
} from "./session";

const WORKSPACE = "file:///Users/user/workspace1";
const OTHER_WORKSPACE = "file:///Users/user/elsewhere/other-repo";

function savedSession(
  sessionId: string,
  title = "Saved",
  workspaceDirectory = WORKSPACE,
): Session {
  return {
    sessionId,
    title,
    workspaceDirectory,
    history: [
      {
        message: { id: `${sessionId}-m1`, role: "user", content: "hi" },
        contextItems: [],
      },
    ],
  } as unknown as Session;
}

/** What core answers for a session it does not hold (deleted, trashed) */
function goneSession(sessionId: string): Session {
  return {
    sessionId,
    title: NEW_SESSION_TITLE,
    workspaceDirectory: "",
    history: [],
  } as unknown as Session;
}

/** A store whose `history/load` waits until the test releases it. */
function setup() {
  const messenger = new MockIdeMessenger();
  messenger.responses["getWorkspaceDirs"] = [WORKSPACE];
  const pending = new Map<
    string,
    { resolve: (s: Session) => void; reject: (e: Error) => void }
  >();
  messenger.responseHandlers["history/load"] = ({ id }) =>
    new Promise<Session>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  const store = setupStore({ ideMessenger: messenger });
  const release = (id: string, session = savedSession(id)) =>
    pending.get(id)!.resolve(session);
  const fail = (id: string) => pending.get(id)!.reject(new Error("gone"));
  const waitForRequest = async (id: string) => {
    for (let i = 0; i < 50 && !pending.has(id); i++) {
      await Promise.resolve();
    }
    expect(pending.has(id)).toBe(true);
  };
  return { store, messenger, release, fail, waitForRequest };
}

/** The store as a webview starts on a persisted session (no history yet) */
function startOn(
  store: ReturnType<typeof setup>["store"],
  sessionId: string,
  title = "Saved",
  workspaceDirectory = WORKSPACE,
) {
  store.dispatch(
    newSession({
      ...savedSession(sessionId, title, workspaceDirectory),
      history: [],
    }),
  );
}

beforeEach(() => {
  window.workspacePaths = [WORKSPACE];
});
afterEach(() => {
  delete window.workspacePaths;
});

describe("loadSession", () => {
  it("marks the session as loading until it arrives", async () => {
    const { store, release, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    expect(store.getState().session.loadingSessionId).toBe("a");

    release("a");
    await done;
    const { session } = store.getState();
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.id).toBe("a");
    expect(session.history).toHaveLength(1);
  });

  it("drops the load if the user starts a new session first", async () => {
    const { store, release, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    store.dispatch(newSession());
    const freshId = store.getState().session.id;

    release("a");
    await done;
    const { session } = store.getState();
    expect(session.id).toBe(freshId);
    expect(session.history).toEqual([]);
    expect(session.loadingSessionId).toBeUndefined();
  });

  it("keeps only the most recently requested session", async () => {
    const { store, release, waitForRequest } = setup();
    const first = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    const second = store.dispatch(
      loadSession({ sessionId: "b", saveCurrentSession: false }),
    );
    await waitForRequest("b");

    release("b");
    await second;
    release("a");
    await first;
    expect(store.getState().session.id).toBe("b");
  });

  it("clears the loading mark when the load fails", async () => {
    const { store, fail, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    fail("a");
    const result = await done;
    expect(result.meta.requestStatus).toBe("rejected");
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });

  it("does not clear a newer load when an older one fails", async () => {
    const { store, fail, waitForRequest } = setup();
    const first = store.dispatch(
      loadSession({ sessionId: "a", saveCurrentSession: false }),
    );
    await waitForRequest("a");
    store.dispatch(setLoadingSessionId("b"));
    fail("a");
    await first;
    expect(store.getState().session.loadingSessionId).toBe("b");
  });

  it("a listed session that is gone (trashed) leaves an empty chat and a notice", async () => {
    const { store, release, waitForRequest } = setup();
    store.dispatch(
      setAllSessionMetadata([
        {
          sessionId: "trashed",
          title: "Old work",
          dateCreated: "1",
          workspaceDirectory: WORKSPACE,
        },
      ]),
    );
    const done = store.dispatch(
      loadSession({ sessionId: "trashed", saveCurrentSession: false }),
    );
    await waitForRequest("trashed");
    release("trashed", goneSession("trashed"));
    await done;
    const { session } = store.getState();
    expect(session.id).not.toBe("trashed");
    expect(session.history).toEqual([]);
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.sessionLoadNotice).toBe(MISSING_SESSION_NOTICE);
  });

  it("an id the list does not hold opens empty under that id, as before", async () => {
    const { store, release, waitForRequest } = setup();
    const done = store.dispatch(
      loadSession({ sessionId: "tab-new", saveCurrentSession: false }),
    );
    await waitForRequest("tab-new");
    release("tab-new", goneSession("tab-new"));
    await done;
    const { session } = store.getState();
    expect(session.id).toBe("tab-new");
    expect(session.sessionLoadNotice).toBeUndefined();
  });
});

describe("loadLastSession", () => {
  it("drops the load if the user starts a new session first", async () => {
    const { store, release, waitForRequest } = setup();
    store.dispatch(newSession(savedSession("prev")));
    store.dispatch(newSession()); // this workspace's last session is "prev"
    const done = store.dispatch(loadLastSession());
    await waitForRequest("prev");
    expect(store.getState().session.loadingSessionId).toBe("prev");

    store.dispatch(newSession());
    const freshId = store.getState().session.id;
    release("prev");
    await done;
    expect(store.getState().session.id).toBe(freshId);
  });

  it("skips a remembered session that is gone", async () => {
    const { store, messenger } = setup();
    store.dispatch(newSession(savedSession("prev")));
    store.dispatch(newSession());
    messenger.responseHandlers["history/load"] = async ({ id }) =>
      goneSession(id);
    const before = store.getState().session.id;
    await store.dispatch(loadLastSession());
    const { session } = store.getState();
    expect(session.id).not.toBe("prev");
    expect(session.id).not.toBe(before);
    expect(session.loadingSessionId).toBeUndefined();
  });
});

describe("restoreWorkspaceSession", () => {
  it("loads this workspace's session while the resuming mark is up", async () => {
    const { store, release, waitForRequest } = setup();
    startOn(store, "s1");
    store.dispatch(setLoadingSessionId("s1"));
    const done = store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    await waitForRequest("s1");
    expect(store.getState().session.loadingSessionId).toBe("s1");
    release("s1");
    await done;
    const { session } = store.getState();
    expect(session.id).toBe("s1");
    expect(session.history).toHaveLength(1);
    expect(session.loadingSessionId).toBeUndefined();
  });

  it("another workspace's session: a fresh id and the mark taken down", async () => {
    const { store, release, waitForRequest } = setup();
    startOn(store, "s1", "Theirs", OTHER_WORKSPACE);
    // As if start-up had predicted wrong: the IDE has the final say
    store.dispatch(setLoadingSessionId("s1"));
    const done = store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    await waitForRequest("s1");
    release("s1", savedSession("s1", "Theirs", OTHER_WORKSPACE));
    await done;
    const { session } = store.getState();
    expect(session.id).not.toBe("s1");
    expect(session.history).toEqual([]);
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.sessionLoadNotice).toBeUndefined();
  });

  it("skips when the user already started a new session", async () => {
    const { store } = setup();
    startOn(store, "s1");
    store.dispatch(newSession());
    const freshId = store.getState().session.id;
    await store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    expect(store.getState().session.id).toBe(freshId);
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });

  it("skips when another session is being loaded", async () => {
    const { store } = setup();
    startOn(store, "s1");
    store.dispatch(setLoadingSessionId("other"));
    await store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    expect(store.getState().session.loadingSessionId).toBe("other");
  });

  it("skips when the session already has history", async () => {
    const { store } = setup();
    store.dispatch(newSession(savedSession("a")));
    await store.dispatch(restoreWorkspaceSession({ preferredId: "a" }));
    expect(store.getState().session.history).toHaveLength(1);
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });

  it("drops a load the user moved on from while it was in flight", async () => {
    const { store, release, waitForRequest } = setup();
    startOn(store, "s1");
    store.dispatch(setLoadingSessionId("s1"));
    const done = store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    await waitForRequest("s1");
    store.dispatch(newSession());
    const freshId = store.getState().session.id;
    release("s1");
    await done;
    expect(store.getState().session.id).toBe(freshId);
    expect(store.getState().session.history).toEqual([]);
  });

  it("a session gone to the trash: an empty chat, a fresh id and a notice", async () => {
    const { store, release, waitForRequest } = setup();
    startOn(store, "s1");
    store.dispatch(setLoadingSessionId("s1"));
    const done = store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    await waitForRequest("s1");
    release("s1", goneSession("s1"));
    await done;
    const { session } = store.getState();
    expect(session.id).not.toBe("s1");
    expect(session.history).toEqual([]);
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.sessionLoadNotice).toBe(MISSING_SESSION_NOTICE);
  });

  it("a load that fails: an empty chat, a fresh id and a notice", async () => {
    const { store, fail, waitForRequest } = setup();
    startOn(store, "s1");
    store.dispatch(setLoadingSessionId("s1"));
    const done = store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    await waitForRequest("s1");
    fail("s1");
    await done;
    const { session } = store.getState();
    expect(session.id).not.toBe("s1");
    expect(session.lastSessionId).toBe("s1");
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.sessionLoadNotice).toBe(UNREADABLE_SESSION_NOTICE);
  });

  it("without the resuming mark a failure leaves the session as it is", async () => {
    const { store, fail, waitForRequest } = setup();
    startOn(store, "s1", NEW_SESSION_TITLE);
    const done = store.dispatch(restoreWorkspaceSession({ preferredId: "s1" }));
    await waitForRequest("s1");
    fail("s1");
    await done;
    expect(store.getState().session.id).toBe("s1");
    expect(store.getState().session.sessionLoadNotice).toBeUndefined();
  });
});
