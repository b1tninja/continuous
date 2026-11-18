/**
 * Which offered tool, if any, is a browser the model can be sent to when a
 * page needs JavaScript (plans/research/web-fetch-large-pages-and-policy.md,
 * sections 7.2 and 7.3). Pure: it reads the tool list as offered and the
 * configured servers, and returns the registered names, never a hard-coded
 * one.
 *
 * A server counts as a browser when its tools include both
 * `browser_navigate` and `browser_snapshot` (the Playwright MCP names), or
 * when its config entry says `category: web` and it offers a tool whose name
 * ends in `navigate`.
 */

import type { Tool } from "../..";

/** The Playwright MCP tool names a browser server is recognised by. */
export const BROWSER_NAVIGATE = "browser_navigate";
export const BROWSER_SNAPSHOT = "browser_snapshot";

/** One offered tool, from the IDE's `Tool` or the CLI's (`browserToolCandidate`, `name`/`mcpServer`/`mcpToolName`). */
export interface OfferedTool {
  /** The name the model calls it by (`playwright_browser_navigate`, or `browser_navigate` in the CLI). */
  name: string;
  /** Its MCP server's name; absent for a built-in. */
  server?: string;
  /** The tool's own name on that server. */
  toolName?: string;
}

/** A configured MCP server, offered or not. */
export interface ConfiguredServer {
  name: string;
  /** `category` from its config entry (`web`). */
  category?: string;
  /** Its tool names when known (from its last connection), to recognise Playwright when it is off. */
  toolNames?: readonly string[];
}

export type BrowserToolFinding =
  /** Tail A: call `navigate`, then `snapshot` when there is one. */
  | {
      kind: "offered";
      server: string;
      navigate: string;
      snapshot?: string;
      /** How it was recognised. */
      by: "tool-names" | "category";
    }
  /** Tail B: configured, but its tools are not offered in this session. */
  | { kind: "configured"; server: string }
  /** Tail C. */
  | { kind: "none" };

/** The IDE's registered `Tool` as the finder reads it: `group` is the server for an MCP tool. */
export function browserToolCandidate(
  tool: Pick<Tool, "function" | "group" | "originalFunctionName" | "uri">,
): OfferedTool {
  const isMcp = tool.uri?.startsWith("mcp://") ?? false;
  return {
    name: tool.function.name,
    ...(isMcp && {
      server: tool.group,
      toolName: tool.originalFunctionName ?? tool.function.name,
    }),
  };
}

function isWeb(server: ConfiguredServer | undefined): boolean {
  return server?.category?.trim().toLowerCase() === "web";
}

/** The tool's own name, or the registered name with the server's prefix taken off. */
function ownName(tool: OfferedTool): string {
  return tool.toolName ?? tool.name;
}

function byOwnName(
  tools: readonly OfferedTool[],
  test: (own: string) => boolean,
): OfferedTool | undefined {
  return tools.find((t) => test(ownName(t)));
}

const isNavigate = (own: string) => own === BROWSER_NAVIGATE;
const isSnapshot = (own: string) => own === BROWSER_SNAPSHOT;
const endsInNavigate = (own: string) => /(^|_)navigate$/i.test(own);
const endsInSnapshot = (own: string) => /(^|_)snapshot$/i.test(own);

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The browser the model can use, from the offered tools and the configured
 * servers. Several match: Playwright's names before `category: web`, then
 * by server name, so the answer does not depend on connection order.
 *
 * An offered tool with no server (a CLI list) still counts when it is named
 * exactly `browser_navigate` / `browser_snapshot` or `<x>_browser_navigate`:
 * its server is then taken from `configured`, or from the prefix.
 */
export function findBrowserTool(
  offered: readonly OfferedTool[],
  configured: readonly ConfiguredServer[] = [],
): BrowserToolFinding {
  const servers = new Map<string, OfferedTool[]>();
  const unattributed: OfferedTool[] = [];
  for (const tool of offered) {
    if (tool.server === undefined) unattributed.push(tool);
    else servers.set(tool.server, [...(servers.get(tool.server) ?? []), tool]);
  }

  // A bare `browser_navigate` (the CLI keeps MCP names bare) or a qualified one
  for (const tool of unattributed) {
    const m = /^(?:(.+)_)?browser_(navigate|snapshot)$/.exec(tool.name);
    if (!m) continue;
    const owner =
      m[1] ??
      configured.find((s) => s.toolNames?.includes(`browser_${m[2]}`))?.name ??
      "browser";
    servers.set(owner, [
      ...(servers.get(owner) ?? []),
      { ...tool, server: owner, toolName: `browser_${m[2]}` },
    ]);
  }

  const config = new Map(configured.map((s) => [s.name, s]));
  const found: Extract<BrowserToolFinding, { kind: "offered" }>[] = [];
  for (const [server, tools] of servers) {
    const navigate = byOwnName(tools, isNavigate);
    const snapshot = byOwnName(tools, isSnapshot);
    if (navigate && snapshot) {
      found.push({
        kind: "offered",
        server,
        navigate: navigate.name,
        snapshot: snapshot.name,
        by: "tool-names",
      });
    } else if (isWeb(config.get(server))) {
      const nav = navigate ?? byOwnName(tools, endsInNavigate);
      if (!nav) continue;
      const snap = snapshot ?? byOwnName(tools, endsInSnapshot);
      found.push({
        kind: "offered",
        server,
        navigate: nav.name,
        ...(snap && { snapshot: snap.name }),
        by: "category",
      });
    }
  }
  found.sort(
    (a, b) =>
      (a.by === b.by ? 0 : a.by === "tool-names" ? -1 : 1) ||
      compareNames(a.server, b.server),
  );
  if (found.length) return found[0];

  // Configured but not offered: a server whose tools are offered is not a browser
  const browsers = configured
    .filter((s) => !servers.has(s.name))
    .filter(
      (s) =>
        isWeb(s) ||
        (s.toolNames?.includes(BROWSER_NAVIGATE) &&
          s.toolNames.includes(BROWSER_SNAPSHOT)),
    )
    .filter(
      (s) =>
        !isWeb(s) || !s.toolNames || s.toolNames.some((n) => endsInNavigate(n)),
    )
    .map((s) => s.name)
    .sort(compareNames);
  return browsers.length
    ? { kind: "configured", server: browsers[0] }
    : { kind: "none" };
}
