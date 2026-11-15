import { screen, waitFor } from "@testing-library/react";
import { Session } from "core";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { setLoadingSessionId } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { ResumingSessionBody } from "./ResumingSessionBody";

function setup() {
  const ideMessenger = new MockIdeMessenger();
  ideMessenger.responses["history/list"] = [
    {
      title: "Big refactor",
      sessionId: "loading-id",
      dateCreated: "2024-03-01T00:00:00Z",
      workspaceDirectory: "",
    },
    {
      title: "Older chat",
      sessionId: "older-id",
      dateCreated: "2024-01-01T00:00:00Z",
      workspaceDirectory: "file:///work/repo",
    },
  ];
  // Never resolves: the session under test stays loading.
  ideMessenger.responseHandlers["history/load"] = ({ id }) =>
    id === "older-id"
      ? Promise.resolve({
          sessionId: "older-id",
          title: "Older chat",
          workspaceDirectory: "",
          history: [],
        } as unknown as Session)
      : new Promise<Session>(() => {});
  const store = setupStore({ ideMessenger });
  store.dispatch(setLoadingSessionId("loading-id"));
  return { ideMessenger, store };
}

describe("ResumingSessionBody", () => {
  it("names the session being loaded and lists the others", async () => {
    const { ideMessenger, store } = setup();
    await renderWithProviders(
      <ResumingSessionBody loadingSessionId="loading-id" />,
      { mockIdeMessenger: ideMessenger, store },
    );
    expect(
      await screen.findByText('Loading "Big refactor"…'),
    ).toBeInTheDocument();
    expect(screen.getByText("Older chat")).toBeInTheDocument();
    expect(screen.getByText("repo")).toBeInTheDocument();
    // The session being loaded is not offered again in the list.
    expect(screen.queryAllByText("Big refactor")).toHaveLength(0);
  });

  it("starts a new session and drops the pending load", async () => {
    const { ideMessenger, store } = setup();
    const before = store.getState().session.id;
    const { user } = await renderWithProviders(
      <ResumingSessionBody loadingSessionId="loading-id" />,
      { mockIdeMessenger: ideMessenger, store },
    );
    await user.click(screen.getByText("Start a new session instead"));
    const { session } = store.getState();
    expect(session.loadingSessionId).toBeUndefined();
    expect(session.id).not.toBe(before);
  });

  it("opens another session from the list", async () => {
    const { ideMessenger, store } = setup();
    const { user } = await renderWithProviders(
      <ResumingSessionBody loadingSessionId="loading-id" />,
      { mockIdeMessenger: ideMessenger, store },
    );
    await user.click(await screen.findByText("Older chat"));
    await waitFor(() => expect(store.getState().session.id).toBe("older-id"));
    expect(store.getState().session.loadingSessionId).toBeUndefined();
  });
});
