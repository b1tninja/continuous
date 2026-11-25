import {
  filterToolsForRole,
  roleForMode,
  roleRefusal,
  type PlanMcpTrust,
  type RoleToolRef,
  type ToolRole,
} from "core/tools/roleTools.js";

import {
  approvalExtras,
  getPolicyExtras,
} from "../permissions/policyLevels.js";

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
    | "name"
    | "isBuiltIn"
    | "mcpServer"
    | "mcpToolName"
    | "readonly"
    | "mcpPendingApproval"
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
          ...(tool.mcpPendingApproval
            ? { pendingApproval: tool.mcpPendingApproval }
            : {}),
        },
      };
}

let unattended = false;

/**
 * This process runs unattended (headless `-p` or `serve`, a Loop worker): it
 * gets only the MCP tools listed in `background.mcpTools` (TR1, TR25).
 */
export function setCliUnattended(value: boolean): void {
  unattended = value;
}

export function cliIsUnattended(): boolean {
  return unattended;
}

/**
 * "Ask before using an MCP tool you have not approved" is off in this mode (the
 * IDGAF preset, `--auto`): a tool waiting for approval is offered (TR4).
 */
function approvalWaived(mode: string | undefined): boolean {
  try {
    return (
      mode !== "plan" &&
      approvalExtras(mode === "auto" ? "auto" : "normal").builtin?.[
        "approve-mcp-tools"
      ] === false
    );
  } catch {
    return false;
  }
}

/** What the person listed for Plan mode in permissions.yaml. */
export function cliPlanMcpTrust(): PlanMcpTrust {
  const extras = getPolicyExtras();
  return {
    tools: extras.planMcpTools,
    trustedServers: Object.keys(extras.mcpServers ?? {}),
  };
}

const OPTIONS = (mode: string | undefined) => ({
  trust: cliPlanMcpTrust(),
  allowPlanTerminal: getPolicyExtras().planAllowTerminal === true,
  unattended,
  unattendedMcpTools: getPolicyExtras().backgroundMcpTools,
  approvalWaived: approvalWaived(mode),
});

export function filterCliToolsForRole<T extends Tool>(
  mode: string | undefined,
  tools: T[],
): T[] {
  return filterToolsForRole(
    cliToolRole(mode),
    tools,
    cliToolRef,
    OPTIONS(mode),
  );
}

/** The error for a call the mode's role may not make, or undefined. */
export function cliRoleRefusal(
  mode: string | undefined,
  tool: Pick<
    Tool,
    | "name"
    | "isBuiltIn"
    | "mcpServer"
    | "mcpToolName"
    | "readonly"
    | "mcpPendingApproval"
  >,
): string | undefined {
  return roleRefusal(cliToolRole(mode), cliToolRef(tool), OPTIONS(mode));
}
