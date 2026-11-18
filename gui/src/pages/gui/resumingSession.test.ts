import { BaseSessionMetadata } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { describe, expect, it } from "vitest";
import {
  expectsSessionToResume,
  expectsStartupResume,
  getResumingTitle,
  RECENT_SESSIONS_LIMIT,
  selectRecentSessions,
} from "./resumingSession";

function meta(
  sessionId: string,
  dateCreated: string,
  title = `Session ${sessionId}`,
): BaseSessionMetadata {
  return { sessionId, title, dateCreated, workspaceDirectory: "" };
}

describe("expectsSessionToResume", () => {
  it("is true for a saved title", () => {
    expect(expectsSessionToResume("Fix the parser")).toBe(true);
  });

  it("is false for the new-session placeholder", () => {
    expect(expectsSessionToResume(NEW_SESSION_TITLE)).toBe(false);
  });

  it("is false for a placeholder with surrounding whitespace", () => {
    expect(expectsSessionToResume(`  ${NEW_SESSION_TITLE} `)).toBe(false);
  });

  it("is false for missing, empty or blank titles", () => {
    expect(expectsSessionToResume(undefined)).toBe(false);
    expect(expectsSessionToResume("")).toBe(false);
    expect(expectsSessionToResume("   ")).toBe(false);
  });
});

describe("expectsStartupResume", () => {
  const here = "file:///Users/me/work/repo";
  const start = (
    sessionWorkspaceDirectory: string | undefined,
    workspaceDirs = [here],
    persistedTitle = "Fix the parser",
  ) =>
    expectsStartupResume({
      persistedTitle,
      sessionWorkspaceDirectory,
      workspaceDirs,
    });

  it("is true for a titled session of this workspace", () => {
    expect(start(here)).toBe(true);
    expect(start("file:///Users/me/work/repo/packages/a")).toBe(true);
  });

  it("is false for another workspace's session (#880 does not reopen it)", () => {
    expect(start("file:///elsewhere/other-repo")).toBe(false);
  });

  it("is false when the session's folder is not on record", () => {
    expect(start(undefined)).toBe(false);
  });

  it("is false for the new-session placeholder", () => {
    expect(start(here, [here], NEW_SESSION_TITLE)).toBe(false);
  });

  it("matches a session without a folder only in a window without one", () => {
    expect(start("", [])).toBe(true);
    expect(start("", [here])).toBe(false);
  });
});

describe("getResumingTitle", () => {
  const list = [meta("a", "1", "Alpha"), meta("b", "2", "Beta")];

  it("uses the saved title from the session list", () => {
    expect(getResumingTitle("b", "a", "Alpha", list)).toBe("Beta");
  });

  it("prefers the list over the persisted title", () => {
    expect(getResumingTitle("a", "a", "Old title", list)).toBe("Alpha");
  });

  it("falls back to the persisted title when loading the current session", () => {
    expect(getResumingTitle("a", "a", "Persisted", [])).toBe("Persisted");
  });

  it("does not use the persisted title for a different session", () => {
    expect(getResumingTitle("z", "a", "Persisted", [])).toBeUndefined();
  });

  it("does not show the placeholder title", () => {
    expect(getResumingTitle("a", "a", NEW_SESSION_TITLE, [])).toBeUndefined();
  });

  it("skips a blank title in the list", () => {
    expect(
      getResumingTitle("a", "a", "Persisted", [meta("a", "1", "  ")]),
    ).toBe("Persisted");
  });
});

describe("selectRecentSessions", () => {
  it("returns an empty list for no sessions", () => {
    expect(selectRecentSessions([], undefined)).toEqual([]);
  });

  it("sorts newest first by ISO date", () => {
    const sessions = [
      meta("old", "2024-01-01T00:00:00Z"),
      meta("new", "2024-03-01T00:00:00Z"),
      meta("mid", "2024-02-01T00:00:00Z"),
    ];
    expect(
      selectRecentSessions(sessions, undefined).map((s) => s.sessionId),
    ).toEqual(["new", "mid", "old"]);
  });

  it("understands epoch-millisecond dates", () => {
    const sessions = [
      meta("old", "1600000000000"),
      meta("new", "1700000000000"),
    ];
    expect(
      selectRecentSessions(sessions, undefined).map((s) => s.sessionId),
    ).toEqual(["new", "old"]);
  });

  it("leaves out the session being loaded", () => {
    const sessions = [meta("a", "1"), meta("b", "2")];
    expect(selectRecentSessions(sessions, "b").map((s) => s.sessionId)).toEqual(
      ["a"],
    );
  });

  it("caps the list at the default limit", () => {
    const sessions = Array.from({ length: RECENT_SESSIONS_LIMIT + 3 }, (_, i) =>
      meta(`s${i}`, `${i + 1}`),
    );
    expect(selectRecentSessions(sessions, undefined)).toHaveLength(
      RECENT_SESSIONS_LIMIT,
    );
  });

  it("honours a custom limit, including zero and negative", () => {
    const sessions = [meta("a", "1"), meta("b", "2"), meta("c", "3")];
    expect(selectRecentSessions(sessions, undefined, 2)).toHaveLength(2);
    expect(selectRecentSessions(sessions, undefined, 0)).toEqual([]);
    expect(selectRecentSessions(sessions, undefined, -1)).toEqual([]);
  });

  it("returns everything when the limit exceeds the list", () => {
    const sessions = [meta("a", "1")];
    expect(selectRecentSessions(sessions, undefined, 10)).toHaveLength(1);
  });

  it("puts sessions with unreadable dates last", () => {
    const sessions = [
      meta("bad", "not a date"),
      meta("good", "2024-01-01T00:00:00Z"),
      meta("bad2", ""),
    ];
    const ids = selectRecentSessions(sessions, undefined).map(
      (s) => s.sessionId,
    );
    expect(ids[0]).toBe("good");
    expect(ids.slice(1).sort()).toEqual(["bad", "bad2"]);
  });

  it("does not mutate the input", () => {
    const sessions = [meta("a", "1"), meta("b", "2")];
    const copy = [...sessions];
    selectRecentSessions(sessions, undefined);
    expect(sessions).toEqual(copy);
  });
});
