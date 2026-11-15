import type { ListedCall } from "core/tools/permissions/audit/listing";
import type { ReactNode } from "react";
import { Button } from "../../../../../components/ui";
import { DecisionChip, DECISION_LABEL } from "../badges";
import { AgentChip, ByChip } from "./AuditChips";
import { formatTime } from "./auditVocab";

/** One call: when, tool, what was decided and by whom, which agent, a masked preview. */
export function AuditRow({
  call,
  onOpen,
  extra,
  below,
  when,
}: {
  call: ListedCall;
  onOpen: () => void;
  extra?: ReactNode;
  below?: ReactNode;
  /** Replaces the time, e.g. "asked 3 h ago" */
  when?: ReactNode;
}) {
  const label = `${call.tool}, ${DECISION_LABEL[call.policy]}, decided by ${call.by}`;
  return (
    <li
      data-testid={`audit-row-${call.callId}`}
      className="list-none rounded-sm border border-solid border-border px-2 py-1"
    >
      <div className="flex flex-wrap items-center gap-1">
        <DecisionChip decision={call.policy} />
        <ByChip by={call.by} />
        <AgentChip agent={call.agent} />
        <span className="text-2xs text-description-muted">
          {when ?? formatTime(call.ts)}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2">
        <strong className="text-xs break-all">{call.tool}</strong>
        <code
          className="min-w-0 flex-1 truncate font-mono text-2xs"
          title={call.summary}
        >
          {call.summary}
        </code>
      </div>
      <div className="mt-1 flex flex-wrap items-start gap-1">
        {/* The same button as "Adopt as rule" beside it, so the two line up */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-6"
          onClick={onOpen}
          aria-label={`Show details: ${label}`}
        >
          Details
        </Button>
        {extra}
      </div>
      {below}
    </li>
  );
}
