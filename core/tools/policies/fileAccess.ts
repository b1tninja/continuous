import { ToolPolicy } from "@continuedev/terminal-security";

/**
 * What a tool's own policy callback is told beyond its arguments. The
 * evaluator fills it from the safety checks that are on.
 */
export interface ToolPolicyContext {
  /**
   * The outside-workspace check (`ask-outside-paths`) is off, so a path
   * outside the workspace is not asked about because of where it is. Absent
   * means the check is on.
   */
  outsideCheckOff?: boolean;
}

/**
 * Evaluates file access policy based on whether the file is within workspace boundaries
 *
 * @param basePolicy - The base policy from tool definition or user settings
 * @param isWithinWorkspace - Whether the file/directory is within workspace
 * @param context - What the safety checks say; absent keeps every check on
 * @returns The evaluated policy - more restrictive for files outside workspace
 */
export function evaluateFileAccessPolicy(
  basePolicy: ToolPolicy,
  isWithinWorkspace: boolean,
  context?: ToolPolicyContext,
): ToolPolicy {
  // If tool is disabled, keep it disabled
  if (basePolicy === "disabled") {
    return "disabled";
  }

  // Files within workspace use the base policy (typically "allowedWithoutPermission")
  if (isWithinWorkspace) {
    return basePolicy;
  }

  // Where the file is, is itself a safety check; with it off the tool's own
  // setting decides, as it does for a file inside the workspace
  if (context?.outsideCheckOff) {
    return basePolicy;
  }

  // Files outside workspace always require permission for security
  return "allowedWithPermission";
}
