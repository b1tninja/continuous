import path from "path";

import { evaluateToolPolicyWithRules } from "core/tools/permissions/evaluate";
import { readPolicyFile } from "core/tools/permissions/settingsFile";
import { getContinueGlobalPath } from "core/util/paths";
import { resolveShell } from "core/util/shell";

import type { ApprovalSettings } from "core/tools/permissions/approval";
import type { ToolPermissions } from "core/tools/permissions/rules";

export interface AgentToolVerdict {
  policy: "allowedWithoutPermission" | "allowedWithPermission" | "disabled";
  reason?: string;
  source?: string;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * A VS Code tool call as the core engine sees it, so deny rules, floor rules
 * and protected paths apply in the Agents window.
 */
export function vscodeToolToCoreCall(
  name: string,
  args: Record<string, unknown>,
): { toolName: string; parsedArgs: Record<string, unknown> } {
  const lower = name.toLowerCase();
  const command = stringArg(args, "command") ?? stringArg(args, "cmd");
  if (
    command &&
    (lower.includes("terminal") ||
      lower.includes("shell") ||
      lower.includes("bash") ||
      "command" in args ||
      "cmd" in args)
  ) {
    return { toolName: "run_terminal_command", parsedArgs: { command } };
  }
  const file =
    stringArg(args, "filepath") ??
    stringArg(args, "filePath") ??
    stringArg(args, "file") ??
    stringArg(args, "path") ??
    stringArg(args, "uri") ??
    stringArg(args, "dirPath") ??
    stringArg(args, "directory");
  if (file && /write|edit|create|delete|patch|replace|apply|save/.test(lower)) {
    return { toolName: "edit_existing_file", parsedArgs: { filepath: file } };
  }
  if (file && /list|dir|folder|\bls\b/.test(lower)) {
    return { toolName: "ls", parsedArgs: { dirPath: file } };
  }
  if (file) {
    return { toolName: "read_file", parsedArgs: { filepath: file } };
  }
  const query = stringArg(args, "query") ?? stringArg(args, "pattern");
  if (query && /grep|search|find/.test(lower)) {
    return { toolName: "grep_search", parsedArgs: { query } };
  }
  return { toolName: name, parsedArgs: args };
}

/** Levels, switches and floor from the settings file the IDE and CLI share. */
export function agentSessionApproval(file?: string): ApprovalSettings {
  const { settings } = readPolicyFile(
    file ?? path.join(getContinueGlobalPath(), "permissions.yaml"),
  );
  return {
    levels: settings.levels,
    ...(settings.builtin ? { builtin: settings.builtin } : {}),
    ...(settings.floor?.length ? { floor: settings.floor } : {}),
  };
}

/** Continuous's rules for one Agents-window tool call. */
export function decideAgentSessionTool(
  name: string,
  args: Record<string, unknown>,
  options: {
    permissions?: ToolPermissions;
    approval?: ApprovalSettings;
    cwd?: string;
  } = {},
): AgentToolVerdict {
  const call = vscodeToolToCoreCall(name, args);
  const result = evaluateToolPolicyWithRules({
    tool: {
      group: "VS Code",
      readonly: false,
      evaluateToolCallPolicy: (base) => base,
    },
    toolName: call.toolName,
    basePolicy: "allowedWithPermission",
    parsedArgs: call.parsedArgs,
    permissions: options.permissions,
    approval: options.approval,
    cwd: options.cwd,
    shell: resolveShell().kind,
  });
  return {
    policy: result.policy,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.source ? { source: result.source } : {}),
  };
}
