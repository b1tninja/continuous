import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";

/*
  How long one MCP tool call may take, in milliseconds.

  `toolTimeout` is the server's own setting. Before it existed the call used
  `connectionTimeout`, so a config that raised that one to let slow tools
  finish relied on it; that still holds while `toolTimeout` is not set, so no
  existing config gets a shorter limit. With neither set, the MCP library's
  own limit applies.
*/

/** The limit when neither setting is there: the MCP library's own. */
export const DEFAULT_MCP_TOOL_TIMEOUT = DEFAULT_REQUEST_TIMEOUT_MSEC;

export interface McpToolTimeout {
  ms: number;
  /** Which setting gave the number. */
  from: "toolTimeout" | "connectionTimeout" | "built-in";
}

export function resolveMcpToolTimeout(options: {
  /** `connectionTimeout` */
  timeout?: number;
  toolTimeout?: number;
}): McpToolTimeout {
  if (typeof options.toolTimeout === "number" && options.toolTimeout > 0) {
    return { ms: options.toolTimeout, from: "toolTimeout" };
  }
  if (typeof options.timeout === "number" && options.timeout > 0) {
    return { ms: options.timeout, from: "connectionTimeout" };
  }
  return { ms: DEFAULT_MCP_TOOL_TIMEOUT, from: "built-in" };
}

/** The number handed to the MCP client for one `tools/call`. */
export function mcpToolCallTimeout(options: {
  timeout?: number;
  toolTimeout?: number;
}): number {
  return resolveMcpToolTimeout(options).ms;
}
