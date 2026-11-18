import type {
  ChatHistoryItem,
  LoopState,
  Session,
  SubagentRunState,
} from "core";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setLoop,
  updateSubagentRun,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { getAnnouncement, resetAnnouncer } from "../a11y/announcer";
import { AgentsList } from "./AgentsList";
import { REASONS } from "./agentsPanelModel";

const live = vi.hoisted(() => new Set<string>());

vi.mock("../../util/subagents/registry", () => ({
  stopSubagentRun: vi.fn(() => true),
  answerSubagentApproval: vi.fn(),
  isSubagentRunLive: vi.fn((id: string) => live.has(id)),
  subscribeSubagentRuns: vi.fn(() => () => undefined),
  peekInbox: vi.fn(() => NO_MESSAGES),
  sendToSubagent: vi.fn(() => "queued"),
  cancelInboxMessage: vi.fn(() => true),
  steerInboxMessage: vi.fn(() => true),
}));
const NO_MESSAGES = vi.hoisted(() => [] as const);

vi.mock("../../util/subagents/loopWorkers", () => ({
  stopLoopWorker: vi.fn(() => true),
  isLoopWorkerLive: vi.fn((id: string) => live.has(`worker:${id}`)),
  abortLoopWorkers: vi.fn(() => 0),
  registerLoopWorker: vi.fn(() => () => undefined),
  liveLoopWorkers: vi.fn(() => []),
  WORKER_STOPPED_BY_USER: "Stopped by the user",
  WORKERS_STOPPED_WITH_LOOP: "The loop was stopped",
}));

import { stopLoopWorker } from "../../util/subagents/loopWorkers";
import {
  answerSubagentApproval,
  sendToSubagent,
  stopSubagentRun,
} from "../../util/subagents/registry";

const SECRET = "AKIAIOSFODNN7CANARY0";

const call = (id: string) => ({
  toolCallId: id,
  toolCall: {
    id,
    type: "function" as const,
    function: { name: "subagent", arguments: "{}" },
  },
  status: "calling" as const,
  parsedArgs: {},
});

const run = (over: Partial<SubagentRunState>): SubagentRunState => ({
  agent: "explore",
  prompt: `look for ${SECRET}`,
  status: "running",
  toolCalls: [],
  text: `found ${SECRET}`,
  startedAt: Date.now() - 5000,
  ...over,
});

async function setup(runs: Record<string, Partial<SubagentRunState>>) {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  const item = {
    message: { role: "assistant", content: "" },
    contextItems: [],
    toolCallStates: Object.keys(runs).map(call),
  } as unknown as ChatHistoryItem;
  await renderWithProviders(<AgentsList />, {
    store,
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    store.dispatch(
      newSession({
        sessionId: "s1",
        title: "t",
        workspaceDirectory: "",
        history: [item],
      } as Session),
    );
  });
  await act(async () => {
    for (const [toolCallId, patch] of Object.entries(runs)) {
      store.dispatch(updateSubagentRun({ toolCallId, run: run(patch) }));
    }
  });
  return store;
}

const groupList = (id: string) =>
  screen.queryByTestId(`agents-group-list-${id}`);
const rowIds = (id: string) =>
  within(groupList(id)!)
    .getAllByTestId(/^agent-row-/)
    .map((r) => r.getAttribute("data-testid")!.replace("agent-row-", ""));

beforeEach(() => {
  live.clear();
  vi.mocked(stopSubagentRun).mockClear();
  vi.mocked(stopLoopWorker).mockClear();
  vi.mocked(answerSubagentApproval).mockClear();
  resetAnnouncer();
});

