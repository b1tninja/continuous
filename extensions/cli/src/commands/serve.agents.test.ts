import http from "node:http";
import type { AddressInfo } from "node:net";

import { agentRegistry } from "core/agents/registry.js";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { emitAgent, ensureMainAgent } from "../agents/feed.js";

import { registerAgentsRoute } from "./serve.agents.js";
import { installServeGuards, type ServerState } from "./serve.helpers.js";

const TOKEN = "0123456789abcdef0123";
const SECRET = "AKIAIOSFODNN7CANARY0";

function serveState(over: Partial<ServerState> = {}): ServerState {
  return {
    session: {
      sessionId: "s1",
      title: SECRET,
      workspaceDirectory: `/home/${SECRET}`,
      history: [
        {
          message: { role: "user", content: `my key is ${SECRET}` },
          contextItems: [],
        },
      ],
    },
    config: { apiKey: SECRET },
    model: { apiKey: SECRET },
    isProcessing: false,
    lastActivity: 0,
    currentAbortController: null,
    serverRunning: true,
    pendingPermission: null,
    ...over,
  } as unknown as ServerState;
}

describe("GET /agents", () => {
  const closers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    agentRegistry.reset();
  });
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  async function start(state: ServerState): Promise<number> {
    const app = express();
    installServeGuards(app, { boundHost: "127.0.0.1", token: TOKEN });
    app.use(express.json());
    registerAgentsRoute(app, state);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    return (server.address() as AddressInfo).port;
  }

  function get(
    port: number,
    headers: http.OutgoingHttpHeaders,
    method = "GET",
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/agents", method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  const ok = { host: "127.0.0.1", authorization: `Bearer ${TOKEN}` };

  it("answers the same guards as the other routes: token, Host and Origin", async () => {
    const port = await start(serveState());
    expect((await get(port, { host: "127.0.0.1" })).status).toBe(401);
    expect(
      (await get(port, { host: "127.0.0.1", authorization: "Bearer nope" }))
        .status,
    ).toBe(401);
    expect((await get(port, { ...ok, host: "evil.example" })).status).toBe(403);
    expect(
      (await get(port, { ...ok, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await get(port, ok)).status).toBe(200);
  });

  it("lists the main node and the agents, and never the session, arguments or a secret", async () => {
    const main = ensureMainAgent();
    emitAgent({
      type: "spawned",
      id: "agent-1",
      parentId: main,
      rootId: main,
      kind: "subagent",
      role: "explore",
      model: "Haiku",
      at: 5,
    });
    emitAgent({ type: "activity", id: "agent-1", tool: "Bash" });
    const port = await start(
      serveState({
        pendingPermission: {
          toolName: "Bash",
          toolArgs: { command: `curl -H "Authorization: Bearer ${SECRET}"` },
          requestId: "r1",
          timestamp: 1,
          toolCallPreview: [{ type: "text", content: SECRET }],
        } as never,
      }),
    );
    const res = await get(port, ok);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("curl");
    const json = JSON.parse(res.body);
    expect(Object.keys(json).sort()).toEqual([
      "generatedAt",
      "needsYou",
      "nodes",
      "totals",
    ]);
    const nodes = json.nodes as { id: string; kind: string; state: string }[];
    expect(nodes.map((n) => n.kind)).toEqual(["main", "subagent"]);
    expect(nodes[0].state).toBe("waiting-approval");
    expect(json.needsYou).toEqual([main]);
    expect(nodes[1]).toMatchObject({
      state: "running",
      activity: "running a command",
    });
  });

  it("does not take POST", async () => {
    const port = await start(serveState());
    expect((await get(port, ok, "POST")).status).toBe(404);
  });
});
