import { useId, type ReactNode } from "react";
import { DECISION_FILTER_OPTIONS } from "./auditVocab";

export interface AuditFilterValues {
  agent: string;
  decision: string;
  tool: string;
}

export const NO_FILTERS: AuditFilterValues = {
  agent: "",
  decision: "",
  tool: "",
};

const select =
  "box-border min-h-6 w-full min-w-0 rounded border border-solid border-border bg-input px-1 text-xs text-foreground";

/** Agent, decision and tool selects. The options come from what was read. */
export function AuditFilters({
  value,
  onChange,
  agents,
  tools,
  show = ["agent", "decision", "tool"],
}: {
  value: AuditFilterValues;
  onChange: (next: AuditFilterValues) => void;
  agents: string[];
  tools: string[];
  show?: (keyof AuditFilterValues)[];
}) {
  const id = useId();
  const set =
    (k: keyof AuditFilterValues) => (e: { target: { value: string } }) =>
      onChange({ ...value, [k]: e.target.value });
  const field = (k: keyof AuditFilterValues, label: string, body: ReactNode) =>
    show.includes(k) && (
      <div className="flex min-w-32 flex-1 flex-col gap-0.5">
        <label className="text-2xs" htmlFor={`${id}-${k}`}>
          {label}
        </label>
        {body}
      </div>
    );
  return (
    <div
      role="group"
      aria-label="Filter the audit list"
      className="mb-2 flex flex-wrap gap-2"
      data-testid="audit-filters"
    >
      {field(
        "agent",
        "Agent",
        <select
          id={`${id}-agent`}
          className={select}
          value={value.agent}
          onChange={set("agent")}
        >
          <option value="">Any agent</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a === "main" ? "Main (and older records)" : a}
            </option>
          ))}
        </select>,
      )}
      {field(
        "decision",
        "Decision",
        <select
          id={`${id}-decision`}
          className={select}
          value={value.decision}
          onChange={set("decision")}
        >
          {DECISION_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>,
      )}
      {field(
        "tool",
        "Tool",
        <select
          id={`${id}-tool`}
          className={select}
          value={value.tool}
          onChange={set("tool")}
        >
          <option value="">Any tool</option>
          {tools.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>,
      )}
    </div>
  );
}
