import type { AgentView } from "core/agents/project";
import { describe, expect, it } from "vitest";
import {
  MAX_ARCHIVED_AGENTS,
  archiveAgents,
  restoreAgents,
  uiSlice,
} from "../../redux/slices/uiSlice";
import {
  REASONS,
  agentActions,
  agentArchiveKey,
  groupAgents,
  loopWorkerItemId,
  subagentToolCallId,
} from "./agentsPanelModel";

const node = (over: Partial<AgentView>): AgentView => ({
  id: "sub-x",
  rootId: "main-s1",
  parentId: "main-s1",
  kind: "subagent",
  role: "explore",
  state: "running",
  cost: { self: "unknown", subtree: "unknown" },
  needsYou: false,
  ...over,
});

const ids = (agents: AgentView[]) => agents.map((a) => a.id);

describe("groupAgents", () => {
  it("leaves the session out and splits active from ended", () => {
    const groups = groupAgents([
      node({ id: "main-s1", kind: "main", parentId: undefined }),
      node({ id: "sub-a", state: "running" }),
      node({ id: "sub-b", state: "done", endedAt: 1 }),
      node({ id: "sub-c", state: "failed", endedAt: 2 }),
      node({ id: "sub-d", state: "stopped", endedAt: 3 }),
      node({ id: "sub-e", state: "over-budget", endedAt: 4 }),
    ]);
    expect(ids(groups.active)).toEqual(["sub-a"]);
    expect(ids(groups.done)).toEqual(["sub-e", "sub-d", "sub-c", "sub-b"]);
    expect(groups.archived).toEqual([]);
  });

  it("puts what waits for the person first, then running, then queued, oldest first within each", () => {
    const groups = groupAgents([
      node({ id: "sub-queued", state: "blocked", startedAt: 1 }),
      node({ id: "sub-run-late", state: "running", startedAt: 30 }),
      node({ id: "sub-run-early", state: "running", startedAt: 10 }),
      node({ id: "sub-wait", state: "waiting-approval", startedAt: 50 }),
    ]);
    expect(ids(groups.active)).toEqual([
      "sub-wait",
      "sub-run-early",
      "sub-run-late",
      "sub-queued",
    ]);
  });

  it("sorts ended agents by when they ended, newest first, falling back to the start", () => {
    const groups = groupAgents([
      node({ id: "sub-old", state: "done", endedAt: 100 }),
      node({ id: "sub-new", state: "done", endedAt: 300 }),
      node({ id: "sub-nostamp", state: "done", startedAt: 200 }),
    ]);
    expect(ids(groups.done)).toEqual(["sub-new", "sub-nostamp", "sub-old"]);
  });

  it("moves an archived ended agent to Archived, but never an active one", () => {
    const done = node({ id: "sub-d", state: "done", endedAt: 1 });
    const running = node({ id: "sub-r", state: "running" });
    const groups = groupAgents([done, running], {
      [agentArchiveKey(done)]: 1,
      [agentArchiveKey(running)]: 1,
    });
    expect(ids(groups.archived)).toEqual(["sub-d"]);
    expect(ids(groups.active)).toEqual(["sub-r"]);
    expect(groups.done).toEqual([]);
  });

  it("keys an archived row by its root, since an agent id is unique within a root only", () => {
    const a = node({ id: "worker-1", rootId: "main-s1" });
    const b = node({ id: "worker-1", rootId: "main-s2" });
    expect(agentArchiveKey(a)).not.toBe(agentArchiveKey(b));
  });
});

describe("agentActions", () => {
  it("offers Stop only for a live active run, and Archive only for an ended one", () => {
    const running = node({ state: "running" });
    expect(agentActions(running, true).stop).toEqual({ enabled: true });
    expect(agentActions(running, false).stop).toEqual({
      enabled: false,
      reason: REASONS.stopNotLive,
    });
    expect(agentActions(running, true).archive.enabled).toBe(false);
    const done = node({ state: "done" });
    expect(agentActions(done, false).stop).toEqual({
      enabled: false,
      reason: REASONS.stopEnded,
    });
    expect(agentActions(done, false).archive).toEqual({ enabled: true });
  });

  it("never pretends Resume or Delete exist, and says why for each kind", () => {
    const sub = agentActions(node({ state: "stopped" }), false);
    expect(sub.resume).toEqual({
      enabled: false,
      reason: REASONS.resumeSubagent,
    });
    expect(sub.delete).toEqual({
      enabled: false,
      reason: REASONS.deleteSubagent,
    });
    const worker = agentActions(
      node({ id: "worker-3", kind: "loop-worker", state: "running" }),
      true,
    );
    expect(worker.resume).toEqual({
      enabled: false,
      reason: REASONS.resumeRunning,
    });
    expect(worker.delete).toEqual({
      enabled: false,
      reason: REASONS.deleteWorker,
    });
    expect(worker.transcript).toEqual({
      enabled: false,
      reason: REASONS.transcriptWorker,
    });
    expect(sub.transcript).toEqual({ enabled: true });
  });

  it("maps a node back to its tool call or plan item", () => {
    expect(subagentToolCallId(node({ id: "sub-call-1" }))).toBe("call-1");
    expect(
      loopWorkerItemId(node({ id: "worker-7", kind: "loop-worker" })),
    ).toBe("7");
    expect(
      subagentToolCallId(node({ id: "worker-7", kind: "loop-worker" })),
    ).toBeUndefined();
    expect(loopWorkerItemId(node({ id: "sub-a" }))).toBeUndefined();
  });
});

describe("archivedAgents (uiSlice)", () => {
  const reduce = uiSlice.reducer;
  const initial = reduce(undefined, { type: "init" });

  it("archives and restores by key", () => {
    let state = reduce(initial, archiveAgents({ keys: ["r|a", "r|b"], at: 5 }));
    expect(state.archivedAgents).toEqual({ "r|a": 5, "r|b": 5 });
    state = reduce(state, restoreAgents({ keys: ["r|a"] }));
    expect(state.archivedAgents).toEqual({ "r|b": 5 });
  });

  it("forgets the oldest once it holds more than the cap", () => {
    let state = initial;
    for (let i = 0; i < MAX_ARCHIVED_AGENTS + 3; i++) {
      state = reduce(state, archiveAgents({ keys: [`r|${i}`], at: i }));
    }
    const keys = Object.keys(state.archivedAgents);
    expect(keys).toHaveLength(MAX_ARCHIVED_AGENTS);
    expect(keys).not.toContain("r|0");
    expect(keys).not.toContain("r|2");
    expect(keys).toContain("r|3");
  });
});
