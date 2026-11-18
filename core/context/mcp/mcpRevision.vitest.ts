import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { MCPManagerSingleton } from "./MCPManagerSingleton";
import { ModernMcpClient } from "./ModernMcpClient";
import { probeServerEra } from "./mcpDiscover";
import { MAX_LIST_ITEMS, MAX_LIST_PAGES, listAllPages } from "./mcpPagination";
import { resolveInputRequired } from "./mcpMrtr";
import { encodeHeaderValue, parseDiscoverResult } from "./mcpRevision";
import { MemoryToolPinStore, hashToolDefinition } from "./toolPinning";
import { setToolPinStore } from "./mcpToolPins";
import { MockRevisionServer, RevisionOptions } from "./mockMcpRevisionServer";
import { freePort, waitFor } from "./mockOAuthMcpServer";

// core's Vitest setup swaps fetch for node-fetch's; the SDK and this client
// want the native one (same pattern as MCPOauth.e2e.vitest.ts).
const nativeGlobals = {
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
};
let setupGlobals: typeof nativeGlobals;
beforeAll(() => {
  setupGlobals = {
    fetch: globalThis.fetch,
    Request: globalThis.Request,
    Response: globalThis.Response,
  };
  Object.assign(globalThis, nativeGlobals);
});
afterAll(() => {
  Object.assign(globalThis, setupGlobals);
});

const sha = (j: string) => createHash("sha256").update(j).digest("hex");
const clientInfo = { name: "test-client", version: "0.0.1" };

describe("pagination", () => {
  test("follows nextCursor to the end", async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      start: { items: [1, 2], nextCursor: "a" },
      a: { items: [3], nextCursor: "b" },
      b: { items: [4] },
    };
    const r = await listAllPages(async (c) => pages[c ?? "start"], {
      kind: "tools",
    });
    expect(r.items).toEqual([1, 2, 3, 4]);
    expect(r.warning).toBeUndefined();
  });

  test("stops at the page cap with a warning", async () => {
    let calls = 0;
    const r = await listAllPages(
      async () => ({ items: [calls++], nextCursor: `c${calls}` }),
      { kind: "tools" },
    );
    expect(calls).toBe(MAX_LIST_PAGES);
    expect(r.items).toHaveLength(MAX_LIST_PAGES);
    expect(r.warning).toMatch(/more than 20 pages of tools/);
  });

  test("stops at the item cap with a warning", async () => {
    const r = await listAllPages(
      async () => ({
        items: Array.from({ length: 900 }, (_, i) => i + Math.random()),
        nextCursor: String(Math.random()),
      }),
      { kind: "tools" },
    );
    expect(r.items).toHaveLength(MAX_LIST_ITEMS);
    expect(r.warning).toMatch(/more than 2000 tools/);
  });

  test("a repeated cursor ends the listing", async () => {
    const r = await listAllPages(
      async () => ({ items: [1], nextCursor: "x" }),
      {
        kind: "prompts",
      },
    );
    expect(r.items).toHaveLength(2);
    expect(r.warning).toMatch(/repeated a page cursor/);
  });

  test("a later page cannot shadow an earlier item", async () => {
    const r = await listAllPages(
      async (c) =>
        c
          ? { items: [{ name: "a", v: 2 }] }
          : { items: [{ name: "a", v: 1 }], nextCursor: "n" },
      { kind: "tools", keyOf: (t) => t.name },
    );
    expect(r.items).toEqual([{ name: "a", v: 1 }]);
  });
});

