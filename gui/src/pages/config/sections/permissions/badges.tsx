import type {
  EffectiveRule,
  RuleState,
} from "core/tools/permissions/effectiveRules";
import type { RuleDecision, RuleSource } from "core/tools/permissions/rules";
import { cn } from "../../../../util/cn";

export const SOURCE_LABEL: Record<RuleSource, string> = {
  builtin: "Built-in",
  floor: "Locked rule",
  "user-config": "You",
  "permissions-yaml": "CLI file",
  assistant: "Assistant",
  folder: "Workspace",
};

export const SOURCE_HELP: Record<RuleSource, string> = {
  builtin: "A built-in rule: shipped with the product",
  floor:
    "A locked rule (floor:) in your permissions.yaml. It binds at every level below IDGAF; at IDGAF it is recorded, not applied.",
  "user-config": "Your own config.yaml",
  "permissions-yaml":
    "The CLI's lists in your permissions.yaml. Weighed by the CLI first.",
  assistant: "An assistant or hub configuration",
  folder: "A file that came with this workspace",
};

export const DECISION_LABEL: Record<RuleDecision, string> = {
  deny: "Never",
  ask: "Ask",
  allow: "Always",
};

const DECISION_STYLE: Record<RuleDecision, string> = {
  deny: "text-error border-error",
  ask: "text-warning border-warning",
  allow: "text-success border-success",
};

const DECISION_TONE: Record<RuleDecision, string> = {
  deny: "error",
  ask: "warning",
  allow: "ok",
};

const chip =
  "gui-chip inline-block rounded-sm border border-solid px-1 text-2xs leading-4 whitespace-nowrap";

export function DecisionChip({ decision }: { decision: RuleDecision }) {
  return (
    <span
      className={cn(chip, DECISION_STYLE[decision])}
      data-tone={DECISION_TONE[decision]}
    >
      {DECISION_LABEL[decision]}
    </span>
  );
}

export function SourceBadge({ source }: { source: RuleSource }) {
  return (
    <span
      className={cn(chip, "border-border text-description")}
      title={SOURCE_HELP[source]}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

export function StateBadge({
  state,
  locked,
}: {
  state: RuleState;
  locked: boolean;
}) {
  return (
    <>
      {state === "ignored" && (
        <span
          className={cn(chip, "border-warning text-warning")}
          data-tone="warning"
        >
          Ignored
        </span>
      )}
      {locked && (
        <span className={cn(chip, "border-border text-description")}>
          Locked
        </span>
      )}
    </>
  );
}

export function ruleAccessibleName(rule: EffectiveRule): string {
  return `${DECISION_LABEL[rule.decision]} rule ${rule.raw}, from ${SOURCE_LABEL[rule.source]}${rule.state === "ignored" ? ", ignored" : ""}${rule.locked ? ", locked" : ""}`;
}
