import type { AgentView } from "core/agents/project";
import { isAgentStateTerminal, type AgentState } from "core/agents/types";

/**
 * The agents panel's groups (plans/research/subagent-sessions-panel.md):
 * what still runs or waits for the person, what has ended, and what the
 * person archived. Pure, so the order and the actions can be tested without
 * rendering. The session's own node is the parent of every row, not a row.
 */

export interface AgentGroups {
  /** Running, waiting for the person or queued; the ones waiting first */
  active: AgentView[];
  /** Ended and not archived, the most recently ended first */
  done: AgentView[];
  /** Ended and archived, the most recently ended first */
  archived: AgentView[];
}

/** Waiting for the person comes first, then running, then queued. */
const ACTIVE_RANK: Partial<Record<AgentState, number>> = {
  "waiting-approval": 0,
  running: 1,
  blocked: 2,
};

/** The key an archived row is remembered by: an agent id is unique within a root only. */
export function agentArchiveKey(agent: Pick<AgentView, "rootId" | "id">) {
  return `${agent.rootId}|${agent.id}`;
}

export function isAgentActive(agent: AgentView): boolean {
  return !isAgentStateTerminal(agent.state);
}

const endedAt = (a: AgentView) => a.endedAt ?? a.startedAt ?? 0;

export function groupAgents(
  nodes: AgentView[],
  archived: Readonly<Record<string, number>> = {},
): AgentGroups {
  const groups: AgentGroups = { active: [], done: [], archived: [] };
  for (const node of nodes) {
    if (node.kind === "main") continue;
    if (isAgentActive(node)) groups.active.push(node);
    else if (archived[agentArchiveKey(node)] !== undefined)
      groups.archived.push(node);
    else groups.done.push(node);
  }
  groups.active.sort(
    (a, b) =>
      (ACTIVE_RANK[a.state] ?? 3) - (ACTIVE_RANK[b.state] ?? 3) ||
      (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  const newestEnd = (a: AgentView, b: AgentView) => endedAt(b) - endedAt(a);
  groups.done.sort(newestEnd);
  groups.archived.sort(newestEnd);
  return groups;
}

/** Why an action cannot be taken, or undefined when it can. */
export type ActionAvailability =
  { enabled: true } | { enabled: false; reason: string };

export interface AgentActions {
  stop: ActionAvailability;
  resume: ActionAvailability;
  archive: ActionAvailability;
  delete: ActionAvailability;
  /** Whether the run's record (prompt, tools by name, answer) can be shown */
  transcript: ActionAvailability;
}

export const REASONS = {
  stopNotLive:
    "This run is not live in this window, so there is nothing to stop.",
  stopEnded: "It has already ended.",
  resumeSubagent:
    "A subagent cannot be resumed: its conversation is kept only while it runs. Ask the session to run it again.",
  resumeWorker:
    "A Loop worker is resumed with the loop, from the loop's status line.",
  resumeRunning: "It is still running.",
  archiveRunning: "Only an ended agent can be archived. Stop it first.",
  deleteSubagent:
    "A subagent's run is part of the parent conversation, which the model has read, so it cannot be deleted from here. Archive hides it; deleting the session deletes it.",
  deleteWorker:
    "A Loop worker's record belongs to the loop. Archive hides it from this list.",
  transcriptWorker:
    "A Loop worker's conversation is not kept. Its result is on the plan.",
} as const;

const yes: ActionAvailability = { enabled: true };
const no = (reason: string): ActionAvailability => ({ enabled: false, reason });

/**
 * What can be done to one agent, from what exists today: Stop for a run that
 * is live in this window (the subagent card's and the loop inbox's Stop),
 * Archive for an ended one. Resume and Delete have no backend yet, so they
 * say why instead of pretending.
 */
export function agentActions(agent: AgentView, live: boolean): AgentActions {
  const active = isAgentActive(agent);
  const worker = agent.kind === "loop-worker";
  return {
    stop: !active
      ? no(REASONS.stopEnded)
      : live
        ? yes
        : no(REASONS.stopNotLive),
    resume: active
      ? no(REASONS.resumeRunning)
      : no(worker ? REASONS.resumeWorker : REASONS.resumeSubagent),
    archive: active ? no(REASONS.archiveRunning) : yes,
    delete: no(worker ? REASONS.deleteWorker : REASONS.deleteSubagent),
    transcript: worker ? no(REASONS.transcriptWorker) : yes,
  };
}

/** The tool call that started a subagent node (`sub-<toolCallId>`). */
export function subagentToolCallId(agent: AgentView): string | undefined {
  return agent.kind === "subagent" && agent.id.startsWith("sub-")
    ? agent.id.slice("sub-".length)
    : undefined;
}

/** The plan item a Loop worker node runs (`worker-<itemId>`). */
export function loopWorkerItemId(agent: AgentView): string | undefined {
  return agent.kind === "loop-worker" && agent.id.startsWith("worker-")
    ? agent.id.slice("worker-".length)
    : undefined;
}