describe("AgentsList", () => {
  it("renders nothing until an agent has been started", async () => {
    await setup({});
    expect(screen.queryByTestId("agents-panel")).toBeNull();
  });

  it("shows the active agents one line each, what waits for you first, with no prompt, answer or tool text", async () => {
    await setup({
      a: {
        agent: "explore",
        model: "Haiku",
        toolCalls: [
          { name: "Bash", summary: `curl ${SECRET}`, status: "calling" },
        ],
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
      b: {
        agent: "reviewer",
        pendingApproval: {
          id: "p",
          toolName: "run_terminal_command",
          summary: `rm -rf ${SECRET}`,
        },
      },
      c: { agent: "writer", status: "completed", endedAt: Date.now() },
      d: { agent: "broken", status: "failed", error: SECRET },
    });

    expect(rowIds("active")).toEqual(["sub-b", "sub-a"]);
    expect(screen.getByTestId("agent-state-sub-a").textContent).toBe("Running");
    expect(screen.getByTestId("agent-state-sub-b").textContent).toBe(
      "Needs you",
    );
    expect(screen.getByTestId("agent-doing-sub-a").textContent).toBe(
      "running a command",
    );
    expect(screen.getByTestId("agent-doing-sub-b").textContent).toBe(
      "waiting for you",
    );
    expect(screen.getByTestId("agents-summary").textContent).toContain(
      "1 waiting for you",
    );
    expect(
      within(screen.getByTestId("agent-row-sub-a")).getByText("1.5k tokens"),
    ).toBeDefined();
    // One line: the row does not wrap, the name truncates with a title
    const open = screen.getByTestId("agent-open-sub-a");
    expect(open.className).toContain("whitespace-nowrap");
    expect(open.className).not.toContain("flex-wrap");
    // No priced usage: unknown, never $0, said once
    expect(screen.queryByTestId("agent-cost-sub-a")).toBeNull();
    expect(screen.getByTestId("agents-cost-unknown").textContent).toBe(
      "Cost: not known for this model",
    );
    expect(screen.getByTestId("agents-toggle").textContent).not.toContain("$");
    expect(document.body.textContent).not.toContain("cost unknown");
    // Nothing of the prompt, the answer, a tool's summary or an approval's
    // text is on a row
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain("curl");
  });

  it("keeps Done collapsed by default with a count, newest first when opened", async () => {
    const now = Date.now();
    await setup({
      a: { agent: "first", status: "completed", endedAt: now - 2000 },
      b: { agent: "second", status: "failed", endedAt: now - 1000 },
      c: { agent: "third", status: "interrupted", endedAt: now },
    });
    expect(screen.queryByTestId("agents-group-active")).toBeNull();
    const toggle = screen.getByTestId("agents-group-toggle-done");
    expect(toggle.textContent).toBe("Done (3)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(groupList("done")).toBeNull();
    // Folded away, the panel is its header and one line per group
    expect(screen.queryByTestId("agents-cost-unknown")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("agents-cost-unknown")).toBeDefined();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(groupList("done")!.id);
    expect(groupList("done")!.getAttribute("aria-label")).toBe("Done");
    expect(rowIds("done")).toEqual(["sub-c", "sub-b", "sub-a"]);
    expect(screen.getByTestId("agent-state-sub-c").textContent).toBe(
      "Interrupted",
    );
    expect(screen.getByTestId("agent-state-sub-b").textContent).toBe("Failed");
  });

  it("archives one ended agent, all of them, and restores one, and says so", async () => {
    const store = await setup({
      a: { agent: "first", status: "completed", endedAt: 1 },
      b: { agent: "second", status: "completed", endedAt: 2 },
      c: { agent: "third", status: "cancelled", endedAt: 3 },
    });
    fireEvent.click(screen.getByTestId("agents-group-toggle-done"));
    // A person's stop reads Stopped, not Interrupted
    expect(screen.getByTestId("agent-state-sub-c").textContent).toBe("Stopped");
    fireEvent.click(screen.getByRole("button", { name: "Archive first" }));
    expect(getAnnouncement("polite").text).toBe("Archived first.");
    expect(Object.keys(store.getState().ui.archivedAgents)).toEqual([
      "main-s1|sub-a",
    ]);
    expect(screen.getByTestId("agents-group-toggle-done").textContent).toBe(
      "Done (2)",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Archive all 2 done agents" }),
    );
    expect(getAnnouncement("polite").text).toBe("Archived 2 agents.");
    expect(screen.queryByTestId("agents-group-done")).toBeNull();
    const archived = screen.getByTestId("agents-group-toggle-archived");
    expect(archived.textContent).toBe("Archived (3)");
    expect(archived.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(archived);
    fireEvent.click(screen.getByRole("button", { name: "Restore second" }));
    expect(getAnnouncement("polite").text).toBe("Restored second to Done.");
    expect(screen.getByTestId("agents-group-toggle-done").textContent).toBe(
      "Done (1)",
    );
  });

  it("offers Stop on a live row only, and Stop reaches the run", async () => {
    live.add("a");
    await setup({ a: { agent: "live" }, b: { agent: "elsewhere" } });
    expect(screen.queryByTestId("agent-stop-sub-b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop live" }));
    expect(stopSubagentRun).toHaveBeenCalledWith("a");
    expect(getAnnouncement("polite").text).toBe("Stopping live.");
  });

  it("opens a subagent's record read-only, with Back to the session, and Escape goes back to the row", async () => {
    await setup({
      a: {
        agent: "explore",
        status: "completed",
        endedAt: Date.now(),
        toolCalls: [{ name: "read_file", summary: "src/a.ts", status: "done" }],
        text: "The answer",
      },
    });
    fireEvent.click(screen.getByTestId("agents-group-toggle-done"));
    fireEvent.click(screen.getByRole("button", { name: "Open explore, Done" }));
    const detail = screen.getByTestId("agent-detail");
    expect(screen.getByRole("region", { name: "explore" })).toBe(detail);
    const back = screen.getByRole("button", { name: "Back to Session" });
    expect(document.activeElement).toBe(back);
    const record = screen.getByRole("region", { name: "Record of explore" });
    expect(record.getAttribute("tabindex")).toBe("0");
    expect(within(record).getByText("read_file")).toBeDefined();
    expect(within(record).getByText("The answer")).toBeDefined();
    expect(screen.queryByTestId("subagent-stop-a")).toBeNull();
    // The list is replaced, not stacked under the record
    expect(screen.queryByTestId("agents-group-done")).toBeNull();

    fireEvent.keyDown(back, { key: "Escape" });
    expect(screen.queryByTestId("agent-detail")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("agent-open-sub-a"));
  });

  it("says why Resume and Delete are not there, without doing anything", async () => {
    const store = await setup({
      a: { agent: "explore", status: "cancelled", endedAt: 1 },
    });
    fireEvent.click(screen.getByTestId("agents-group-toggle-done"));
    fireEvent.click(screen.getByTestId("agent-open-sub-a"));
    const toolbar = screen.getByRole("toolbar", {
      name: "Actions for explore",
    });
    const resume = within(toolbar).getByRole("button", { name: "Resume" });
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(resume.getAttribute("title")).toBe(REASONS.resumeSubagent);
    fireEvent.click(resume);
    expect(screen.getByTestId("agent-detail-note").textContent).toBe(
      REASONS.resumeSubagent,
    );
    const del = within(toolbar).getByRole("button", { name: "Delete" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(del);
    expect(getAnnouncement("polite").text).toBe(REASONS.deleteSubagent);
    expect(store.getState().session.history[0].toolCallStates).toHaveLength(1);
    const stop = within(toolbar).getByRole("button", { name: "Stop" });
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(stop);
    expect(stopSubagentRun).not.toHaveBeenCalled();

    // Archive from the record, then Restore from the same place
    fireEvent.click(within(toolbar).getByRole("button", { name: "Archive" }));
    expect(store.getState().ui.archivedAgents["main-s1|sub-a"]).toBeDefined();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Restore" }));
    expect(store.getState().ui.archivedAgents["main-s1|sub-a"]).toBeUndefined();
  });

  it("offers a message input in a live subagent's record only, and it reaches that run", async () => {
    live.add("a");
    await setup({
      a: { agent: "live" },
      b: { agent: "ended", status: "completed", endedAt: Date.now() },
    });
    fireEvent.click(screen.getByTestId("agent-open-sub-a"));
    const box = screen.getByRole("textbox", { name: "Message live" });
    fireEvent.change(box, { target: { value: "look at b.ts too" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sendToSubagent).toHaveBeenCalledWith("a", "look at b.ts too", {
      steer: false,
    });
    expect(getAnnouncement("polite").text).toBe(
      "Queued for live. It reads it before it finishes.",
    );
    fireEvent.click(screen.getByTestId("agent-detail-back"));

    fireEvent.click(screen.getByTestId("agents-group-toggle-done"));
    fireEvent.click(screen.getByTestId("agent-open-sub-b"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("agent-messages")).toBeNull();
  });

  it("links a waiting approval to the card in the conversation instead of answering it here", async () => {
    await setup({
      a: {
        agent: "reviewer",
        pendingApproval: { id: "p", toolName: "edit_file", summary: "x.ts" },
      },
    });
    fireEvent.click(screen.getByTestId("agent-open-sub-a"));
    expect(screen.queryByTestId("subagent-accept-a")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Answer in the conversation" }),
    );
    expect(answerSubagentApproval).not.toHaveBeenCalled();
    // The card is not rendered in this test, so it says so
    expect(screen.getByTestId("agent-detail-note").textContent).toBe(
      "Its card is not in the conversation.",
    );
  });

  it("scrolls to the subagent's card when it is in the conversation", async () => {
    await setup({ a: { agent: "explore" } });
    const card = document.createElement("div");
    card.setAttribute("data-testid", "subagent-card-a");
    const scroll = vi.fn();
    card.scrollIntoView = scroll;
    document.body.appendChild(card);
    try {
      fireEvent.click(screen.getByTestId("agent-open-sub-a"));
      fireEvent.click(
        screen.getByRole("button", { name: "Show in conversation" }),
      );
      expect(scroll).toHaveBeenCalled();
    } finally {
      card.remove();
    }
  });

  it("lists a Loop worker with its worktree folder; it has no record, and Stop reaches it", async () => {
    const store = await setup({ a: { status: "completed", endedAt: 1 } });
    live.add("worker:3");
    await act(async () => {
      store.dispatch(
        setLoop({
          parallel: [
            {
              itemId: "3",
              worktree: "C:\\Users\\someone\\wt\\item-3",
              startedAt: new Date().toISOString(),
            },
          ],
          items: [{ id: "3", model: { title: "Local" } }],
        } as unknown as LoopState),
      );
    });
    const row = screen.getByTestId("agent-row-worker-3");
    expect(row.textContent).toContain("item 3");
    expect(screen.getByTestId("agent-doing-worker-3").textContent).toBe(
      "item-3",
    );
    expect(document.body.textContent).not.toContain("someone");
    fireEvent.click(screen.getByTestId("agent-open-worker-3"));
    expect(screen.getByTestId("agent-detail-no-transcript").textContent).toBe(
      REASONS.transcriptWorker,
    );
    expect(screen.getByTestId("agent-detail-plan")).toBeDefined();
    fireEvent.click(screen.getByTestId("agent-detail-stop"));
    expect(stopLoopWorker).toHaveBeenCalledWith("3");
  });

  it("collapses the whole panel to its one header line", async () => {
    await setup({ a: {}, b: {} });
    expect(screen.getAllByTestId(/^agent-row-sub-/)).toHaveLength(2);
    fireEvent.click(screen.getByTestId("agents-toggle"));
    expect(screen.queryByTestId("agents-list")).toBeNull();
    expect(
      screen.getByTestId("agents-toggle").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("keeps a very long agent name inside the row: truncated, breakable, with the full name in a title", async () => {
    const long = "a-reviewer-with-an-extremely-long-agent-name-that-never-ends";
    await setup({ a: { agent: long } });
    const name = screen.getByTestId("agent-name-sub-a");
    expect(name.textContent).toBe(long);
    expect(name.getAttribute("title")).toBe(long);
    expect(name.className).toContain("truncate");
    expect(name.className).toContain("[overflow-wrap:anywhere]");
  });

  it("holds many agents: twelve running rows and forty ended ones folded into one Done line", async () => {
    const runs: Record<string, Partial<SubagentRunState>> = {};
    for (let i = 0; i < 12; i++) runs[`r${i}`] = { agent: `agent-${i}` };
    for (let i = 0; i < 40; i++)
      runs[`d${i}`] = { agent: `done-${i}`, status: "completed", endedAt: i };
    await setup(runs);
    expect(rowIds("active")).toHaveLength(12);
    expect(screen.queryAllByTestId(/^agent-row-sub-d/)).toHaveLength(0);
    expect(screen.getByTestId("agents-group-toggle-done").textContent).toBe(
      "Done (40)",
    );
  });
});
