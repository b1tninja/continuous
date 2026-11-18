import type { AuditAgent } from "core/tools/permissions/audit/record";
import { cn } from "../../../../../util/cn";
import { agentKindLabel, agentName, BY_HELP, BY_LABEL } from "./auditVocab";

const chip =
  "inline-block rounded-sm border border-solid border-border px-1 text-2xs leading-4 whitespace-nowrap text-description";

/** Who decided: rules, the reviewer, you or the system. */
export function ByChip({ by }: { by: keyof typeof BY_LABEL }) {
  return (
    <span className={chip} title={BY_HELP[by]}>
      {BY_LABEL[by]}
    </span>
  );
}

/** Which agent made the call; a record with no agent was made before agents were recorded, so it is Main. */
export function AgentChip({ agent }: { agent?: AuditAgent }) {
  const name = agentName(agent);
  const kind = agentKindLabel(agent);
  return (
    <span
      className={cn(chip, "max-w-full truncate")}
      title={`${kind} agent${agent?.mode ? `, ${agent.mode} mode` : ""}`}
      data-testid="agent-chip"
    >
      {name === kind ? name : `${kind}: ${name}`}
    </span>
  );
}
