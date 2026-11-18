import { parse } from "yaml";

/**
 * Whether the PERSON vouches for an MCP server, so that its own claims about
 * its tools (`annotations.readOnlyHint`) may be believed. The MCP spec says to
 * treat annotations as untrusted unless the server is trusted.
 *
 * A server is trusted when it is
 * - not from the open folder (a repository can bring a server under any name),
 *   and one of
 * - named `trusted` under `mcpServers` in the person's permissions.yaml,
 * - written inline in the person's own config.yaml, or
 * - defined by a file under the person's global folder.
 * Anything else (a hub assistant, a flag, an unknown origin) is not trusted:
 * its hint is ignored and the tool is treated as one nobody vouched for.
 */
export interface McpTrustContext {
  workspaceDirs: readonly string[];
  /** Names marked `trusted` in the person's permissions.yaml */
  trustedServers?: readonly string[];
  /** Names of servers written inline in the person's own config.yaml */
  userConfigServers?: ReadonlySet<string>;
  /** The person's global folder (for example `~/.continue`) */
  globalDir?: string;
  /** Whether a file lies inside a folder (both may be paths or URIs); defaults to a prefix test */
  isInside?: (file: string, dir: string) => boolean;
}

export function mcpServerIsTrusted(
  server: { name: string; sourceFile?: string },
  ctx: McpTrustContext,
): boolean {
  const { sourceFile } = server;
  const inside = ctx.isInside ?? ((file, dir) => file.startsWith(dir));
  if (sourceFile && ctx.workspaceDirs.some((dir) => inside(sourceFile, dir))) {
    return false;
  }
  if (ctx.trustedServers?.includes(server.name)) return true;
  if (ctx.userConfigServers?.has(server.name) && !sourceFile) return true;
  return !!sourceFile && !!ctx.globalDir && inside(sourceFile, ctx.globalDir);
}

/**
 * Whether to believe a tool's `readOnlyHint`: only from a trusted server. A
 * tool that is not believed read-only is treated like any other tool: it asks.
 */
export function mcpToolIsReadOnly(
  tool: { annotations?: { readOnlyHint?: boolean } },
  server: { name: string; sourceFile?: string },
  ctx: McpTrustContext,
): boolean {
  return (
    tool.annotations?.readOnlyHint === true && mcpServerIsTrusted(server, ctx)
  );
}

/** The names of the servers written inline (not by `uses:`) in a config.yaml. */
export function inlineMcpServerNames(yamlText: string): Set<string> {
  const names = new Set<string>();
  try {
    const doc = parse(yamlText) as { mcpServers?: unknown } | null;
    if (Array.isArray(doc?.mcpServers)) {
      for (const entry of doc.mcpServers) {
        const name = (entry as { name?: unknown } | null)?.name;
        if (typeof name === "string" && !("uses" in (entry as object))) {
          names.add(name);
        }
      }
    }
  } catch {
    // an unreadable file vouches for nothing
  }
  return names;
}
