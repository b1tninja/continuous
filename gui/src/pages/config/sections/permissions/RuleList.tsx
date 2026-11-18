import type { ReactNode } from "react";
import type { RuleUse } from "core/tools/permissions/audit/auditOverview";
import type {
  AreaReport,
  EffectiveRule,
} from "core/tools/permissions/effectiveRules";
import type { RuleDecision } from "core/tools/permissions/rules";
import { RuleUseNote } from "./AuditOverviewPanel";
import {
  DECISION_LABEL,
  DecisionChip,
  ruleAccessibleName,
  SourceBadge,
  StateBadge,
} from "./badges";

const ORDER: RuleDecision[] = ["deny", "ask", "allow"];

/** What a row can carry beyond the rule: buttons beside it, and a form or note below it. */
export interface RowExtra {
  actions?: ReactNode;
  below?: ReactNode;
}

/** The audit figures of a rule, and how many days the audit covers */
export interface RuleUseInfo {
  use: RuleUse;
  coverageDays: number;
}

export function RuleRow({
  rule,
  highlighted,
  extra,
  useInfo,
}: {
  rule: EffectiveRule;
  highlighted?: boolean;
  extra?: RowExtra;
  useInfo?: RuleUseInfo;
}) {
  return (
    <li
      data-testid={`rule-${rule.id}`}
      aria-label={ruleAccessibleName(rule)}
      className={`list-none rounded-sm border border-solid px-2 py-1 ${
        highlighted ? "border-warning" : "border-border"
      } ${rule.state === "ignored" ? "opacity-75" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-1">
        <DecisionChip decision={rule.decision} />
        <SourceBadge source={rule.source} />
        <StateBadge state={rule.state} locked={rule.locked} />
      </div>
      <code
        className={`mt-1 block font-mono text-2xs break-all ${
          rule.state === "ignored" ? "line-through" : ""
        }`}
      >
        {rule.raw}
      </code>
      {rule.dialect === "cli" && rule.core && (
        <div className="text-2xs text-description-muted">
          In config.yaml:{" "}
          <code className="font-mono break-all">{rule.core}</code>
        </div>
      )}
      {rule.dialect === "core" && rule.cli && (
        <div className="text-2xs text-description-muted">
          In the CLI file:{" "}
          <code className="font-mono break-all">{rule.cli}</code>
        </div>
      )}
      {rule.file && (
        <div className="text-2xs break-all text-description-muted">
          From {rule.file}
        </div>
      )}
      {rule.locked && rule.lockedReason && (
        <div
          className="text-2xs text-description-muted"
          data-testid="locked-reason"
        >
          {rule.lockedReason}
        </div>
      )}
      {useInfo && (
        <RuleUseNote use={useInfo.use} coverageDays={useInfo.coverageDays} />
      )}
      {rule.areaNote && (
        <div className="text-2xs text-description-muted">{rule.areaNote}</div>
      )}
      {rule.state === "ignored" && rule.ignoredReason && (
        <div className="text-2xs text-warning" data-testid="ignored-reason">
          {rule.ignoredReason}
        </div>
      )}
      {rule.warnings.map((w) => (
        <div key={w} className="text-2xs text-warning">
          {w}
        </div>
      ))}
      {extra?.actions && (
        <div className="mt-1 flex flex-wrap gap-1">{extra.actions}</div>
      )}
      {extra?.below && <div className="mt-1">{extra.below}</div>}
    </li>
  );
}

/** The rules of one area, grouped by decision (deny, ask, allow). */
export function RuleList({
  rules,
  highlight,
  extraFor,
  useFor,
  emptyText,
}: {
  rules: EffectiveRule[];
  highlight?: string[];
  extraFor?: (rule: EffectiveRule) => RowExtra | undefined;
  useFor?: (rule: EffectiveRule) => RuleUseInfo | undefined;
  emptyText?: string;
}) {
  if (rules.length === 0) {
    return (
      <p className="my-1 text-xs text-description" data-testid="no-rules">
        {emptyText ??
          "No rules here. Calls are decided by the built-in rules and the level above."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {ORDER.map((decision) => {
        const group = rules.filter((r) => r.decision === decision);
        if (group.length === 0) return null;
        return (
          <section
            key={decision}
            aria-label={`${DECISION_LABEL[decision]} rules`}
            data-testid={`group-${decision}`}
          >
            <h5 className="my-1 text-xs font-semibold">
              {DECISION_LABEL[decision]} ({group.length})
            </h5>
            <ul className="m-0 flex flex-col gap-1 p-0">
              {group.map((r) => (
                <RuleRow
                  key={r.id}
                  rule={r}
                  highlighted={highlight?.includes(r.raw)}
                  extra={extraFor?.(r)}
                  useInfo={useFor?.(r)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function BuiltinList({
  builtins,
}: {
  builtins: AreaReport["builtins"];
}) {
  if (builtins.length === 0) return null;
  return (
    <section aria-label="Built-in rules" data-testid="builtins">
      <h5 className="my-1 text-xs font-semibold">Built-in rules</h5>
      <ul className="m-0 flex flex-col gap-1 p-0">
        {builtins.map((b) => (
          <li
            key={b.id}
            className="list-none rounded-sm border border-solid border-border px-2 py-1"
            data-testid={`builtin-row-${b.id}`}
          >
            <div className="flex flex-wrap items-center gap-1">
              <SourceBadge source="builtin" />
              <span className="inline-block rounded-sm border border-solid border-border px-1 text-2xs text-description">
                Locked
              </span>
              <span
                className={`text-2xs ${b.on ? "text-success" : "text-warning"}`}
              >
                {b.on ? "On" : "Off"}
              </span>
            </div>
            <div className="text-xs">{b.label}</div>
            <div className="text-2xs text-description-muted">
              {b.description}
            </div>
            {b.exemptedBy?.map((rule) => (
              <div
                key={rule}
                className="text-2xs text-warning"
                data-testid={`exempt-${b.id}`}
              >
                Exempted by your Always rule {rule}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
