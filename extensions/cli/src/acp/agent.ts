import path from "path";

import type { ChatHistoryItem } from "core/index.js";
import { maskArgsForDisplay } from "core/tools/permissions/displayMask.js";

import type { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import { maskForSupervisor } from "../util/maskForSupervisor.js";

import { JsonRpcPeer, RPC_CODES, RpcError } from "./rpc.js";
import {
  replayHistory,
  sessionListPage,
  type StoredSession,
} from "./sessions.js";

/**
 * The ACP protocol version this agent speaks. A client that asks for a later
 * one (the v2 draft) is answered with this, and decides whether to go on.
 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP's "Resource not found" error code, for an unknown session id. */
export const ACP_RESOURCE_NOT_FOUND = -32002;

/**
 * What the protocol layer needs from the CLI. The real one (`backend.ts`)
 * runs the CLI's own turn loop; tests give a scripted one, so the protocol
 * is checked with no model and no services.
 */
export interface AcpBackend {
  /** Start the one conversation of this process, rooted at `cwd`. */
  newSession(cwd: string): Promise<string>;
  /** Every saved session (`session/list`), in any order. */
  listSessions(): Promise<StoredSession[]>;
  /** Whether a session saved in `workspaceDirectory` belongs to `cwd`. */
  inWorkspace(workspaceDirectory: string, cwd: string): boolean;
  /**
   * Make the saved session `sessionId` the one conversation of this process,
   * rooted at `cwd`, and answer its history; `undefined` when no session of
   * that id is saved.
   */
  openSession(
    sessionId: string,
    cwd: string,
  ): Promise<ChatHistoryItem[] | undefined>;
  /**
   * Run one turn to its end. The callbacks are the CLI's `StreamCallbacks`,
   * the same ones `cn serve` fills; `onToolPermissionRequest` is set, which
   * is what lets the policy engine ask instead of refusing.
   */
  runTurn(
    sessionId: string,
    text: string,
    callbacks: StreamCallbacks,
    signal: AbortSignal,
  ): Promise<void>;
  /** Answer a request the policy engine raised through the callback. */
  resolvePermission(requestId: string, approved: boolean): void;
}

export interface AcpAgentInfo {
  name: string;
  title: string;
  version: string;
}

type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

interface OpenCall {
  /** The id the editor knows the call by */
  id: string;
  name: string;
  /** The model's id for the call: what pairs a result with its call */
  key?: string;
}

/**
 * The open call a result, an error or a permission request belongs to. With
 * the model's call id, only the call started under that id: calls of one turn
 * run at the same time, so two calls of one tool finish in any order, and a
 * match by name would hand the first to finish the other's `toolCallId`.
 * The name is the fallback only for a caller that passes no id.
 */
export function findOpenCall(
  open: readonly OpenCall[],
  name: string | undefined,
  key: string | undefined,
): number {
  if (key !== undefined) return open.findIndex((c) => c.key === key);
  return open.findIndex((c) => c.name === name);
}

const MAX_RESULT_CHARS = 50_000;

export function toolKindFor(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/^(read|view|cat)/.test(n)) return "read";
  if (/(delete|remove)/.test(n)) return "delete";
  if (/^(edit|write|multiedit|multi_edit|apply|create|patch)/.test(n)) {
    return "edit";
  }
  if (/(bash|shell|terminal|exec|run_command)/.test(n)) return "execute";
  if (/(search|grep|glob|find|^ls$|^list)/.test(n)) return "search";
  if (/(fetch|web)/.test(n)) return "fetch";
  return "other";
}

function argPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ["filepath", "file_path", "path", "filename"]) {
    const v = a[key];
    if (typeof v === "string" && path.isAbsolute(v)) return v;
  }
  return undefined;
}

/**
 * A tool's result or error as the editor may show it: the same two masking
 * passes `GET /state` of `serve` uses, then the length cap.
 */
export function resultTextForClient(text: unknown): string {
  const s = typeof text === "string" ? text : String(text ?? "");
  return maskForSupervisor(s).slice(0, MAX_RESULT_CHARS);
}

function titleFor(name: string, rawArgs: unknown): string {
  // The editor shows this title in its approval prompt
  const args = maskArgsForDisplay(rawArgs);
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const detail = a.command ?? a.filepath ?? a.file_path ?? a.path ?? a.query;
    if (typeof detail === "string" && detail) {
      const one = detail.split("\n")[0].slice(0, 120);
      return `${name}: ${one}`;
    }
  }
  return name;
}

/**
 * The Agent side of ACP over one JSON-RPC peer: initialize, session/new,
 * session/list, session/load, session/resume, session/prompt,
 * session/cancel, and session/update notifications for the model's text and
 * its tool calls. A tool call the policy engine would ask
 * about becomes `session/request_permission`.
 *
 * Fail closed: the answer to a permission request is an allow only when the
 * client selected exactly the allow option we offered. A cancelled outcome, an
 * error, a malformed reply, an unknown option, a lost connection and a
 * cancelled turn are all a refusal. Content this agent did not say it can
 * take (images, audio, embedded resources) is refused as invalid params
 * rather than dropped.
 */
