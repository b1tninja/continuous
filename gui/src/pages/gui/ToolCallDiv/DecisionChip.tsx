import { modernizeLevelText } from "core/tools/permissions/levelText";
import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import type { ToolCallDecision } from "core";

/** The short words on the chip, by who decided. */
export function decisionLabel(d: ToolCallDecision): string {
  const cat = d.category ? ` [${d.category}]` : "";
  if (d.outcome === "allowed") {
    switch (d.source) {
      case "allow-rule":
        return "Allowed by rule";
      case "auto":
        return "Allowed by Auto";
      case "permissive":
        return "Allowed by Permissive";
      // "yolo": a decision saved by 2.14.x
      case "yolo":
      case "idgaf":
        return "Allowed by IDGAF";
      case "once":
        return "Allowed once by you";
      default:
        return "Allowed";
    }
  }
  switch (d.source) {
    case "deny-rule":
      return "Blocked by rule";
    case "auto":
      return `Blocked by Auto${cat}`;
    case "tool-setting":
      return "Tool turned off";
    default:
      return "Blocked by safety check";
  }
}

/**
 * Why a tool call ran without asking, or was refused: a rule, a switch, IDGAF,
 * or the Auto reviewer's reason. The full sentence is in the tooltip.
 */
export function DecisionChip({
  decision,
}: {
  decision: ToolCallDecision | undefined;
}) {
  if (!decision) return null;
  const blocked = decision.outcome === "blocked";
  // The reason of a decision saved by 2.14.x may say YOLO
  const detail = modernizeLevelText(
    maskCommandForDisplay(
      [decision.reason, decision.rule && `Rule: ${decision.rule}`]
        .filter(Boolean)
        .join("\n"),
    ),
  );
  return (
    <span
      data-testid="decision-chip"
      data-outcome={decision.outcome}
      title={detail || undefined}
      className={`shrink-0 rounded-full px-1.5 text-2xs whitespace-nowrap ${
        blocked ? "bg-error/20 text-error" : "bg-lightgray/20 text-description"
      }`}
    >
      {decisionLabel(decision)}
    </span>
  );
}
