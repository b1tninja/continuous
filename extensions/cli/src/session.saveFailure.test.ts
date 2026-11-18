import historyManager from "core/util/history.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSession, saveSession, updateSessionHistory } from "./session.js";
import { resetUserNotices, setUserNoticeSink } from "./util/userNotice.js";

function diskFull(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    "ENOSPC: no space left on device, write",
  );
  error.code = "ENOSPC";
  return error;
}

const message = (content: string) => ({
  message: { role: "user" as const, content },
  contextItems: [],
});

describe("a session that cannot be saved", () => {
  let notices: string[];

  beforeEach(() => {
    notices = [];
    resetUserNotices();
    setUserNoticeSink((text) => notices.push(text));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUserNotices();
  });

  it("says so once for the session, however many saves fail", () => {
    vi.spyOn(historyManager, "save").mockImplementation(() => {
      throw diskFull();
    });
    createSession([message("one")], "save-fails-a");

    saveSession();
    updateSessionHistory([message("one"), message("two")]);
    updateSessionHistory([message("one"), message("two"), message("three")]);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("This session is not being saved");
    expect(notices[0]).toContain("ENOSPC: no space left on device");
    expect(notices[0]).toContain("sessions");
    expect(notices[0]).toContain("continues in memory");
    // The conversation is not quoted
    expect(notices[0]).not.toContain("three");
  });

  it("says so again for another session", () => {
    vi.spyOn(historyManager, "save").mockImplementation(() => {
      throw diskFull();
    });
    createSession([message("one")], "save-fails-b");
    saveSession();
    createSession([message("one")], "save-fails-c");
    saveSession();
    expect(notices).toHaveLength(2);
  });

  it("goes to stderr, not stdout, in a run without the terminal UI", () => {
    resetUserNotices();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(historyManager, "save").mockImplementation(() => {
      throw diskFull();
    });
    createSession([message("one")], "save-fails-d");
    saveSession();
    saveSession();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain(
      "This session is not being saved",
    );
    expect(out).not.toHaveBeenCalled();
  });

  it("says nothing when the save works", () => {
    vi.spyOn(historyManager, "save").mockImplementation(() => ({
      rev: null,
      fileBytes: 0,
    }));
    createSession([message("one")], "save-works");
    saveSession();
    expect(notices).toEqual([]);
  });
});
