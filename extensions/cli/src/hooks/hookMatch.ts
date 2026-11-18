/**
 * The names a tool event can be matched by. A hook's matcher is tested against
 * the raw `tool_name`, as it always was. For an MCP tool there is one more
 * name, the qualified `mcp__<server>__<tool>` that Claude Code and the
 * permission rules use, so a matcher written for either works here.
 */

import { mcpRuleName } from "core/tools/permissions/names.js";

import { getMatchingHookGroups } from "./hookConfig.js";
import type { HookInput, HookMatcherGroup, HooksConfig } from "./types.js";

/**
 * `mcp__<server>__<tool>` for an event about an MCP tool (the input carries
 * `server`), otherwise undefined. The server name is slugged the same way the
 * permission rules slug it.
 */
export function qualifiedMcpToolName(input: HookInput): string | undefined {
  const { server, tool_name: toolName } = input as {
    server?: unknown;
    tool_name?: unknown;
  };
  if (typeof server !== "string" || !server) return undefined;
  if (typeof toolName !== "string" || !toolName) return undefined;
  return mcpRuleName(server, toolName);
}

/**
 * Groups whose matcher accepts the raw name, plus, for an MCP tool, groups
 * whose matcher names the `mcp__` form and accepts the qualified name. The
 * qualified name is tried only by a matcher that contains `mcp__`, so a
 * matcher written for a built-in tool (`Edit`, `Bash`) never starts to match
 * every tool of a server that happens to be called the same. Raw-name matching
 * is never reduced. Order and identity of the groups are kept.
 */
export function getMatchingGroupsForInput(
  config: HooksConfig,
  eventName: string,
  matcherValue: string | undefined,
  input: HookInput,
): HookMatcherGroup[] {
  const raw = getMatchingHookGroups(config, eventName, matcherValue);
  const qualified = qualifiedMcpToolName(input);
  if (qualified === undefined) return raw;

  const viaAlias = new Set(
    getMatchingHookGroups(config, eventName, qualified).filter((g) =>
      g.matcher?.includes("mcp__"),
    ),
  );
  if (viaAlias.size === 0) return raw;

  const rawSet = new Set(raw);
  const all = config[eventName as keyof HooksConfig] ?? [];
  return all.filter((g) => rawSet.has(g) || viaAlias.has(g));
}
