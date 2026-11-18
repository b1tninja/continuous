import { MODERN_PROTOCOL_VERSION, encodeHeaderValue } from "./mcpRevision";

/** One POST of the stateless Streamable HTTP binding, and a bounded read of the answer. */

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type FetchLike = (url: string | URL, init?: any) => Promise<Response>;

export interface RpcError {
  code: number;
  message?: string;
  data?: unknown;
}

export interface RpcOutcome {
  status: number;
  /** Parsed JSON-RPC response with the matching id, when the body had one. */
  response?: { result?: unknown; error?: RpcError };
}

export interface PostRpcOptions {
  url: string;
  method: string;
  params: Record<string, unknown>;
  id: number | string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

function mcpName(method: string, params: Record<string, unknown>) {
  if (method === "tools/call" || method === "prompts/get") {
    return typeof params.name === "string" ? params.name : undefined;
  }
  if (method === "resources/read") {
    return typeof params.uri === "string" ? params.uri : undefined;
  }
  return undefined;
}

async function readBounded(res: Response): Promise<string> {
  const reader = (res.body as any)?.getReader?.();
  // A polyfilled Response (node-fetch) has no web stream: read it whole.
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error("MCP response is larger than the 8 MiB limit");
    }
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("MCP response is larger than the 8 MiB limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function matches(msg: unknown, id: number | string) {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as any).id === id &&
    ("result" in msg || "error" in msg)
  );
}

function pick(text: string, contentType: string, id: number | string) {
  if (contentType.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (matches(msg, id)) return msg;
      } catch {
        // a comment or a non-JSON event: ignore
      }
    }
    return undefined;
  }
  try {
    const msg = JSON.parse(text);
    return matches(msg, id) ? msg : undefined;
  } catch {
    return undefined;
  }
}

/** POST one JSON-RPC request with the headers revision 2026-07-28 requires. */
export async function postRpc(opts: PostRpcOptions): Promise<RpcOutcome> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  const headers: Record<string, string> = {
    ...opts.headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
    "Mcp-Method": opts.method,
  };
  const name = mcpName(opts.method, opts.params);
  if (name !== undefined) headers["Mcp-Name"] = encodeHeaderValue(name);
  const res = await doFetch(opts.url, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: opts.id,
      method: opts.method,
      params: opts.params,
    }),
  });
  let text = "";
  try {
    text = await readBounded(res);
  } catch (e) {
    if (res.ok) throw e;
  }
  return {
    status: res.status,
    response: pick(text, res.headers.get("content-type") ?? "", opts.id),
  };
}
