import {
  POLICY_AREAS,
  POLICY_LEVELS,
  type PolicyLevel,
} from "core/tools/permissions/policy";
import { typedCommandRefusal } from "core/util/typedCommand";

import type { AuditTrail } from "core/tools/permissions/audit/trail";

/** The panel's policy/save body: known areas and known levels only. */
export function policySavePayloadOk(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const levels = (data as { levels?: unknown }).levels;
  if (levels === undefined) return true;
  if (!levels || typeof levels !== "object" || Array.isArray(levels)) {
    return false;
  }
  for (const [area, level] of Object.entries(levels)) {
    if (!(POLICY_AREAS as readonly string[]).includes(area)) return false;
    if (!(POLICY_LEVELS as readonly string[]).includes(level as PolicyLevel)) {
      return false;
    }
  }
  return true;
}

const ALLOWED_OPEN_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Links the panel may ask the host to open. */
export function openUrlFromWebviewOk(data: unknown): data is string {
  if (typeof data !== "string" || !data.trim()) return false;
  try {
    const url = new URL(data.trim());
    if (url.protocol === "mailto:") return url.pathname.includes("@");
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export type TypedCommand =
  { ok: true; command: string } | { ok: false; reason: string };

/**
 * The panel's runCommand: the text is typed into the terminal and Enter is
 * left to the person, so it must be one line of plain text
 * (typedCommandRefusal). What was typed, and what was refused, is written to
 * the audit trail.
 */
export function runCommandFromWebview(
  data: unknown,
  trail: Pick<AuditTrail, "decision" | "outcome">,
  now: () => number = Date.now,
): TypedCommand {
  const command =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as { command?: unknown }).command
      : undefined;
  const why = typedCommandRefusal(command);
  const reason = why
    ? `The command was not typed into the terminal: ${why}.`
    : "Typed into the terminal and not run: it runs if the person presses Enter.";
  const callId = `webview-runCommand-${now()}`;
  trail.decision({
    callId,
    tool: "runCommand",
    args: auditedArgs(typeof command === "string" ? { command } : data),
    policy: why ? "deny" : "ask",
    by: "system",
    source: "webview-message",
    reason,
  });
  trail.outcome({ callId, ran: false, ...(why ? { error: reason } : {}) });
  return why ? { ok: false, reason } : { ok: true, command: command as string };
}

export function writeFileFromWebviewOk(
  data: unknown,
): data is { path: string; contents: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const body = data as { path?: unknown; contents?: unknown };
  return typeof body.path === "string" && typeof body.contents === "string";
}

/**
 * IDE messages the panel may not send: they are core's alone. `subprocess`
 * starts a process on the host with no policy decision. JetBrains keeps the
 * same list (WebviewIdeGate.DENIED_FROM_PANEL).
 */
export const DENIED_FROM_WEBVIEW: readonly string[] = ["subprocess"];

const MAX_AUDITED_ARGS = 4_000;

/** What the panel asked for, as the audit row keeps it. */
function auditedArgs(data: unknown): string {
  try {
    return (JSON.stringify(data) ?? "").slice(0, MAX_AUDITED_ARGS);
  } catch {
    // it could not be written; the row still is
    return "";
  }
}

/**
 * The refusal for a message the panel may not send, or undefined for any
 * other. A refusal is written to the audit trail with what was asked for.
 */
export function refuseFromWebview(
  messageType: unknown,
  data: unknown,
  trail: Pick<AuditTrail, "decision" | "outcome">,
  now: () => number = Date.now,
): string | undefined {
  if (
    typeof messageType !== "string" ||
    !DENIED_FROM_WEBVIEW.includes(messageType)
  ) {
    return undefined;
  }
  const reason = `The panel may not send "${messageType}": nothing was run.`;
  const args = auditedArgs(data);
  const callId = `webview-${messageType}-${now()}`;
  trail.decision({
    callId,
    tool: messageType,
    args,
    policy: "deny",
    by: "system",
    source: "webview-message",
    reason,
  });
  trail.outcome({ callId, ran: false, error: reason });
  return reason;
}

function fileUriPath(uri: string): string | undefined {
  const match = /^file:([^?#]*)/i.exec(uri.trim());
  if (!match) return undefined;
  let rest = match[1].replace(/\\/g, "/");
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slash = rest.indexOf("/");
    if (slash === -1) return undefined;
    const host = rest.slice(0, slash);
    if (host && host.toLowerCase() !== "localhost") return undefined;
    rest = rest.slice(slash);
  }
  if (!rest.startsWith("/")) rest = `/${rest}`;
  return rest;
}

function pathSegments(path: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "" || raw === ".") continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    if (part.includes("/") || part.includes("\\") || part.includes("\0")) {
      return undefined;
    }
    out.push(part);
  }
  return out;
}

/** A filesystem path or file URI as a file URI, or undefined when it is not a local file. */
export function pathOrUriToFileUri(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed.toLowerCase().startsWith("file:") ? trimmed : undefined;
  }
  if (trimmed.startsWith("//")) return undefined;
  if (trimmed.startsWith("/")) return `file://${trimmed}`;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `file:///${trimmed.replace(/\\/g, "/")}`;
  }
  return undefined;
}

function sameSegment(a: string, b: string): boolean {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * True when `target` (a file URI or absolute path) is the workspace root or
 * a path inside it. `..` is resolved before the check.
 */
export function isInsideWorkspace(
  target: string,
  workspaceDirs: readonly string[],
): boolean {
  const targetUri = pathOrUriToFileUri(target);
  if (!targetUri) return false;
  const targetPath = fileUriPath(targetUri);
  if (targetPath === undefined) return false;
  const targetSegments = pathSegments(targetPath);
  if (!targetSegments) return false;
  for (const dir of workspaceDirs) {
    const dirUri = pathOrUriToFileUri(dir);
    if (!dirUri) continue;
    const dirPath = fileUriPath(dirUri);
    if (dirPath === undefined) continue;
    const dirSegments = pathSegments(dirPath);
    if (!dirSegments || targetSegments.length < dirSegments.length) continue;
    const inside = dirSegments.every((segment, index) =>
      sameSegment(segment, targetSegments[index] ?? ""),
    );
    if (inside) return true;
  }
  return false;
}
