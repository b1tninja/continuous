import { stuckAgentNote } from "../../../util/stuckNotes";
import { detectStuck, type StuckReport } from "../../../util/stuckSignals";
import { clipMasked, maskText } from "./mask";
import type { AuditAgent, AuditRecord } from "./record";
import { agentKeyOf, auditToAgentSteps, MAIN_AGENT } from "./steps";

/**
 * Per-agent stuck detection as something a host can show (ROADMAP S7):
 * `auditToAgentSteps` gives each agent its own steps, so one agent's repeats
 * are not hidden by another's calls; this names the agent that repeats when it
 * is not the main one, so the person (or the main agent) is told which.
 */
export interface StuckAgent {
  /** The agent's id, as in the audit record and the agent map */
  id: string;
  /** What to call it: its role and id, masked and clipped */
  label: string;
  agent: AuditAgent | undefined;
  report: StuckReport;
}

const MAX_LABEL = 60;

/** `Explore (sub-tc1)` or `item 3 (worker-3)`: role when it has one, always the id. */
export function agentLabel(id: string, agent: AuditAgent | undefined): string {
  const text = agent?.role ? `${agent.role} (${id})` : id;
  return clipMasked(maskText(text).text, MAX_LABEL);
}

/** The agents other than the main one whose own steps say they are stuck, worst first. */
export function stuckAgents(records: readonly AuditRecord[]): StuckAgent[] {
  const named = new Map<string, AuditAgent>();
  for (const r of records) {
    const agent = "agent" in r ? r.agent : undefined;
    if (agent && agentKeyOf(agent) !== MAIN_AGENT && !named.has(agent.id)) {
      named.set(agent.id, agent);
    }
  }
  const out: StuckAgent[] = [];
  for (const [id, steps] of auditToAgentSteps(records)) {
    if (id === MAIN_AGENT) continue;
    const report = detectStuck(steps);
    if (report.level === "none") continue;
    const agent = named.get(id);
    out.push({ id, label: agentLabel(id, agent), agent, report });
  }
  const rank = (a: StuckAgent) => (a.report.level === "stuck" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** The note for the worst non-main agent that has one, or undefined. */
export function stuckAgentNoteOf(
  records: readonly AuditRecord[],
): string | undefined {
  for (const a of stuckAgents(records)) {
    const note = stuckAgentNote(a.label, a.report);
    if (note) return note;
  }
  return undefined;
}
