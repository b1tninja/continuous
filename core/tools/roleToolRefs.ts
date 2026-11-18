import type { Tool } from "..";
import type { RoleToolRef } from "./roleTools";

/**
 * The IDE's tool as the role table sees it. An MCP tool is told by its URI;
 * the server is the tool's group and the tool its name on the server. Its
 * `readonly` already leaves out a server the open folder brought.
 */
export function ideToolRef(tool: Tool): RoleToolRef {
  const name = tool.function.name;
  if (tool.uri?.startsWith("mcp://")) {
    return {
      name,
      mcp: {
        server: tool.group,
        tool: tool.originalFunctionName ?? name,
        readOnlyHint: tool.readonly,
        ...(tool.mcpFromWorkspace ? { fromWorkspace: true } : {}),
        ...(tool.mcpPendingApproval
          ? { pendingApproval: tool.mcpPendingApproval }
          : {}),
      },
    };
  }
  return { name };
}
