import {
  filterToolsForRole,
  roleForMode,
  roleRefusal,
  type PlanMcpTrust,
  type RoleToolRef,
  type ToolRole,
} from "core/tools/roleTools.js";

import { getPolicyExtras } from "../permissions/policyLevels.js";

import type { Tool } from "./types.js";

/**
 * The role table (core/tools/roleTools.ts) for the CLI: the role of the
 * permission mode, the tool as the table sees it, and the two checks, one at
 * exposure and one before a call runs. It only restricts; the permission
 * checks still decide every call this lets through.
 */

/** Plan mode is the planner; every other CLI mode is the agent. */
export function cliToolRole(mode: string | undefined): ToolRole {
  return roleForMode(mode === "plan" ? "plan" : "agent");
}

/** An MCP tool is any tool that is not built in; its server is the one it came from. */
export function cliToolRef(
  tool: Pick<
    Tool,
    "name" | "isBuiltIn" | "mcpServer" | "mcpToolName" | "readonly"
  >,
): RoleToolRef {
  return tool.isBuiltIn
    ? { name: tool.name }
    : {
        name: tool.name,
        mcp: {
          server: tool.mcpServer ?? "",
          tool: tool.mcpToolName ?? tool.name,
          readOnlyHint: tool.readonly === true,
        },
      };
}

/** What the person listed for Plan mode in permissions.yaml. */
export function cliPlanMcpTrust(): PlanMcpTrust {
  const extras = getPolicyExtras();
  return {
    tools: extras.planMcpTools,
    trustedServers: Object.keys(extras.mcpServers ?? {}),
  };
}

const OPTIONS = () => ({
  trust: cliPlanMcpTrust(),
  allowPlanTerminal: getPolicyExtras().planAllowTerminal === true,
});

export function filterCliToolsForRole<T extends Tool>(
  mode: string | undefined,
  tools: T[],
): T[] {
  return filterToolsForRole(cliToolRole(mode), tools, cliToolRef, OPTIONS());
}

/** The error for a call the mode's role may not make, or undefined. */
export function cliRoleRefusal(
  mode: string | undefined,
  tool: Pick<Tool, "name" | "isBuiltIn" | "mcpServer" | "readonly">,
): string | undefined {
  return roleRefusal(cliToolRole(mode), cliToolRef(tool), OPTIONS());
}