export class AcpAgent {
  private initialized = false;
  private sessionId: string | undefined;
  private turn: { abort: AbortController } | undefined;
  private readonly pendingPermissions = new Set<string>();
  private toolSeq = 0;

  constructor(
    private readonly peer: JsonRpcPeer,
    private readonly backend: AcpBackend,
    private readonly info: AcpAgentInfo,
  ) {
    peer.onRequest("initialize", (p) => this.initialize(p));
    peer.onRequest("authenticate", () => {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "No authentication method is offered; the CLI uses its own configuration.",
      );
    });
    peer.onRequest("session/new", (p) => this.newSession(p));
    peer.onRequest("session/list", (p) => this.listSessions(p));
    peer.onRequest("session/load", (p) => this.openSession(p, true));
    peer.onRequest("session/resume", (p) => this.openSession(p, false));
    peer.onRequest("session/prompt", (p) => this.prompt(p));
    peer.onNotification("session/cancel", (p) => this.cancel(p));
  }

  /** The connection ended: stop the running turn and refuse what waits. */
  shutdown(): void {
    this.turn?.abort.abort();
    this.refuseAllPending();
  }

  private initialize(params: any) {
    if (!params || !Number.isInteger(params.protocolVersion)) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "protocolVersion must be an integer",
      );
    }
    this.initialized = true;
    return {
      // The client's version if we speak it, else our latest; the client
      // closes the connection when it cannot use ours.
      protocolVersion:
        params.protocolVersion >= 1 &&
        params.protocolVersion <= ACP_PROTOCOL_VERSION
          ? params.protocolVersion
          : ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        // session/load replays the saved conversation; session/list and
        // session/resume are the v1 session capabilities beside it
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { list: {}, resume: {} },
      },
      agentInfo: this.info,
      authMethods: [],
    };
  }

  private requireInitialized() {
    if (!this.initialized) {
      throw new RpcError(
        RPC_CODES.invalidRequest,
        "initialize must be the first request",
      );
    }
  }

  /** The checks session/new, session/load and session/resume share. */
  private requireSessionCwd(params: any): string {
    this.requireInitialized();
    if (!params || typeof params.cwd !== "string") {
      throw new RpcError(RPC_CODES.invalidParams, "cwd is required");
    }
    if (!path.isAbsolute(params.cwd)) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "cwd must be an absolute path",
      );
    }
    if (this.sessionId) {
      throw new RpcError(
        RPC_CODES.invalidRequest,
        "This process holds one session; start another process for another conversation.",
      );
    }
    return params.cwd;
  }

  private async newSession(params: any) {
    const cwd = this.requireSessionCwd(params);
    // params.mcpServers is not used: the CLI loads the MCP servers of its own
    // configuration, and mcpCapabilities says no http or sse from the client.
    this.sessionId = await this.backend.newSession(cwd);
    return { sessionId: this.sessionId };
  }

  /**
   * session/list: the saved sessions of `cwd` (the folder, a folder inside or
   * around it, or its repository: what `continuous ls` and `--resume` call
   * this workspace), newest first, a page at a time.
   */
  private async listSessions(params: any) {
    this.requireInitialized();
    const cwd = params?.cwd ?? undefined;
    const cursor = params?.cursor ?? undefined;
    if (
      cwd !== undefined &&
      (typeof cwd !== "string" || !path.isAbsolute(cwd))
    ) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "cwd must be an absolute path",
      );
    }
    if (cursor !== undefined && typeof cursor !== "string") {
      throw new RpcError(RPC_CODES.invalidParams, "Invalid cursor");
    }
    const page = sessionListPage(await this.backend.listSessions(), {
      cwd,
      cursor,
      inWorkspace: (dir, folder) => this.backend.inWorkspace(dir, folder),
    });
    if (!page) throw new RpcError(RPC_CODES.invalidParams, "Invalid cursor");
    return page;
  }

  /**
   * session/load (`replay`) and session/resume: continue a saved session in
   * this process. Load sends the whole conversation as session/update
   * notifications before it answers, as the spec requires; resume sends none.
   */
  private async openSession(params: any, replay: boolean) {
    const cwd = this.requireSessionCwd(params);
    if (typeof params.sessionId !== "string" || params.sessionId === "") {
      throw new RpcError(RPC_CODES.invalidParams, "sessionId is required");
    }
    const sessionId: string = params.sessionId;
    const history = await this.backend.openSession(sessionId, cwd);
    if (!history) {
      throw new RpcError(ACP_RESOURCE_NOT_FOUND, "Unknown sessionId", {
        sessionId,
      });
    }
    this.sessionId = sessionId;
    if (replay) {
      const updates = replayHistory(history, {
        nextCallId: () => `call_${++this.toolSeq}`,
        title: titleFor,
        kind: toolKindFor,
        location: argPath,
        resultText: resultTextForClient,
      });
      for (const update of updates) this.update(sessionId, update);
    }
    return {};
  }

  private promptText(blocks: unknown): string {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new RpcError(
        RPC_CODES.invalidParams,
        "prompt must be a non-empty array",
      );
    }
    const parts: string[] = [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (
        block?.type === "resource_link" &&
        typeof block.uri === "string"
      ) {
        parts.push(`@${block.uri}`);
      } else {
        throw new RpcError(
          RPC_CODES.invalidParams,
          `Unsupported prompt content: ${String(block?.type)}. Only text and resource_link are accepted.`,
        );
      }
    }
    return parts.join("\n\n");
  }

  private async prompt(params: any) {
    this.requireInitialized();
    if (!params || !this.sessionId || params.sessionId !== this.sessionId) {
      throw new RpcError(RPC_CODES.invalidParams, "Unknown sessionId");
    }
    if (this.turn) {
      throw new RpcError(
        RPC_CODES.invalidRequest,
        "A prompt turn is already running in this session",
      );
    }
    const text = this.promptText(params.prompt);
    const sessionId = this.sessionId;
    const abort = new AbortController();
    this.turn = { abort };
    try {
      await this.backend.runTurn(
        sessionId,
        text,
        this.callbacks(sessionId, abort.signal),
        abort.signal,
      );
      return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
    } catch (e) {
      // The protocol asks for cancelled, not an error, when a cancel
      // interrupted the turn.
      if (abort.signal.aborted) return { stopReason: "cancelled" };
      throw e;
    } finally {
      this.turn = undefined;
      this.refuseAllPending();
    }
  }

  private cancel(params: any) {
    if (params?.sessionId !== this.sessionId) return;
    this.turn?.abort.abort();
    this.refuseAllPending();
  }

  private refuseAllPending() {
    for (const id of this.pendingPermissions) {
      this.backend.resolvePermission(id, false);
    }
    this.pendingPermissions.clear();
  }

  private update(sessionId: string, update: Record<string, unknown>) {
    this.peer.notify("session/update", { sessionId, update });
  }

  private callbacks(sessionId: string, signal: AbortSignal): StreamCallbacks {
    const open: OpenCall[] = [];
    const startCall = (name: string, args: unknown, key?: string): OpenCall => {
      const call = { id: `call_${++this.toolSeq}`, name, key };
      open.push(call);
      const loc = argPath(args);
      this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: call.id,
        title: titleFor(name, args),
        kind: toolKindFor(name),
        status: "pending",
        rawInput: maskArgsForDisplay(args),
        ...(loc ? { locations: [{ path: loc }] } : {}),
      });
      return call;
    };
    const finish = (
      name: string | undefined,
      status: "completed" | "failed",
      text: string,
      key?: string,
    ) => {
      const index = findOpenCall(open, name, key);
      if (index < 0) return;
      const [call] = open.splice(index, 1);
      this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: call.id,
        status,
        content: [
          {
            type: "content",
            // Masked before it is cut, so a secret the cut would split is
            // not sent as a recognisable half. The model got the real text.
            content: { type: "text", text: resultTextForClient(text) },
          },
        ],
      });
    };

    return {
      onContent: (content) => {
        if (!content) return;
        this.update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: content },
        });
      },
      onToolStart: (name, args, callId) => {
        startCall(name, args, callId);
      },
      onToolResult: (result, name, status, callId) => {
        finish(
          name,
          status === "done" ? "completed" : "failed",
          result,
          callId,
        );
      },
      onToolError: (error, name, callId) => {
        if (name || callId !== undefined) finish(name, "failed", error, callId);
      },
      onToolPermissionRequest: (name, args, requestId, _preview, callId) => {
        const call =
          open[findOpenCall(open, name, callId)] ??
          startCall(name, args, callId);
        this.pendingPermissions.add(requestId);
        void this.askClient({ sessionId, call, name, args, requestId, signal });
      },
    };
  }

  private async askClient(ask: {
    sessionId: string;
    call: OpenCall;
    name: string;
    args: unknown;
    requestId: string;
    signal: AbortSignal;
  }) {
    const { sessionId, call, name, args, requestId, signal } = ask;
    let approved = false;
    try {
      if (!signal.aborted) {
        const reply = await this.peer.request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: call.id,
            title: titleFor(name, args),
            kind: toolKindFor(name),
            status: "pending",
            rawInput: maskArgsForDisplay(args),
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        approved =
          !signal.aborted &&
          reply?.outcome?.outcome === "selected" &&
          reply.outcome.optionId === "allow";
      }
    } catch {
      approved = false;
    }
    // A cancel or the end of the turn may have refused it already
    if (this.pendingPermissions.delete(requestId)) {
      this.backend.resolvePermission(requestId, approved);
    }
  }
}
