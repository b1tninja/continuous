import { MCPServerStatus, MCPTool } from "..";
import { BuiltInToolNames } from "./builtIn";

const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(BuiltInToolNames),
);

/** True when `name` is a built-in tool, such as `read_file`. */
export function isBuiltInToolName(name: string): boolean {
  return BUILT_IN_TOOL_NAMES.has(name);
}

export function getMCPToolName(server: MCPServerStatus, tool: MCPTool) {
  return getToolNameFromMCPServer(server.name, tool.name);
}

/** A server name as used in tool names: lowercase, runs of other characters become one `_`. */
export function mcpServerSlug(serverName: string): string {
  return serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") // Remove leading/trailing underscores
    .replace(/_+/g, "_"); // Replace multiple sequential underscores with single underscore
}

/**
 * The name this server's tool is called by.
 *
 * The server slug only counts as a prefix at a `_` boundary, so a shorter
 * name cannot claim a longer one. The result is never a built-in tool name.
 */
export function getToolNameFromMCPServer(
  serverName: string,
  toolName: string,
): string {
  const serverPrefix = mcpServerSlug(serverName);

  if (
    serverPrefix &&
    toolName.startsWith(`${serverPrefix}_`) &&
    !isBuiltInToolName(toolName)
  ) {
    return toolName;
  }

  const qualified = serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
  if (qualified && !isBuiltInToolName(qualified)) {
    return qualified;
  }

  // The qualified name can still be a built-in. Mark it so it cannot.
  const marked = serverPrefix
    ? `${serverPrefix}_mcp_${toolName}`
    : `mcp_${toolName}`;
  return isBuiltInToolName(marked) ? `mcp_${marked}` : marked;
}

export interface McpToolIdentity {
  serverName: string;
  toolName: string;
}

/** Six hex digits that depend only on the server and the tool, never on order. */
function mcpToolNameSuffix(identity: McpToolIdentity): string {
  let hash = 0x811c9dc5;
  for (const ch of `${identity.serverName}\u0000${identity.toolName}`) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

function countNames(names: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/**
 * The names the model calls a set of MCP tools by, one per item and in the
 * same order, with no two the same.
 *
 * A name nothing else claims is exactly what `getToolNameFromMCPServer` gives
 * (or the bare tool name with `bare`), so rules and habits written for it keep
 * working. Names that collide (`a` with `b_c` and `a_b` with `c` both compose
 * to `a_b_c`) are ALL renamed with a suffix taken from the server and tool, so
 * neither inherits a rule written for the other and the result does not depend
 * on connection order.
 *
 * `bare` keeps the tool's own name unless another server offers it too or it
 * is in `reserved` (the caller's built-in names); those fall back to the
 * server-qualified name.
 */
export function assignMcpToolNames(
  items: readonly McpToolIdentity[],
  options: { bare?: boolean; reserved?: ReadonlySet<string> } = {},
): string[] {
  const reserved = options.reserved ?? new Set<string>();
  const qualified = (item: McpToolIdentity) =>
    getToolNameFromMCPServer(item.serverName, item.toolName);

  let names = items.map((item) =>
    options.bare ? item.toolName : qualified(item),
  );
  if (options.bare) {
    const counts = countNames(names);
    names = names.map((name, i) =>
      counts.get(name)! > 1 || reserved.has(name) ? qualified(items[i]) : name,
    );
  }

  const counts = countNames(names);
  const taken = new Set(
    names.filter((name) => counts.get(name) === 1 && !reserved.has(name)),
  );
  return names.map((name, i) => {
    if (counts.get(name) === 1 && !reserved.has(name)) return name;
    let renamed = `${name}_${mcpToolNameSuffix(items[i])}`;
    while (taken.has(renamed) || reserved.has(renamed)) renamed += "_";
    taken.add(renamed);
    return renamed;
  });
}
