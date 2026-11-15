import {
  calledToolNames,
  pendingApprovalText,
} from "core/context/mcp/mcpApprovalHold.js";
import { announcePins } from "core/context/mcp/mcpPinNotices.js";
import {
  adoptFromHistory,
  adoptLegacyPin,
  approveTools,
  evaluatePins,
  getToolPinStore,
  launchSpec,
  pinKey,
  recordApproval,
  type ApprovalEvents,
} from "core/context/mcp/mcpToolPins.js";
import type { McpPendingApproval } from "core/tools/roleTools.js";
import { getContinueGlobalPath } from "core/util/paths.js";

import { getErrorString } from "../util/error.js";
import { logger } from "../util/logger.js";

/**
 * The CLI's side of TR4 (core/context/mcp/mcpApprovalHold.ts): which MCP
 * tools wait for the person's approval, `/mcp approve`, and the upgrade rule
 * that keeps the servers someone already used approved. MCPService holds the
 * connections; this holds what it does with them.
 */

/** The part of a connection this needs. */
export interface ApprovalConnection {
  config: { name: string };
  tools: { name: string; description?: string }[];
  warnings: string[];
  pendingTools?: Map<string, McpPendingApproval>;
  /** Tools that must ask again: a changed definition, or a changed launch definition */
  pinChanges?: Map<
    string,
    { kind: "changed" | "added" | "launch"; summary: string }
  >;
}

/**
 * Compare a server's tools and launch definition with what was approved, and
 * set which tools ask again (`pinChanges`) and which wait (`pendingTools`).
 */
export async function refreshConnectionPins(
  connection: ApprovalConnection,
  options: never,
): Promise<void> {
  try {
    const store = getToolPinStore();
    await adoptLegacyPin(options, store);
    // Upgrade: a server someone used before this release stays approved
    await adoptConnectionFromHistory(connection, options);
    const { flagged, pending } = await evaluatePins(
      pinKey(options),
      connection.tools as never,
      store,
      launchSpec(options),
    );
    connection.pinChanges = flagged;
    connection.pendingTools = pending;
  } catch (error) {
    logger.warn("Could not check the saved MCP pins", {
      name: connection.config?.name,
      error: getErrorString(error),
    });
  }
}

/**
 * A call ran: pin it. An unattended run's first call to a server never
 * approved pins only the called tool, which the person listed by name
 * (`background.mcpTools`); otherwise the first call pins the whole server as
 * before, and a changed launch definition is accepted and announced.
 */
export async function recordConnectionPins(
  connection: ApprovalConnection,
  options: never,
  toolName: string,
  unattended: boolean,
): Promise<void> {
  try {
    await adoptLegacyPin(options, getToolPinStore());
    if (unattended && connection.pendingTools?.get(toolName) === "new") {
      await approveConnectionTools(connection, options, [toolName]);
      await refreshConnectionPins(connection, options);
      return;
    }
    const events: ApprovalEvents = {};
    const changed = await recordApproval(
      pinKey(options),
      connection.tools as never,
      getToolPinStore(),
      toolName,
      new Date(),
      launchSpec(options),
      events,
    );
    if (!changed) return;
    announcePins(connection.config.name, events, connection.warnings, (m) =>
      logger.warn(m),
    );
    await refreshConnectionPins(connection, options);
  } catch (error) {
    logger.warn("Could not save the MCP pin", {
      error: getErrorString(error),
    });
  }
}

/** One tool waiting for approval, for `/mcp pending`. */
export interface PendingMcpTool {
  server: string;
  tool: string;
  kind: McpPendingApproval;
  description?: string;
}

/**
 * Upgrade: a server with no record, one of whose tools was called in a
 * session saved before this release first ran, is pinned as it is now.
 */
export async function adoptConnectionFromHistory(
  connection: ApprovalConnection,
  options: never,
): Promise<void> {
  const adopted = await adoptFromHistory(
    pinKey(options),
    connection.config.name,
    connection.tools as never,
    getToolPinStore(),
    await calledToolNames(getContinueGlobalPath()),
    launchSpec(options),
  );
  if (adopted) {
    connection.warnings.push(
      `MCP server ${connection.config.name} was used before this version, so its current tools stay approved.`,
    );
  }
}

/** Pin these tools of one connection; returns the names pinned. */
export async function approveConnectionTools(
  connection: ApprovalConnection,
  options: never,
  names: readonly string[] | "all",
): Promise<string[]> {
  return approveTools(
    pinKey(options),
    connection.tools as never,
    getToolPinStore(),
    names,
    new Date(),
    launchSpec(options),
  );
}

/** Every tool waiting for approval, by server then tool. */
export function listPendingTools(
  connections: Iterable<[string, ApprovalConnection]>,
): PendingMcpTool[] {
  const out: PendingMcpTool[] = [];
  for (const [server, c] of connections) {
    for (const [tool, kind] of c.pendingTools ?? []) {
      const description = c.tools.find((t) => t.name === tool)?.description;
      out.push({ server, tool, kind, ...(description ? { description } : {}) });
    }
  }
  return out.sort((a, b) =>
    a.server === b.server
      ? a.tool.localeCompare(b.tool)
      : a.server.localeCompare(b.server),
  );
}

/** The `/mcp` line for a server with tools waiting, or undefined. */
export function pendingNotice(
  server: string,
  connection: ApprovalConnection | undefined,
): string | undefined {
  return connection?.pendingTools
    ? pendingApprovalText(server, connection.pendingTools)
    : undefined;
}
