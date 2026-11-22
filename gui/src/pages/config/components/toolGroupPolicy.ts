import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "core";
import {
  DEFAULT_TOOL_SETTING,
  ToolPolicies,
} from "../../../redux/slices/uiSlice";

/**
 * What a whole group can be set to. "Excluded" is not offered: the group's
 * switch already turns every tool of the group off, and keeps their settings.
 */
export type GroupToolPolicy = Exclude<ToolPolicy, "disabled">;

export const GROUP_TOOL_POLICY_LABEL: Record<GroupToolPolicy, string> = {
  allowedWithoutPermission: "Automatic",
  allowedWithPermission: "Ask First",
};

/** The setting a tool has, as the tool list and the policy check read it. */
export function effectiveToolPolicy(
  tool: Tool,
  settings: ToolPolicies,
): ToolPolicy {
  return (
    settings[tool.function.name] ??
    tool.defaultToolPolicy ??
    DEFAULT_TOOL_SETTING
  );
}

/**
 * The tools one group action writes, and how many it leaves alone. A tool is
 * left alone when it is not offered to the model: the person excluded it, or
 * it waits for approval (TR4). Setting those would turn an excluded tool back
 * on, or decide for a tool whose description nobody has read yet.
 */
export function groupPolicyTargets(
  tools: Tool[],
  settings: ToolPolicies,
): { targets: Tool[]; skipped: number } {
  const targets = tools.filter(
    (tool) =>
      !tool.mcpPendingApproval &&
      effectiveToolPolicy(tool, settings) !== "disabled",
  );
  return { targets, skipped: tools.length - targets.length };
}

/** The one setting every target has, or "mixed". Undefined with no targets. */
export function groupPolicyState(
  targets: Tool[],
  settings: ToolPolicies,
): GroupToolPolicy | "mixed" | undefined {
  const found = new Set(targets.map((t) => effectiveToolPolicy(t, settings)));
  if (found.size === 0) {
    return undefined;
  }
  return found.size === 1 ? ([...found][0] as GroupToolPolicy) : "mixed";
}

/** What the group action did, for the line under the group's header. */
export function groupPolicyResultText(
  policy: GroupToolPolicy,
  changed: number,
  skipped: number,
): string {
  const done = `${changed} set to ${GROUP_TOOL_POLICY_LABEL[policy]}.`;
  return skipped > 0
    ? `${done} ${skipped} skipped: excluded or waiting for approval.`
    : done;
}