describe("input_required retry", () => {
  const original = { name: "t", arguments: { a: 1 } };

  test("retries with inputResponses and the exact requestState", async () => {
    const seen: any[] = [];
    const out = await resolveInputRequired(
      async (p) => {
        seen.push(p);
        return seen.length === 1
          ? {
              resultType: "input_required",
              inputRequests: {
                k: { method: "elicitation/create", params: {} },
              },
              requestState: "opaque==",
            }
          : { resultType: "complete", ok: true };
      },
      original,
      async () => ({ action: "accept", content: { x: "y" } }),
    );
    expect(out.ok).toBe(true);
    expect(seen[1]).toEqual({
      ...original,
      inputResponses: { k: { action: "accept", content: { x: "y" } } },
      requestState: "opaque==",
    });
  });

  test("sends no requestState when the server sent none", async () => {
    const seen: any[] = [];
    await resolveInputRequired(async (p) => {
      seen.push(p);
      return seen.length === 1
        ? {
            resultType: "input_required",
            inputRequests: { k: { method: "elicitation/create" } },
          }
        : { resultType: "complete" };
    }, original);
    expect(seen[1]).not.toHaveProperty("requestState");
    // no handler: the elicitation is declined
    expect(seen[1].inputResponses.k).toEqual({ action: "decline" });
  });

  test("a result without resultType is complete", async () => {
    const out = await resolveInputRequired(
      async () => ({ content: [] }),
      original,
    );
    expect(out).toEqual({ content: [] });
  });

  test("gives up after the round cap", async () => {
    await expect(
      resolveInputRequired(
        async () => ({ resultType: "input_required", requestState: "s" }),
        original,
      ),
    ).rejects.toThrow(/more than 8 times/);
  });

  test("an input_required result with nothing in it is an error", async () => {
    await expect(
      resolveInputRequired(
        async () => ({ resultType: "input_required" }),
        original,
      ),
    ).rejects.toThrow(/Malformed/);
  });
});

describe("discover result and headers", () => {
  test("parseDiscoverResult is strict", () => {
    expect(parseDiscoverResult(null)).toBeUndefined();
    expect(parseDiscoverResult({ supportedVersions: [] })).toBeUndefined();
    expect(
      parseDiscoverResult({ supportedVersions: [1], capabilities: {} }),
    ).toBeUndefined();
    expect(
      parseDiscoverResult({
        supportedVersions: ["2026-07-28"],
        capabilities: {},
      }),
    ).toMatchObject({ supportedVersions: ["2026-07-28"] });
  });

  test("Mcp-Name uses the Base64 sentinel outside plain ASCII", () => {
    expect(encodeHeaderValue("get_weather")).toBe("get_weather");
    expect(encodeHeaderValue("Hello, 世界")).toBe(
      "=?base64?SGVsbG8sIOS4lueVjA==?=",
    );
    expect(encodeHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeHeaderValue("=?base64?literal?=")).toBe(
      "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
    );
  });
});

