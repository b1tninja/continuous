/**
 * What the person is told when MCP pins change on their behalf: the tools
 * the first approval pinned, and a launch definition that was re-pinned (at
 * IDGAF nothing asked first, so this is the only trace). Also written to the
 * audit trail. Messages carry names only: never arguments, URLs or env values.
 */
import { getAuditTrail } from "../../tools/permissions/audit/global";
import type { ApprovalEvents } from "./mcpToolPins";

export function pinNotices(server: string, events: ApprovalEvents): string[] {
  const out: string[] = [];
  if (events.firstPin?.length) {
    out.push(
      `Approving the first call to MCP server ${server} pinned all of its tools: ${events.firstPin.join(", ")}. A later change to any of them asks again.`,
    );
  }
  if (events.launchAccepted) {
    out.push(
      `MCP server ${server} launched with a changed definition (${events.launchAccepted.join(", ")}) and the new definition is now pinned. If you did not approve this, check the server's configuration.`,
    );
  }
  return out;
}

/**
 * Print the notices (through `print`, so a terminal UI can route them) and
 * record a re-pinned launch definition. Never throws.
 */
export function announcePins(
  server: string,
  events: ApprovalEvents,
  sink: string[],
  print: (message: string) => void = (m) => console.warn(m),
): void {
  const notices = pinNotices(server, events);
  for (const n of notices) {
    sink.push(n);
    print(n);
  }
  if (!events.launchAccepted) return;
  try {
    getAuditTrail().decision({
      callId: `mcp-launch-${server}-${Date.now()}`,
      tool: `mcp:${server}`,
      args: JSON.stringify({
        server,
        changed: events.launchAccepted,
      }),
      policy: "allow",
      by: "system",
      source: "mcp-launch-changed",
      reason: `launch definition changed (${events.launchAccepted.join(", ")}) and was pinned again`,
    });
  } catch {
    // the audit never blocks a call
  }
}

/**
 * A trusted server's new or changed tools were pinned on sight (TR24): say
 * so and write it to the audit trail, since nobody approved them one by one.
 * Never throws.
 */
export function announceTrustedApproval(
  server: string,
  tools: readonly string[],
  sink: string[],
  print: (message: string) => void = (m) => console.warn(m),
): void {
  if (!tools.length) return;
  const notice = `MCP server ${server} is trusted in your permissions.yaml, so its new or changed tools were approved as listed: ${tools.join(", ")}.`;
  sink.push(notice);
  print(notice);
  try {
    getAuditTrail().decision({
      callId: `mcp-trusted-${server}-${Date.now()}`,
      tool: `mcp:${server}`,
      args: JSON.stringify({ server, tools }),
      policy: "allow",
      by: "system",
      source: "mcp-trusted-server",
      reason: `trusted server: new or changed tools pinned on sight (${tools.join(", ")})`,
    });
  } catch {
    // the audit never blocks a call
  }
}
