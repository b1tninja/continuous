/**
 * New MCP tools hidden until approved (plans/ROADMAP.md, TR4 and TR24;
 * plans/decisions-2026-11-15.md, decision 4): what is approved, what is
 * waiting, and how the tools people already used stay approved on upgrade.
 *
 * Approved means the tool's current definition is in the pin file
 * (mcpToolPins.ts). Before this release a server was pinned on its first
 * approved call, as a whole, so every tool of a server someone used since
 * pinning shipped is in the file already and nothing changes for it. A
 * server that was used before pinning shipped has no record; for it the
 * session history is read once, and a server one of whose tools was called
 * in a session saved before this release first ran is pinned as it is now
 * (`adoptFromHistory`). A server nobody called stays waiting, which is the
 * point.
 *
 * Not for the webview: it reads files.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { readPolicyFile } from "../../tools/permissions/settingsFile";
import type { McpPendingApproval } from "../../tools/roleTools";
import { getToolNameFromMCPServer } from "../../tools/mcpToolName";
import type { McpToolDefinition, ToolPinReport } from "./toolPinning";

/** The tools of one server that wait for approval, from a pin report. */
export function pendingFromReport(
  report: ToolPinReport,
  tools: McpToolDefinition[],
): Map<string, McpPendingApproval> {
  const out = new Map<string, McpPendingApproval>();
  if (report.status === "new") {
    for (const t of tools) out.set(t.name, "new");
  } else if (report.status === "changed") {
    for (const n of report.added) out.set(n, "added");
    for (const c of report.changed) out.set(c.name, "changed");
  }
  return out;
}

/** The file that records when this release first ran, beside the pin file. */
export function holdMarkerPath(globalDir: string): string {
  return path.join(globalDir, "mcp-tool-hold.json");
}

/**
 * When hiding unapproved tools started on this machine: read from the marker
 * file, or now, written to it on the first call. Sessions saved before it are
 * the "history" an upgrade counts.
 */
export function holdSince(globalDir: string, now: Date = new Date()): Date {
  const file = holdMarkerPath(globalDir);
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    const t = Date.parse(v?.since);
    if (Number.isFinite(t)) return new Date(t);
  } catch {
    // missing or unreadable: start now
  }
  try {
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, since: now.toISOString() }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    // read-only home: count no history rather than all of it
  }
  return now;
}

/** Limits on the one history read, so a large sessions folder costs little. */
export const HISTORY_SCAN_LIMITS = {
  files: 2000,
  bytesPerFile: 32 * 1024 * 1024,
};

