import {
  LOOP_WORKER_MODE,
  loopWorkerAgentId,
  mainAgentId,
} from "../../../agents/fromRuns";
import { toolRoleOfMode } from "../../roleTools";
import type { AuditAgent } from "./record";

/** The tool table's role for a mode word, as the audit field. */
const withToolRole = (mode?: string): { toolRole?: string } => {
  const toolRole = toolRoleOfMode(mode);
  return toolRole ? { toolRole } : {};
};

/**
 * Who is calling, for the audit record. The ids are the agent map's
 * (`core/agents/fromRuns.ts`), so a row joins to a node; a test holds the two
 * in step.
 */
export const subagentAgentId = (toolCallId: string) => `sub-${toolCallId}`;
export { LOOP_WORKER_MODE, loopWorkerAgentId };
export const backgroundAgentId = (taskId: string) => `bg-${taskId}`;

export function mainAuditAgent(sessionId: string, mode?: string): AuditAgent {
  return {
    id: mainAgentId(sessionId),
    kind: "main",
    ...(mode ? { mode } : {}),
    ...withToolRole(mode),
  };
}

/** A subagent run for the parent's `subagent` tool call; it runs in the parent's mode. */
export function subagentAuditAgent(
  sessionId: string,
  toolCallId: string,
  role: string,
  mode?: string,
): AuditAgent {
  return {
    id: subagentAgentId(toolCallId),
    kind: "subagent",
    role,
    ...(mode ? { mode } : {}),
    ...withToolRole(mode),
    parentId: mainAgentId(sessionId),
  };
}

export function loopWorkerAuditAgent(
  sessionId: string,
  itemId: string,
  mode: string = LOOP_WORKER_MODE,
): AuditAgent {
  return {
    id: loopWorkerAgentId(itemId),
    kind: "loop-worker",
    role: `item ${itemId}`,
    mode,
    ...withToolRole(mode),
    parentId: mainAgentId(sessionId),
  };
}

/**
 * A background agent: a task the session handed to an agent that runs beside
 * it (the "background" mode of the mode picker). `taskId` is the id the run
 * is known by; `role` names the task's kind, never its prompt.
 */
export function backgroundAuditAgent(
  sessionId: string,
  taskId: string,
  role = "background task",
  mode = "background",
): AuditAgent {
  return {
    id: backgroundAgentId(taskId),
    kind: "background",
    role,
    mode,
    ...withToolRole(mode),
    parentId: mainAgentId(sessionId),
  };
}
