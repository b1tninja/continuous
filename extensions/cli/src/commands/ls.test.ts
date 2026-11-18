import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as sessionModule from "../session.js";

import { chat } from "./chat.js";
import { listSessionsCommand } from "./ls.js";
import { pickSession } from "./resumePicker.js";

// Mock the session module
vi.mock("../session.js", () => ({
  listSessionsForWorkspace: vi.fn(),
  loadSessionById: vi.fn(),
  setResumeSessionId: vi.fn(),
}));

// Mock the TUI components
vi.mock("../ui/SessionSelector.js", () => ({
  SessionSelector: () => null,
}));

// The picker resolves with the chosen session id
vi.mock("./resumePicker.js", () => ({
  pickSession: vi.fn(),
}));

// Mock ink
vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn() })),
}));

// Mock react with createContext
vi.mock("react", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createElement: vi.fn(),
    createContext: vi.fn(() => ({ Provider: vi.fn(), Consumer: vi.fn() })),
  };
});

// Mock the chat command
vi.mock("./chat.js", () => ({
  chat: vi.fn(),
}));

// Mock the remote command
vi.mock("./remote.js", () => ({
  remote: vi.fn(),
}));

describe("listSessionsCommand", () => {
  const mockListSessions = vi.mocked(sessionModule.listSessionsForWorkspace);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should output JSON format when format is json", async () => {
    const mockSessions = [
      {
        sessionId: "session-1",
        title: "Session 1",
        dateCreated: "2023-01-01T10:00:00.000Z",
        workspaceDirectory: "/workspace",
        firstUserMessage: "Hello world",
        isRemote: false,
        inWorkspace: true,
        workspaceGroup: "~/workspace",
      },
      {
        sessionId: "session-2",
        title: "Session 2",
        dateCreated: "2023-01-01T09:00:00.000Z",
        workspaceDirectory: "/workspace",
        firstUserMessage: "Test message",
        isRemote: true,
        remoteId: "agent-123",
        inWorkspace: false,
        workspaceGroup: "~/other",
      },
    ];

    mockListSessions.mockResolvedValue(mockSessions);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await listSessionsCommand({ format: "json" });

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          sessions: [
            {
              id: "session-1",
              timestamp: "2023-01-01T10:00:00.000Z",
              workspaceDirectory: "/workspace",
              title: "Session 1",
              firstUserMessage: "Hello world",
              isRemote: false,
              remoteId: undefined,
              inWorkspace: true,
              workspaceGroup: "~/workspace",
            },
            {
              id: "session-2",
              timestamp: "2023-01-01T09:00:00.000Z",
              workspaceDirectory: "/workspace",
              title: "Session 2",
              firstUserMessage: "Test message",
              isRemote: true,
              remoteId: "agent-123",
              inWorkspace: false,
              workspaceGroup: "~/other",
            },
          ],
        },
        null,
        2,
      ),
    );

    consoleSpy.mockRestore();
  });

  it("should call listSessions without limit restrictions", async () => {
    mockListSessions.mockResolvedValue([]);

    // JSON mode - should call listSessions (implementation decides limit)
    await listSessionsCommand({ format: "json" });
    expect(mockListSessions).toHaveBeenCalled();

    // TUI mode - should call listSessions (implementation decides limit)
    await listSessionsCommand({});
    expect(mockListSessions).toHaveBeenCalled();

    // Verify it was called twice total
    expect(mockListSessions).toHaveBeenCalledTimes(2);
  });

  it("should handle empty sessions gracefully in JSON mode", async () => {
    mockListSessions.mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await listSessionsCommand({ format: "json" });

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ sessions: [] }, null, 2),
    );

    consoleSpy.mockRestore();
  });

  it("should handle empty sessions gracefully in TUI mode", async () => {
    mockListSessions.mockResolvedValue([]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await listSessionsCommand({});

    expect(consoleSpy).toHaveBeenCalledWith(
      "No previous sessions found. Start a new conversation with: cn",
    );

    consoleSpy.mockRestore();
  });

  it("shows the sessions in workspace order and resumes exactly the one picked", async () => {
    const ordered = [
      {
        sessionId: "here-newest",
        title: "Newest here",
        dateCreated: "2023-01-01T08:00:00.000Z",
        workspaceDirectory: "/workspace",
        inWorkspace: true,
        workspaceGroup: "~/workspace",
      },
      {
        sessionId: "elsewhere",
        title: "Elsewhere",
        dateCreated: "2023-01-01T10:00:00.000Z",
        workspaceDirectory: "/other",
        inWorkspace: false,
        workspaceGroup: "~/other",
      },
    ];
    mockListSessions.mockResolvedValue(ordered);
    vi.mocked(pickSession).mockResolvedValue("elsewhere");
    vi.mocked(sessionModule.loadSessionById).mockReturnValue({
      sessionId: "elsewhere",
      title: "Elsewhere",
      workspaceDirectory: "/other",
      history: [],
    });

    await listSessionsCommand({});

    // The picker gets the list as ordered: its first row is selected
    expect(vi.mocked(pickSession).mock.calls[0][0]).toBe(ordered);
    expect(sessionModule.setResumeSessionId).toHaveBeenCalledWith("elsewhere");
    expect(chat).toHaveBeenCalledWith(undefined, {
      resume: true,
      headless: false,
    });
  });

  it("starts nothing when the picker is left", async () => {
    mockListSessions.mockResolvedValue([
      {
        sessionId: "s",
        title: "S",
        dateCreated: "2023-01-01T08:00:00.000Z",
        workspaceDirectory: "/workspace",
      },
    ]);
    vi.mocked(pickSession).mockResolvedValue(null);

    await listSessionsCommand({});

    expect(sessionModule.setResumeSessionId).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});
