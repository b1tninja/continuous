import type { LoopParallelRun, SubagentRunState } from "..";
import type { SubagentRunStatus } from "../subagents/result";
import { findLastIndex } from "../util/findLast";
import { activityForTool } from "./activity";
import type { AgentNode, AgentState } from "./types";

/**
 * Nodes for what the IDE already keeps: a subagent's run on its tool call and
 * a Loop worker's entry in `loop.parallel`. Only names, states and numbers
 * are read. The run's prompt, answer, tool-call summaries and approval text
 * are not touched, so they cannot reach a view built from these nodes.
 */

const STATE: Record<SubagentRunStatus, AgentState> = {
  queued: "blocked",
  running: "running",
  completed: "done",
  partial: "stopped",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

/** The main node's id for a session */
export const mainAgentId = (sessionId: string) => `main-${sessionId}`;

/** A Loop worker's id, for the node and the audit record alike (audit/identity.ts) */
export const loopWorkerAgentId = (itemId: string) => `worker-${itemId}`;

/**
 * The mode a Loop worker runs in: Agent mode's tools with the loop's three.
 * Loop is not a mode, so the node and the audit record both say "agent" and
 * the kind, `loop-worker`, says it is a worker.
 */
export const LOOP_WORKER_MODE = "agent" as const;

export function subagentRunToNode(
  run: SubagentRunState,
  ids: { toolCallId: string; rootId: string; parentId: string },
): AgentNode {
  const waiting = run.status === "running" && !!run.pendingApproval;
  const node: AgentNode = {
    id: `sub-${ids.toolCallId}`,
    parentId: ids.parentId,
    rootId: ids.rootId,
    kind: "subagent",
    role: run.agent || "subagent",
    state: waiting ? "waiting-approval" : STATE[run.status],
  };
  if (run.model) node.model = run.model;
  if (run.status === "queued") node.blockedOn = { kind: "slot" };
  if (waiting) {
    node.blockedOn = { kind: "approval" };
    node.activity = "waiting for you";
  }
  // Only the name of the call in progress is read, never its summary.
  const callingAt = findLastIndex(run.toolCalls, (c) => c.status === "calling");
  const calling = callingAt >= 0 ? run.toolCalls[callingAt] : undefined;
  if (run.status === "running" && !waiting && calling) {
    node.activity = activityForTool(calling.name);
  }
  if (run.startedAt !== undefined) node.startedAt = run.startedAt;
  if (run.endedAt !== undefined) node.endedAt = run.endedAt;
  if (run.usage) {
    node.tokens = {
      input: run.usage.inputTokens,
      output: run.usage.outputTokens,
      cacheRead: run.usage.cachedTokens ?? 0,
      cacheWrite: 0,
    };
  }
  if (run.status === "interrupted") node.interrupted = true;
  if (run.status === "completed") node.returnedLength = run.text.length;
  return node;
}

/** The last path segment, so a worktree's folder is named but not located. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

export function loopWorkerToNode(
  run: LoopParallelRun,
  ids: { rootId: string; parentId: string; model?: string },
): AgentNode {
  const started = Date.parse(run.startedAt);
  return {
    id: loopWorkerAgentId(run.itemId),
    parentId: ids.parentId,
    rootId: ids.rootId,
    kind: "loop-worker",
    role: `item ${run.itemId}`,
    mode: LOOP_WORKER_MODE,
    state: "running",
    ...(ids.model ? { model: ids.model } : {}),
    ...(Number.isFinite(started) ? { startedAt: started } : {}),
    workspace: {
      kind: "worktree",
      ...(run.worktree ? { name: folderName(run.worktree) } : {}),
    },
  };
}
