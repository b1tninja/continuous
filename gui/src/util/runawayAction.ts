import type { PolicyLevel } from "core/tools/permissions/policy";
import { parsePolicyLevel } from "core/tools/permissions/policy";

/**
 * What run_terminal_command does when a command's output looks like a
 * runaway (a flood, or the same line over and over), from the Tools level:
 * Permissive lets it run (to its file, up to the file's cap); every
 * other level stops it and tells the model why. Unknown or missing: stop.
 * (plans/research/runaway-command-output.md, section 6)
 */
export function runawayActionForLevel(
  level: PolicyLevel | string | undefined,
): "stop" | "keep-running" {
  const parsed = parsePolicyLevel(level);
  return parsed === "permissive" ? "keep-running" : "stop";
}