describe("era probe against the mock server", () => {
  let mock: MockRevisionServer;
  afterEach(async () => mock?.stop());
  const start = async (o: RevisionOptions) => {
    mock = new MockRevisionServer(o);
    await mock.start();
    return mock;
  };
  const probe = (url: string) => probeServerEra({ url, clientInfo });

  test("a modern server is recognised, with the required headers", async () => {
    await start({ mode: "modern" });
    const r = await probe(mock.url);
    expect(r.era).toBe("modern");
    const sent = mock.requests[0];
    expect(sent.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(sent.headers["mcp-method"]).toBe("server/discover");
    expect(sent.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe(
      "2026-07-28",
    );
  });

  test("an old server (400 on the unknown method) is legacy", async () => {
    await start({ mode: "legacy" });
    expect((await probe(mock.url)).era).toBe("legacy");
  });

  test("a malformed discover result falls back", async () => {
    await start({ mode: "malformed-discover" });
    const r = await probe(mock.url);
    expect(r).toEqual({
      era: "legacy",
      reason: "malformed server/discover result",
    });
  });

  test("no common version falls back", async () => {
    await start({ mode: "other-version" });
    expect((await probe(mock.url)).era).toBe("legacy");
  });

  test("a dead port falls back without throwing", async () => {
    const port = await freePort();
    expect((await probe(`http://127.0.0.1:${port}/mcp`)).era).toBe("legacy");
  });
});

describe("MCPConnection negotiation end to end", { timeout: 20_000 }, () => {
  let mock: MockRevisionServer;
  const id = "rev";

  afterEach(async () => {
    await MCPManagerSingleton.getInstance().shutdown();
    await mock?.stop();
    setToolPinStore(undefined);
  });

  async function connect(o: RevisionOptions, type?: "streamable-http") {
    setToolPinStore(new MemoryToolPinStore() as any);
    mock = new MockRevisionServer(o);
    await mock.start();
    MCPManagerSingleton.getInstance().setConnections(
      [{ id, name: id, type, url: mock.url } as any],
      true,
      { ide: {} as any },
    );
    const conn = () => MCPManagerSingleton.getInstance().getConnection(id)!;
    await waitFor(
      () => ["error", "connected"].includes(conn().status),
      "connection",
    );
    return conn();
  }

  test("old server: falls back to initialize and pages tools", async () => {
    const conn = await connect({ mode: "legacy", toolCount: 5, pageSize: 2 });
    expect(conn.status).toBe("connected");
    expect(conn.client).not.toBeInstanceOf(ModernMcpClient);
    expect(mock.requests.map((r) => r.method)).toContain("initialize");
    expect(conn.tools.map((t) => t.name)).toEqual(
      mock.tools().map((t) => t.name),
    );
  });

  test("new server: discover, no initialize, paged tools, retry on input_required", async () => {
    const conn = await connect(
      { mode: "modern", toolCount: 5, pageSize: 2 },
      "streamable-http",
    );
    expect(conn.status).toBe("connected");
    expect(conn.client).toBeInstanceOf(ModernMcpClient);
    const methods = mock.requests.map((r) => r.method);
    expect(methods[0]).toBe("server/discover");
    expect(methods).not.toContain("initialize");
    expect(methods.filter((m) => m === "tools/list")).toHaveLength(3);
    expect(conn.tools).toHaveLength(5);

    const res: any = await conn.client.callTool({ name: "ask", arguments: {} });
    expect(res.content[0].text).toBe("action=decline state=state-1");
    const calls = mock.requests.filter((r) => r.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0].id).not.toBe(calls[1].id);
    expect(calls[1].headers["mcp-name"]).toBe("ask");
  });

  test("dual-era server: modern wins, same tools as the classic path", async () => {
    const conn = await connect({ mode: "dual", toolCount: 4, pageSize: 3 });
    expect(conn.client).toBeInstanceOf(ModernMcpClient);
    expect(conn.tools).toHaveLength(4);
  });

  test("malformed discover: the classic handshake still connects", async () => {
    const conn = await connect({ mode: "malformed-discover" });
    expect(conn.status).toBe("connected");
    expect(conn.client).not.toBeInstanceOf(ModernMcpClient);
  });

  test("endless pages are cut at the cap with a visible warning", async () => {
    const conn = await connect({
      mode: "legacy",
      toolCount: 100000,
      pageSize: 5,
      endlessPages: true,
    });
    expect(conn.status).toBe("connected");
    expect(conn.tools).toHaveLength(MAX_LIST_PAGES * 5);
    expect(conn.getStatus().infos.join("\n")).toMatch(
      /more than 20 pages of tools/,
    );
  });

  test("the tool-definition hash is the same paged or not", async () => {
    const paged = await connect({ mode: "modern", toolCount: 6, pageSize: 2 });
    const pagedHashes = paged.tools.map((t) =>
      hashToolDefinition(t as any, sha),
    );
    await MCPManagerSingleton.getInstance().shutdown();
    await mock.stop();
    const single = await connect({ mode: "modern", toolCount: 6, pageSize: 6 });
    expect(single.tools.map((t) => hashToolDefinition(t as any, sha))).toEqual(
      pagedHashes,
    );
  });
});
