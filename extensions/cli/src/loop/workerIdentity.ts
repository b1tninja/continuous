import {
  loopWorkerAgentId,
  loopWorkerAuditAgent,
} from "core/tools/permissions/audit/identity.js";
import type { AuditAgent } from "core/tools/permissions/audit/record.js";

/**
 * Who a Loop worker is, once, for both the agent map (loopWave.ts) and the
 * audit record the worker writes (cliAudit.ts): the id `worker-<item>` and
 * the mode every other host uses (LOOP_WORKER_MODE), from core's identity.
 *
 * The map ignores a second `spawned` for an id, so a worker that runs the
 * same item again (after a failed attempt) gets `worker-<item>~2`: still a
 * worker of that item, and a distinct node.
 */
const attempts = new Map<string, number>();

export function nextWorkerAgent(sessionId: string, itemId: string): AuditAgent {
  const n = (attempts.get(itemId) ?? 0) + 1;
  attempts.set(itemId, n);
  const agent = loopWorkerAuditAgent(sessionId, itemId);
  return n === 1
    ? agent
    : { ...agent, id: `${loopWorkerAgentId(itemId)}~${n}` };
}

export function resetWorkerIdentities(): void {
  attempts.clear();
}
