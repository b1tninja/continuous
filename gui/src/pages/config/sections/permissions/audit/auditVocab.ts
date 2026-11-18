import type { AuditAgent } from "core/tools/permissions/audit/record";
import type { AuditStatus } from "core/tools/permissions/audit/listingHandlers";

/** Who decided a call, in the page's words. */
export const BY_LABEL = {
  rules: "Rules",
  reviewer: "Reviewer",
  person: "You",
  system: "System",
} as const;

export const BY_HELP = {
  rules: "Your rules and the level decided this call",
  reviewer: "The reviewer model decided this call",
  person: "You answered the question",
  system: "Continuous decided, with no rule or reviewer",
} as const;

export const KIND_LABEL: Record<AuditAgent["kind"], string> = {
  main: "Main",
  subagent: "Subagent",
  "loop-worker": "Loop worker",
  background: "Background",
};

/** The agent's name for a row: its role when it has one, else its kind. A record with no agent is the main agent's. */
export function agentName(agent: AuditAgent | undefined): string {
  if (!agent) return "Main";
  return agent.role ?? KIND_LABEL[agent.kind];
}

export function agentKindLabel(agent: AuditAgent | undefined): string {
  return KIND_LABEL[agent?.kind ?? "main"];
}

/** "3 min ago", "5 h ago", "2 days ago": coarse on purpose. */
export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

/** How to turn the audit trail on, for the setting that turned it off. */
export function howToTurnOn(status: AuditStatus): string {
  if (status.via === "env") {
    return "It is off because CONTINUE_AUDIT is set to off in the environment. Remove that variable, or set it to on, and restart.";
  }
  return "It is off because config.yaml says audit.enabled: false. Set it to true (or remove the line) and reload.";
}

/** The three filters' options, from the vocabulary of the rules. */
export const DECISION_FILTER_OPTIONS = [
  { value: "", label: "Any decision" },
  { value: "deny", label: "Never (refused)" },
  { value: "ask", label: "Ask (asked first)" },
  { value: "allow", label: "Always (ran without asking)" },
  { value: "reviewer", label: "Decided by the reviewer" },
] as const;
