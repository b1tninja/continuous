/**
 * Saved sessions as ACP v1 sees them: `session/list` pages and the
 * `session/update` notifications `session/load` replays the conversation
 * with. Pure: the backend reads the files, this turns them into protocol.
 *
 * - session/list: https://agentclientprotocol.com/protocol/v1/session-list
 * - session/load: https://agentclientprotocol.com/protocol/v1/session-setup#loading-sessions
 */

import path from "path";

import type {
  ChatHistoryItem,
  MessageContent,
  ToolStatus,
} from "core/index.js";
import { maskArgsForDisplay } from "core/tools/permissions/displayMask.js";
import { workspaceDisplayPath } from "core/util/sessionWorkspace.js";

/** A saved session, as the backend found it on disk. */
export interface StoredSession {
  sessionId: string;
  title: string;
  /** As saved: a path (the CLI) or a URI (the IDE) */
  workspaceDirectory: string;
  /** ISO 8601 time of the last write */
  updatedAt: string;
}

/** `SessionInfo` of the ACP schema. */
export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

/** Sessions per `session/list` page ("reasonable page sizes", the spec says). */
export const SESSION_LIST_PAGE_SIZE = 50;

/**
 * The folder a session was saved in as the absolute path `SessionInfo.cwd`
 * must be: a `file://` URI (the IDE) becomes its path. A session without a
 * folder, or saved in a remote workspace (`vscode-remote://...`), has none
 * and is not listed.
 */
export function sessionCwd(workspaceDirectory: string): string | undefined {
  if (!workspaceDirectory || workspaceDirectory.trim() === "") return undefined;
  const display = workspaceDisplayPath(workspaceDirectory);
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(display)) return undefined;
  if (!path.isAbsolute(display)) return undefined;
  return path.normalize(display);
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Newest first; the id breaks a tie, so the order (and a cursor) is stable. */
function compare(a: StoredSession, b: StoredSession): number {
  const dt = timeOf(b.updatedAt) - timeOf(a.updatedAt);
  if (dt !== 0) return dt;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

interface CursorKey {
  t: number;
  id: string;
}

function encodeCursor(session: StoredSession): string {
  const key: CursorKey = {
    t: timeOf(session.updatedAt),
    id: session.sessionId,
  };
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/** The position a cursor names, or `undefined` when it is not one of ours. */
export function decodeCursor(cursor: string): CursorKey | undefined {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      key &&
      typeof key === "object" &&
      Number.isFinite(key.t) &&
      typeof key.id === "string"
    ) {
      return { t: key.t, id: key.id };
    }
  } catch {
    // not ours
  }
  return undefined;
}

/** Whether `session` comes after the one the cursor names, in list order. */
function isAfter(session: StoredSession, key: CursorKey): boolean {
  const t = timeOf(session.updatedAt);
  if (t !== key.t) return t < key.t;
  return session.sessionId > key.id;
}

export interface SessionListPage {
  sessions: AcpSessionInfo[];
  nextCursor?: string;
}

/**
 * One page of `session/list`: newest first, only sessions that belong to
 * `cwd` when it is given (`inWorkspace`), each with an absolute `cwd`. The
 * cursor names the last session of the page rather than an offset, so a
 * session saved between two requests does not shift the next page.
 * `undefined` for a cursor this agent did not make (the caller answers
 * -32602, as the spec asks).
 */
export function sessionListPage(
  stored: readonly StoredSession[],
  options: {
    cwd?: string;
    cursor?: string;
    pageSize?: number;
    inWorkspace: (workspaceDirectory: string, cwd: string) => boolean;
  },
): SessionListPage | undefined {
  const pageSize = options.pageSize ?? SESSION_LIST_PAGE_SIZE;
  let after: CursorKey | undefined;
  if (options.cursor !== undefined) {
    after = decodeCursor(options.cursor);
    if (!after) return undefined;
  }
  const matching = stored
    .filter((s) => sessionCwd(s.workspaceDirectory) !== undefined)
    .filter(
      (s) =>
        options.cwd === undefined ||
        options.inWorkspace(s.workspaceDirectory, options.cwd),
    )
    .sort(compare)
    .filter((s) => !after || isAfter(s, after));
  const page = matching.slice(0, pageSize);
  const sessions = page.map((s) => ({
    sessionId: s.sessionId,
    cwd: sessionCwd(s.workspaceDirectory)!,
    ...(s.title ? { title: s.title } : {}),
    ...(timeOf(s.updatedAt) ? { updatedAt: s.updatedAt } : {}),
  }));
  return matching.length > pageSize
    ? { sessions, nextCursor: encodeCursor(page[page.length - 1]) }
    : { sessions };
}

function textOf(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Images are not replayed: this agent says it takes no image content
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function acpToolStatus(status: ToolStatus | undefined): "completed" | "failed" {
  // A call a stored session left unfinished will not run now
  return status === "done" ? "completed" : "failed";
}

/** What `replayHistory` needs from the agent: the live call's look. */
export interface ReplayTools {
  nextCallId(): string;
  title(name: string, args: unknown): string;
  kind(name: string): string;
  location(args: unknown): string | undefined;
  resultText(text: unknown): string;
}

/**
 * The `session/update` payloads that replay a saved conversation, in its
 * order: each user message as `user_message_chunk`, each reply as
 * `agent_message_chunk`, and each tool call of a reply as one `tool_call`
 * carrying its final status and output. A message is one chunk with its own
 * `messageId`. System prompts, tool-result messages (the call already carries
 * its output) and reasoning are not replayed; a live turn sends no reasoning
 * either. Arguments and output are masked as a live call's are.
 */
export function replayHistory(
  history: readonly ChatHistoryItem[],
  tools: ReplayTools,
): Record<string, unknown>[] {
  const updates: Record<string, unknown>[] = [];
  history.forEach((item, index) => {
    const message = item.message;
    if (message.role === "user" || message.role === "assistant") {
      const text = textOf(message.content);
      if (text) {
        updates.push({
          sessionUpdate:
            message.role === "user"
              ? "user_message_chunk"
              : "agent_message_chunk",
          messageId: `msg_${index}`,
          content: { type: "text", text },
        });
      }
    }
    if (message.role !== "assistant") return;
    for (const state of item.toolCallStates ?? []) {
      const name = state.toolCall?.function?.name ?? "tool";
      const args = state.parsedArgs ?? {};
      const output = (state.output ?? [])
        .map((o) => (typeof o.content === "string" ? o.content : ""))
        .filter(Boolean)
        .join("\n");
      const loc = tools.location(args);
      updates.push({
        sessionUpdate: "tool_call",
        toolCallId: tools.nextCallId(),
        title: tools.title(name, args),
        kind: tools.kind(name),
        status: acpToolStatus(state.status),
        rawInput: maskArgsForDisplay(args),
        ...(loc ? { locations: [{ path: loc }] } : {}),
        ...(output
          ? {
              content: [
                {
                  type: "content",
                  content: { type: "text", text: tools.resultText(output) },
                },
              ],
            }
          : {}),
      });
    }
  });
  return updates;
}
