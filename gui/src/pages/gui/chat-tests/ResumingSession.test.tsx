import { act, screen, waitFor } from "@testing-library/react";
import { Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { newSession } from "../../../redux/slices/sessionSlice";
import { setupStore } from "../../../redux/store";
import { MISSING_SESSION_NOTICE } from "../../../redux/thunks/session";
import { loadDraft, MAIN_DRAFT_INPUT } from "../../../util/drafts";
import { renderWithProviders } from "../../../util/test/render";
import { getMainEditor } from "../../../util/test/utils";
import { Chat } from "../Chat";

const WORKSPACE = "file:///Users/user/workspace1";
const OTHER_WORKSPACE = "file:///Users/user/elsewhere/other-repo";
const RESUMING = "resuming-session";

function saved(
  sessionId: string,
  title: string,
  workspaceDirectory = WORKSPACE,
): Session {
  return {
    sessionId,
    title,
    workspaceDirectory,
    history: [
      {
        message: { id: `${sessionId}-m1`, role: "user", content: "old prompt" },
        contextItems: [],
      },
    ],
  } as unknown as Session;
}

/**
 * A webview starting on the persisted session `s1` (its id, title and folder
 * survive a reload; its history does not), with `history/load` held until
 * the test releases it.
 */
async function startWebview(options: {
  title?: string;
  workspaceDirectory?: string;
}) {
  const title = options.title ?? "Big refactor";
  const workspaceDirectory = options.workspaceDirectory ?? WORKSPACE;
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responses["getWorkspaceDirs"] = [WORKSPACE];
  let pending: ((s: Session) => void) | undefined;
  ideMessenger.responseHandlers["history/load"] = () =>
    new Promise<Session>((resolve) => {
      pending = resolve;
    });
  const store = setupStore({ ideMessenger });
  store.dispatch(
    newSession({
      ...saved("s1", title, workspaceDirectory),
      history: [],
    }),
  );
  const rendered = await renderWithProviders(<Chat />, {
    mockIdeMessenger: ideMessenger,
    store,
  });
  return {
    ...rendered,
    store,
    /** Answers the start-up load once it has been asked for */
    release: async (session: Session) => {
      await waitFor(() => expect(pending).toBeDefined());
      await act(async () => {
        pending!(session);
      });
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  window.workspacePaths = [WORKSPACE];
});
afterEach(() => {
  delete window.workspacePaths;
});

describe("resuming a saved session at start-up", () => {
  it("this workspace's session: the resuming view, then the chat", async () => {
    const { store, release } = await startWebview({});
    expect(screen.getByTestId(RESUMING)).toBeInTheDocument();
    expect(screen.getByText('Loading "Big refactor"…')).toBeInTheDocument();
    // No conversation starters, no Last Session button while it loads
    expect(screen.queryByText("Last Session")).not.toBeInTheDocument();

    await release(saved("s1", "Big refactor"));
    await screen.findByText("old prompt");
    expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument();
    expect(store.getState().session.id).toBe("s1");
  });

  it("another workspace's stored session: no resuming view, a fresh session", async () => {
    const { store, release } = await startWebview({
      workspaceDirectory: OTHER_WORKSPACE,
    });
    expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument();

    await release(saved("s1", "Big refactor", OTHER_WORKSPACE));
    await waitFor(() => expect(store.getState().session.id).not.toBe("s1"));
    expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument();
    expect(screen.queryByText("old prompt")).not.toBeInTheDocument();
  });

  it("a new, empty session (placeholder title): no resuming view", async () => {
    await startWebview({ title: NEW_SESSION_TITLE });
    expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument();
  });

  it("typing during the load keeps the typed text and drops the load", async () => {
    const { store, release } = await startWebview({});
    expect(screen.getByTestId(RESUMING)).toBeInTheDocument();

    const editor = await getMainEditor();
    act(() => {
      editor.chain().focus("end").insertContent("my new question").run();
    });
    await waitFor(() =>
      expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument(),
    );
    const freshId = store.getState().session.id;
    expect(freshId).not.toBe("s1");
    expect(store.getState().session.loadingSessionId).toBeUndefined();

    // The late load changes nothing
    await release(saved("s1", "Big refactor"));
    expect(store.getState().session.id).toBe(freshId);
    expect(store.getState().session.history).toEqual([]);
    expect(screen.queryByText("old prompt")).not.toBeInTheDocument();
    expect(editor.getText()).toBe("my new question");
    // The draft went with the text to the new session, not the loading one
    await waitFor(() =>
      expect(loadDraft(freshId, MAIN_DRAFT_INPUT)).toBeDefined(),
    );
    expect(loadDraft("s1", MAIN_DRAFT_INPUT)).toBeUndefined();
  });

  it("New session during the load: an empty chat the late load leaves alone", async () => {
    const { store, release, user } = await startWebview({});
    await user.click(screen.getByText("Start a new session instead"));
    expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument();
    const freshId = store.getState().session.id;
    expect(freshId).not.toBe("s1");

    await release(saved("s1", "Big refactor"));
    expect(store.getState().session.id).toBe(freshId);
    expect(screen.queryByText("old prompt")).not.toBeInTheDocument();
  });

  it("a session gone to the trash: a usable empty chat and a short notice", async () => {
    const { store, release } = await startWebview({});
    await release({
      sessionId: "s1",
      title: NEW_SESSION_TITLE,
      workspaceDirectory: "",
      history: [],
    } as unknown as Session);
    await screen.findByText(MISSING_SESSION_NOTICE);
    expect(screen.queryByTestId(RESUMING)).not.toBeInTheDocument();
    expect(store.getState().session.id).not.toBe("s1");
    expect(await getMainEditor()).toBeDefined();
  });
});
