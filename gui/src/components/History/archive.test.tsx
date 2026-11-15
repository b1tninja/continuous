import { act, fireEvent, screen, within } from "@testing-library/react";
import type { BaseSessionMetadata } from "core";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  MAX_ARCHIVED_SESSIONS,
  archiveSessions,
  restoreSessions,
  uiSlice,
} from "../../redux/slices/uiSlice";
import { renderWithProviders } from "../../util/test/render";
import { History } from "./index";
import { splitArchivedSessions } from "./util";

const session = (id: string, title = id): BaseSessionMetadata => ({
  sessionId: id,
  title,
  dateCreated: new Date().toString(),
  workspaceDirectory: "/tmp",
});

describe("archivedSessions (uiSlice)", () => {
  const reduce = uiSlice.reducer;
  const initial = reduce(undefined, { type: "init" });

  it("archives and restores by session id", () => {
    let state = reduce(
      initial,
      archiveSessions({ sessionIds: ["a", "b"], at: 5 }),
    );
    expect(state.archivedSessions).toEqual({ a: 5, b: 5 });
    state = reduce(state, restoreSessions({ sessionIds: ["a"] }));
    expect(state.archivedSessions).toEqual({ b: 5 });
  });

  it("works on state persisted before sessions could be archived", () => {
    const old = { ...initial, archivedSessions: undefined } as any;
    expect(
      reduce(old, archiveSessions({ sessionIds: ["a"], at: 1 }))
        .archivedSessions,
    ).toEqual({ a: 1 });
    expect(
      reduce(old, restoreSessions({ sessionIds: ["a"] })).archivedSessions,
    ).toBeUndefined();
  });

  it("forgets the oldest once it holds more than the cap", () => {
    let state = initial;
    for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 2; i++) {
      state = reduce(state, archiveSessions({ sessionIds: [`s${i}`], at: i }));
    }
    const ids = Object.keys(state.archivedSessions);
    expect(ids).toHaveLength(MAX_ARCHIVED_SESSIONS);
    expect(ids).not.toContain("s0");
    expect(ids).toContain("s2");
  });
});

describe("splitArchivedSessions", () => {
  it("keeps the order and moves archived sessions apart", () => {
    const all = ["a", "b", "c"].map((id) => session(id));
    const { active, archived } = splitArchivedSessions(all, { b: 1 });
    expect(active.map((s) => s.sessionId)).toEqual(["a", "c"]);
    expect(archived.map((s) => s.sessionId)).toEqual(["b"]);
    expect(splitArchivedSessions(all, undefined).archived).toEqual([]);
  });
});

describe("History with archived sessions", () => {
  async function renderHistory() {
    const mockIdeMessenger = new MockIdeMessenger();
    const rendered = await renderWithProviders(<History />, {
      mockIdeMessenger,
    });
    const { setAllSessionMetadata } =
      await import("../../redux/slices/sessionSlice");
    act(() => {
      rendered.store.dispatch(
        setAllSessionMetadata([
          session("one", "First chat"),
          session("two", "Second chat"),
        ]),
      );
    });
    return rendered;
  }

  it("moves an archived session to a collapsed Archived group, and Restore brings it back", async () => {
    const { store } = await renderHistory();
    expect(screen.queryByTestId("history-archived")).toBe(null);

    const row = screen.getByText("Second chat").closest("tr")!;
    fireEvent.mouseEnter(row);
    fireEvent.click(within(row).getByTestId("history-row-archive-1"));
    expect(store.getState().ui.archivedSessions).toEqual({
      two: expect.any(Number),
    });

    // Out of the date groups, into a group that starts closed
    const toggle = screen.getByTestId("history-archived-toggle");
    expect(toggle.textContent).toBe("Archived (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Second chat")).toBe(null);
    expect(screen.getByText("First chat")).toBeTruthy();

    fireEvent.click(toggle);
    const archivedRow = screen.getByText("Second chat").closest("tr")!;
    fireEvent.mouseEnter(archivedRow);
    fireEvent.click(within(archivedRow).getByTestId("history-row-restore-1"));
    expect(store.getState().ui.archivedSessions).toEqual({});
    expect(screen.queryByTestId("history-archived")).toBe(null);
    expect(screen.getByText("Second chat")).toBeTruthy();
  });
});
