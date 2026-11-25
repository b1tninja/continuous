import type { ToolPolicy } from "@continuedev/terminal-security";

import type { Tool } from "../..";

import type { CallContext } from "./approval";
import { canonicalRuleName } from "./names";
import { readOnlyClaim } from "./policy";

/** The decision source of a call that waits because the turn is a Plan turn. */
export const PLAN_MODE_SOURCE = "plan-mode" as const;

/**
 * Why it waits, as the prompt shows it. A reason, not a refusal: where nobody
 * can be asked, the surface wraps it in its own refusal sentence.
 */
export const PLAN_MODE_HOLD_REASON =
  "Plan mode asks before anything that changes files or state.";

export interface PlanModeCall {
  /** The tool is marked read-only, or the command was vouched as only reading */
  readOnly: boolean;
  /**
   * "Hold changes in Plan mode" is off (the hold-plan-mode switch): Plan mode
   * holds nothing, so the call runs
   */
  off?: boolean;
}

/**
 * Plan mode looks and plans: nothing that changes the machine runs without the
 * person's say. Given the verdict a call would get outside Plan mode, a call
 * that would run waits instead, unless it only reads. An ask stays an ask and
 * a refusal stays a refusal.
 *
 * It does not matter what would have run the call: the tool's own setting, a
 * level (Permissive, or the reviewer at Automatic) or an allow rule the person
 * wrote. Only its own switch (hold-plan-mode) lifts it, and no level does.
 *
 * The one copy of this rule: the engine applies it (evaluate.ts) for the IDE
 * and the CLI, and the webview calls it for the verdicts it makes itself.
 */
export function planModeVerdict<
  V extends { policy: ToolPolicy; source?: string; reason?: string },
>(verdict: V, call: PlanModeCall): V {
  if (verdict.policy !== "allowedWithoutPermission") return verdict;
  if (call.readOnly || call.off) return verdict;
  return {
    ...verdict,
    policy: "allowedWithPermission",
    source: PLAN_MODE_SOURCE,
    reason: PLAN_MODE_HOLD_REASON,
  } as V;
}

/**
 * Whether a call only reads, for Plan mode: its tool is marked read-only, or
 * it is a terminal command the parser vouched as only reading (`git log`,
 * `ls`), which is how a plan turn looks at the repository. An MCP server's
 * hint counts only where the surface already decided to believe it and set
 * the tool's flag.
 */
export function onlyReads(
  toolName: string,
  tool: Pick<Tool, "readonly"> | undefined,
  call: CallContext,
): boolean {
  if (tool?.readonly) return true;
  return (
    canonicalRuleName(toolName) === "runTerminalCommand" &&
    !!readOnlyClaim(call)?.vouched
  );
}
