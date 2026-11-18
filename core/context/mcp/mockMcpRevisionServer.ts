import http from "node:http";
import { AddressInfo } from "node:net";

/**
 * Test helper: a mock MCP server that speaks the classic `initialize`
 * handshake, revision 2026-07-28 (stateless, `server/discover`), or both.
 * Records every request so a test can assert what the client sent.
 */

export type RevisionMode =
  /** Classic only: `server/discover` is an unknown method (HTTP 400, empty body). */
  | "legacy"
  /** 2026-07-28 only: `initialize` is rejected, requests need the headers. */
  | "modern"
  /** Both: discover answers, `initialize` still works. */
  | "dual"
  /** Discover answers 200 with garbage; the classic path works. */
  | "malformed-discover"
  /** Discover answers 200 with a result that lists no common version. */
  | "other-version";

export interface RevisionOptions {
  mode: RevisionMode;
  toolCount?: number;
  pageSize?: number;
  /** Every tools/list page carries a nextCursor, forever. */
  endlessPages?: boolean;
  /** tools/list repeats the same cursor. */
  loopCursor?: boolean;
}

export interface Recorded {
  method: string;
  headers: http.IncomingHttpHeaders;
  params: any;
  id: unknown;
}

export class MockRevisionServer {
  server!: http.Server;
  base = "";
  readonly requests: Recorded[] = [];
  /** tools/call attempts of the "ask" tool before it answers. */
  askRounds = 1;
  private asked = 0;

  constructor(private o: RevisionOptions) {}

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    (this.server as any).closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }

  get url() {
    return `${this.base}/mcp`;
  }

  tools() {
    const n = this.o.toolCount ?? 3;
    return Array.from({ length: n }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool number ${i}`,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  private send(res: http.ServerResponse, status: number, body?: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") return this.send(res, 405);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(res, 400);
    }
    this.requests.push({
      method: msg.method,
      headers: req.headers,
      params: msg.params,
      id: msg.id,
    });
    const modernMeta =
      !!msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    const { mode } = this.o;
    const reply = (result: unknown) =>
      this.send(res, 200, { jsonrpc: "2.0", id: msg.id, result });

    if (msg.method === "initialize") {
      if (mode === "modern") {
        return this.send(res, 400, {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32600,
            message: "initialize is not supported; use 2026-07-28",
          },
        });
      }
      return reply({
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "1" },
      });
    }
    if (msg.method === "notifications/initialized") return this.send(res, 202);

    if (msg.method === "server/discover") {
      if (mode === "legacy") return this.send(res, 400);
      if (mode === "malformed-discover") {
        return this.send(res, 200, {
          jsonrpc: "2.0",
          id: msg.id,
          result: { nope: 1 },
        });
      }
      return reply({
        resultType: "complete",
        supportedVersions:
          mode === "other-version" ? ["2030-01-01"] : ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "mock", version: "1" },
        },
      });
    }

    if (mode === "modern" && !modernMeta) {
      return this.send(res, 400, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32020, message: "missing _meta" },
      });
    }

    if (msg.method === "tools/list")
      return reply(this.listPage(msg.params?.cursor));
    if (msg.method === "tools/call") return this.call(msg, reply);
    return this.send(res, 404, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "Method not found" },
    });
  }

  private listPage(cursor?: string) {
    const all = this.tools();
    const size = this.o.pageSize ?? all.length;
    if (this.o.loopCursor) {
      return { tools: all.slice(0, 1), nextCursor: "same" };
    }
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + size);
    const next = start + size;
    if (this.o.endlessPages) {
      // Endless pages of fresh tool names.
      return {
        tools: slice.map((t) => ({ ...t, name: `${t.name}_p${start}` })),
        nextCursor: String(next),
      };
    }
    return next < all.length
      ? { tools: slice, nextCursor: String(next) }
      : { tools: slice };
  }

  private call(msg: any, reply: (r: unknown) => void) {
    if (msg.params?.name === "ask") {
      const answered = msg.params.inputResponses?.who;
      if (this.asked < this.askRounds && !answered) {
        this.asked++;
        return reply({
          resultType: "input_required",
          inputRequests: {
            who: {
              method: "elicitation/create",
              params: {
                mode: "form",
                message: "Who?",
                requestedSchema: { type: "object", properties: {} },
              },
            },
          },
          requestState: "state-" + this.asked,
        });
      }
      return reply({
        resultType: "complete",
        content: [
          {
            type: "text",
            text: `action=${answered?.action} state=${msg.params.requestState}`,
          },
        ],
      });
    }
    return reply({
      resultType: "complete",
      content: [{ type: "text", text: `called ${msg.params?.name}` }],
    });
  }
}
