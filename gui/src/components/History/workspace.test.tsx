import { act, fireEvent, screen } from "@testing-library/react";
import type { BaseSessionMetadata } from "core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { History } from "./index";

const HERE = "file:///home/me/code/proj";
const OTHER = "file:///home/me/code/other";

const session = (
  id: string,
  title: string,
  workspaceDirectory: string,
  minutesAgo: number,
): BaseSessionMetadata => ({
  sessionId: id,
  title,
  dateCreated: String(Date.now() - minutesAgo * 60_000),
  workspaceDirectory,
});

describe("History grouped by workspace", () => {
  const savedPaths = window.workspacePaths;

  beforeEach(() => {
    window.workspacePaths = [HERE];
  });
  afterEach(() => {
    window.workspacePaths = savedPaths;
  });

  async function renderHistory() {
    const rendered = await renderWithProviders(<History />, {
      mockIdeMessenger: new MockIdeMessenger(),
    });
    const { setAllSessionMetadata } =
      await import("../../redux/slices/sessionSlice");
    act(() => {
      rendered.store.dispatch(
        setAllSessionMetadata([
          session("other-new", "Newest elsewhere", OTHER, 1),
          session("here-old", "Older here", HERE, 30),
          session("here-new", "Newest here", HERE, 10),
          session("none", "Without a folder", "", 5),
        ]),
      );
    });
    return rendered;
  }

  it("shows this workspace first and open, its newest session on top, other folders closed", async () => {
    await renderHistory();

    const groups = screen.getAllByTestId("history-workspace-group");
    expect(groups.map((g) => g.textContent)).toEqual([
      expect.stringContaining("…/code/proj"),
      expect.stringContaining("…/code/other"),
      expect.stringContaining("No folder"),
    ]);
    expect(groups[0].textContent).toContain("this workspace");

    const here = screen.getByTestId("history-workspace-toggle-0");
    expect(here.getAttribute("aria-expanded")).toBe("true");
    expect(here.getAttribute("title")).toBe("/home/me/code/proj");
    expect(screen.getByTestId("history-row-0").textContent).toContain(
      "Newest here",
    );
    expect(screen.getByTestId("history-row-1").textContent).toContain(
      "Older here",
    );

    // Other folders start closed and open on a click
    const other = screen.getByTestId("history-workspace-toggle-1");
    expect(other.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Newest elsewhere")).toBe(null);
    fireEvent.click(other);
    expect(screen.getByText("Newest elsewhere")).toBeTruthy();
  });

  it("opens every group while searching", async () => {
    await renderHistory();
    fireEvent.change(screen.getByPlaceholderText("Search past sessions"), {
      target: { value: "Newest" },
    });
    expect(screen.getByText("Newest here")).toBeTruthy();
    expect(screen.getByText("Newest elsewhere")).toBeTruthy();
    expect(screen.queryByText("Older here")).toBe(null);
  });

  it("can still group by date", async () => {
    await renderHistory();
    fireEvent.click(screen.getByTestId("history-group-by-date"));
    expect(screen.queryAllByTestId("history-workspace-group")).toHaveLength(0);
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Newest elsewhere")).toBeTruthy();
  });
});
