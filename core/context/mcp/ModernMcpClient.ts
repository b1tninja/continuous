import { FetchLike, RpcError, postRpc } from "./mcpHttpRpc";
import { currentQuestionsLevel, elicitationHandler } from "./mcpElicitation";
import { InputRequestHandler, resolveInputRequired } from "./mcpMrtr";
import {
  ClientIdentity,
  DiscoverResult,
  UNSUPPORTED_PROTOCOL_VERSION_CODE,
  buildRequestMeta,
} from "./mcpRevision";

export interface ModernClientOptions {
  url: string;
  clientInfo: ClientIdentity;
  discover: DiscoverResult;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  onInputRequest?: InputRequestHandler;
}

interface CallOpts {
  signal?: AbortSignal;
  timeout?: number;
}

export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

/**
 * Stateless client for revision 2026-07-28 over Streamable HTTP: no
 * handshake, no session id, `_meta` on every request. It offers the methods of
 * the SDK `Client` that the callers use, so it can stand in for it.
 */
export class ModernMcpClient {
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: ModernClientOptions) {}

  getServerCapabilities() {
    return this.opts.discover.capabilities as any;
  }

  getInstructions() {
    return this.opts.discover.instructions;
  }

  getServerVersion() {
    return this.opts.discover.serverInfo as any;
  }

  async close() {
    this.closed = true;
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    o?: CallOpts,
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("MCP client is closed");
    const signal =
      o?.timeout && o.signal
        ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeout)])
        : o?.timeout
          ? AbortSignal.timeout(o.timeout)
          : o?.signal;
    // The request id is new on every attempt, retries included.
    const { status, response } = await postRpc({
      url: this.opts.url,
      method,
      id: this.nextId++,
      params: {
        ...params,
        _meta: {
          ...(params._meta as object),
          ...buildRequestMeta(this.opts.clientInfo),
        },
      },
      headers: this.opts.headers,
      fetch: this.opts.fetch,
      signal,
    });
    if (!response) {
      throw new McpRpcError(
        -32603,
        `${method}: HTTP ${status} without a JSON-RPC answer`,
      );
    }
    if (response.error) {
      const e: RpcError = response.error;
      const hint =
        e.code === UNSUPPORTED_PROTOCOL_VERSION_CODE
          ? " (the server dropped revision 2026-07-28)"
          : "";
      throw new McpRpcError(e.code, `${e.message ?? "error"}${hint}`, e.data);
    }
    return (response.result ?? {}) as Record<string, unknown>;
  }

  /** A request whose result may ask for more input (tools/call, prompts/get, resources/read). */
  private call(method: string, params: Record<string, unknown>, o?: CallOpts) {
    return resolveInputRequired(
      (p) => this.send(method, p, o),
      params,
      this.opts.onInputRequest ?? elicitationHandler(currentQuestionsLevel),
    );
  }

  listTools(params: any = {}, o?: CallOpts): Promise<any> {
    return this.send("tools/list", params, o);
  }
  listResources(params: any = {}, o?: CallOpts): Promise<any> {
    return this.send("resources/list", params, o);
  }
  listResourceTemplates(params: any = {}, o?: CallOpts): Promise<any> {
    return this.send("resources/templates/list", params, o);
  }
  listPrompts(params: any = {}, o?: CallOpts): Promise<any> {
    return this.send("prompts/list", params, o);
  }
  /** Same shape as the SDK: the second argument is a result schema, unused here. */
  callTool(params: any, _schema?: unknown, o?: CallOpts): Promise<any> {
    return this.call("tools/call", params, o);
  }
  getPrompt(params: any, o?: CallOpts): Promise<any> {
    return this.call("prompts/get", params, o);
  }
  readResource(params: any, o?: CallOpts): Promise<any> {
    return this.call("resources/read", params, o);
  }
}