/** `"name":"x","arguments"`, the shape a stored tool call's function has. */
const CALLED_NAME = /"name"\s*:\s*"([^"\\]{1,200})"\s*,\s*"arguments"/g;
/** A tool's URI as the IDE stores it with the call (`mcp://<server>/<tool>`). */
const TOOL_URI = /"mcp:\/\/([^/"\\]{1,200})\/([^"\\]{1,200})"/g;
/** A server and tool recorded beside a call (`"mcpServer":"s","mcpToolName":"t"`). */
const SERVER_TOOL =
  /"mcpServer"\s*:\s*"([^"\\]{1,200})"\s*,\s*"mcpToolName"\s*:\s*"([^"\\]{1,200})"/g;

/**
 * What the history says was called: the model-facing names, and the server
 * and tool pairs where the session recorded which server a call went to.
 */
export interface HistoryCalls {
  names: Set<string>;
  /** `server\0tool`, the server by its name or its id */
  pairs: Set<string>;
}

const pairKey = (server: string, tool: string) => `${server}\0${tool}`;

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The tool calls in the sessions saved before `before`, newest files first,
 * within the limits. Never throws: an unreadable file counts nothing.
 */
export function toolCallsBefore(
  sessionsDir: string,
  before: Date,
  limits = HISTORY_SCAN_LIMITS,
): HistoryCalls {
  const calls: HistoryCalls = { names: new Set(), pairs: new Set() };
  let entries: { file: string; mtime: number; size: number }[] = [];
  try {
    entries = fs
      .readdirSync(sessionsDir)
      .filter((n) => n.endsWith(".json") || n.endsWith(".jsonl"))
      .map((n) => {
        const file = path.join(sessionsDir, n);
        try {
          const st = fs.statSync(file);
          return { file, mtime: st.mtimeMs, size: st.size };
        } catch {
          return { file, mtime: Number.POSITIVE_INFINITY, size: 0 };
        }
      })
      .filter((e) => e.mtime < before.getTime());
  } catch {
    return calls;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const e of entries.slice(0, limits.files)) {
    if (e.size > limits.bytesPerFile) continue;
    let text: string;
    try {
      text = fs.readFileSync(e.file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(CALLED_NAME)) calls.names.add(m[1]);
    for (const m of text.matchAll(TOOL_URI)) {
      calls.pairs.add(pairKey(decode(m[1]), decode(m[2])));
    }
    for (const m of text.matchAll(SERVER_TOOL)) {
      calls.pairs.add(pairKey(m[1], m[2]));
    }
  }
  return calls;
}

/** The names a history read alone can tie to one server: the IDE's composed name, when it carries the server. */
export function serverNamesOfTool(server: string, tool: string): string[] {
  const composed = getToolNameFromMCPServer(server, tool);
  // A tool already named after its server composes to its own name, which
  // is also what any other server's tool of that name is called in the CLI
  return composed === tool ? [] : [composed];
}

/**
 * Whether a tool of this server was called in the history, matched on the
 * server and the tool together: a recorded server and tool pair (by the
 * server's name or id), or the IDE's composed name. The CLI's bare name
 * alone names no server, so it never counts.
 */
export function serverUsedInHistory(
  server: { name: string; id?: string },
  tools: McpToolDefinition[],
  called: HistoryCalls,
): boolean {
  const ids = [server.name, ...(server.id ? [server.id] : [])];
  return tools.some(
    (t) =>
      ids.some((id) => called.pairs.has(pairKey(id, t.name))) ||
      serverNamesOfTool(server.name, t.name).some((n) => called.names.has(n)),
  );
}

let historyCache: { key: string; calls: Promise<HistoryCalls> } | undefined =
  undefined;

/** The history read, once per process and folder. */
export function calledTools(
  globalDir: string,
  sessionsDir: string = path.join(globalDir, "sessions"),
): Promise<HistoryCalls> {
  const key = `${globalDir}\0${sessionsDir}`;
  if (historyCache?.key !== key) {
    const since = holdSince(globalDir);
    historyCache = {
      key,
      calls: Promise.resolve().then(() => toolCallsBefore(sessionsDir, since)),
    };
  }
  return historyCache.calls;
}

/**
 * TR24: a server the person marked `trusted` in their own permissions.yaml
 * (`mcpServers.<name>: trusted`) approves the new and changed tools it lists:
 * they are pinned on sight. A server the open folder brought is never trusted
 * this way, whatever its name. Every other server's tools wait.
 */
export function serverAutoApproves(
  server: { name: string; configSource?: string },
  trustedServers: readonly string[] | undefined,
): boolean {
  return (
    server.configSource !== "workspace" &&
    !!trustedServers?.includes(server.name)
  );
}

/** The servers named `trusted` in the person's own permissions.yaml. Never throws. */
export function trustedServersFromPolicyFile(globalDir: string): string[] {
  try {
    return Object.keys(
      readPolicyFile(path.join(globalDir, "permissions.yaml")).settings
        .mcpServers ?? {},
    );
  } catch {
    return [];
  }
}

/** For tests. */
export function resetCalledTools(): void {
  historyCache = undefined;
}

/** The text a pending tool's server card and `/mcp` show. */
export function pendingApprovalText(
  server: string,
  pending: ReadonlyMap<string, McpPendingApproval>,
): string | undefined {
  if (!pending.size) return undefined;
  const names = [...pending.keys()].sort();
  const changed = names.filter((n) => pending.get(n) === "changed");
  const fresh = names.filter((n) => pending.get(n) !== "changed");
  const parts: string[] = [];
  if (fresh.length) parts.push(`new: ${fresh.join(", ")}`);
  if (changed.length) parts.push(`changed: ${changed.join(", ")}`);
  return `MCP server ${server} has tools that are not offered to the model until you approve them (${parts.join("; ")}).`;
}
