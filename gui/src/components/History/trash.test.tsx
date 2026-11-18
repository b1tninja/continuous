import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BaseSessionMetadata } from "core";
import type { TrashedSession } from "core/util/sessionTrash";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { History } from "./index";

const session = (id: string, title = id): BaseSessionMetadata => ({
  sessionId: id,
  title,
  dateCreated: String(Date.now()),
  workspaceDirectory: "",
});

/**
 * A History page over a fake core: the list and the trash live here, and
 * history/trash, history/restore and history/deleteFromTrash move sessions
 * between them as core does.
 */
async function renderHistory(options: { openElsewhere?: Set<string> } = {}) {
  const messenger = new MockIdeMessenger();
  let live = [session("one", "First chat"), session("two", "Second chat")];
  let trash: TrashedSession[] = [];
  const calls: { type: string; data: unknown }[] = [];
  messenger.responseHandlers["history/list"] = async () => live;
  messenger.responseHandlers["history/listTrash"] = async () => trash;
  messenger.responseHandlers["history/trash"] = async (data) => {
    calls.push({ type: "trash", data });
    if (options.openElsewhere?.has(data.id) && !data.force) {
      return {
        status: "open-elsewhere",
        sessionId: data.id,
        pid: 4242,
        host: "here",
        at: Date.now(),
      };
    }
    const s = live.find((x) => x.sessionId === data.id)!;
    live = live.filter((x) => x.sessionId !== data.id);
    const deletedAt = Date.now();
    trash = [
      {
        sessionId: s.sessionId,
        deletedAt,
        purgeAfter: deletedAt + 7 * 86_400_000,
        metadata: s,
        bytes: 10,
      },
      ...trash,
    ];
    return {
      status: "trashed",
      sessionId: s.sessionId,
      deletedAt,
      purgeAfter: deletedAt + 7 * 86_400_000,
    };
  };
  messenger.responseHandlers["history/restore"] = async ({ id }) => {
    calls.push({ type: "restore", data: id });
    const entry = trash.find((t) => t.sessionId === id)!;
    trash = trash.filter((t) => t.sessionId !== id);
    live = [...live, entry.metadata];
    return entry.metadata;
  };
  messenger.responseHandlers["history/deleteFromTrash"] = async ({ id }) => {
    calls.push({ type: "deleteFromTrash", data: id });
    trash = trash.filter((t) => t.sessionId !== id);
  };
  const rendered = await renderWithProviders(<History />, {
    mockIdeMessenger: messenger,
  });
  const { setAllSessionMetadata } =
    await import("../../redux/slices/sessionSlice");
  act(() => {
    rendered.store.dispatch(setAllSessionMetadata(live));
  });
  return { ...rendered, messenger, calls };
}

describe("History row actions", () => {
  it("are in the page without hovering, and show on hover and focus-within", async () => {
    await renderHistory();
    const row = screen.getByText("Second chat").closest("tr")!;
    const actions = within(row).getByTestId(/history-row-actions-/);
    expect(actions.className).toContain("opacity-0");
    expect(actions.className).toContain("group-focus-within:opacity-100");
    expect(actions.className).toContain("group-hover:opacity-100");
    expect(row.className).toContain("group");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(within(row).getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("a keyboard-only walk deletes a session and restores it with Undo", async () => {
    const user = userEvent.setup();
    const { calls } = await renderHistory();

    // Tab into the list until the "Second chat" row has focus
    const row = screen.getByText("Second chat").closest("tr")!;
    for (let i = 0; i < 30 && document.activeElement !== row; i++) {
      await user.tab();
    }
    expect(document.activeElement).toBe(row);
    // Its actions are reachable with Tab from the row
    await user.tab();
    expect(row.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(row);

    await user.keyboard("{Delete}");
    await waitFor(() => expect(screen.queryByText("Second chat")).toBe(null));
    expect(calls).toContainEqual({
      type: "trash",
      data: { id: "two", force: false },
    });
    const undo = await screen.findByTestId("history-undo-button");
    expect(screen.getByTestId("history-undo").textContent).toContain(
      "moved to the trash",
    );
    // Focus moves to Undo, so Enter undoes
    await waitFor(() => expect(document.activeElement).toBe(undo));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("Second chat")).toBeTruthy());
    expect(calls.some((c) => c.type === "restore" && c.data === "two")).toBe(
      true,
    );
    expect(screen.queryByTestId("history-undo")).toBe(null);
  });
});

describe("History trash", () => {
  it("lists deleted sessions with Restore and Delete permanently", async () => {
    const { store, calls } = await renderHistory();
    const row = screen.getByText("First chat").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const toggle = await screen.findByTestId("history-trash-toggle");
    expect(toggle.textContent).toBe("Trash (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("history-trash-row-0").textContent).toContain(
      "First chat",
    );

    // Delete permanently asks first
    fireEvent.click(screen.getByTestId("history-trash-delete-0"));
    const dialog = store.getState().ui.dialogMessage as any;
    expect(store.getState().ui.showDialog).toBe(true);
    expect(dialog.props.text).toContain("cannot be restored");
    await act(async () => {
      await dialog.props.onConfirm();
    });
    expect(calls).toContainEqual({ type: "deleteFromTrash", data: "one" });
    await waitFor(() =>
      expect(screen.queryByTestId("history-trash")).toBe(null),
    );
  });

  it("Restore in the trash puts the session back", async () => {
    await renderHistory();
    const row = screen.getByText("First chat").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("history-trash-toggle"));
    fireEvent.click(screen.getByTestId("history-trash-restore-0"));
    await waitFor(() =>
      expect(screen.getAllByText("First chat").length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("history-trash")).toBe(null),
    );
  });

  it("asks before trashing a session open in another window", async () => {
    const { store, calls } = await renderHistory({
      openElsewhere: new Set(["two"]),
    });
    const row = screen.getByText("Second chat").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(store.getState().ui.showDialog).toBe(true));
    const dialog = store.getState().ui.dialogMessage as any;
    expect(dialog.props.text).toContain("process 4242");
    // Nothing moved yet
    expect(screen.getByText("Second chat")).toBeTruthy();
    await act(async () => {
      await dialog.props.onConfirm();
    });
    expect(calls).toContainEqual({
      type: "trash",
      data: { id: "two", force: true },
    });
    await waitFor(() => expect(screen.queryByText("Second chat")).toBe(null));
  });
});

describe("History message-text search", () => {
  it("keeps title search instant and adds sessions whose messages match", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { messenger } = await renderHistory();
      const search = vi.fn(async ({ query }: { query: string }) => ({
        query,
        hits: [
          {
            sessionId: "two",
            title: "Second chat",
            score: 3,
            matches: 1,
            snippet: "…the first zebra crossing…",
            role: "user" as const,
          },
        ],
        scanned: 2,
        total: 2,
        skippedLarge: 0,
      }));
      messenger.responseHandlers["history/search"] = search;
      const input = screen.getByPlaceholderText("Search past sessions");

      // A title match shows at once, before core answers
      fireEvent.change(input, { target: { value: "First" } });
      expect(screen.getByText("First chat")).toBeTruthy();
      expect(screen.queryByText("Second chat")).toBe(null);
      expect(
        screen.getByTestId("history-message-search-status").textContent,
      ).toBe("Searching message text…");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(search).toHaveBeenCalledWith({ query: "First" });
      await waitFor(() => expect(screen.getByText("Second chat")).toBeTruthy());
      expect(screen.getByText("…the first zebra crossing…")).toBeTruthy();
      expect(
        screen.getByTestId("history-message-search-status").textContent,
      ).toBe("Message text: 1 session(s) match");

      // Under three characters only titles are searched
      search.mockClear();
      fireEvent.change(input, { target: { value: "Fi" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(search).not.toHaveBeenCalled();
      expect(screen.queryByText("Second chat")).toBe(null);
    } finally {
      vi.useRealTimers();
    }
  });
});
