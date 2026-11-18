import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeRequest,
  hostHeaderAllowed,
  installServeGuards,
  originHeaderAllowed,
  serveRequestProblem,
} from "./serve.helpers.js";

const TOKEN = "0123456789abcdef0123";

describe("the bearer token", () => {
  it("accepts the exact token", () => {
    expect(authorizeRequest(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(authorizeRequest(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a missing, different or partial token", () => {
    expect(authorizeRequest(undefined, TOKEN)).toBe(false);
    expect(authorizeRequest("", TOKEN)).toBe(false);
    expect(authorizeRequest(TOKEN, TOKEN)).toBe(false);
    expect(authorizeRequest(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(authorizeRequest(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
    expect(authorizeRequest("Basic abc", TOKEN)).toBe(false);
  });
});

describe("serve request headers", () => {
  it("accepts only a loopback name or address when the server is bound there", () => {
    for (const host of [
      "127.0.0.1",
      "127.0.0.1:8000",
      "localhost",
      "localhost:8000",
      "LOCALHOST:8000",
      "[::1]",
      "[::1]:8000",
      "::1",
    ]) {
      expect(hostHeaderAllowed(host, "127.0.0.1")).toBe(true);
    }
    for (const host of [
      undefined,
      "",
      "evil.example",
      "evil.example:8000",
      "127.0.0.1.evil.example",
      "192.168.1.20",
    ]) {
      expect(hostHeaderAllowed(host, "127.0.0.1")).toBe(false);
    }
  });

  it("matches the bound address when the server is not on loopback", () => {
    expect(hostHeaderAllowed("192.168.1.20:8000", "192.168.1.20")).toBe(true);
    expect(hostHeaderAllowed("127.0.0.1:8000", "192.168.1.20")).toBe(false);
    expect(hostHeaderAllowed("myhost", "MyHost")).toBe(true);
    expect(hostHeaderAllowed(undefined, "0.0.0.0")).toBe(false);
    expect(hostHeaderAllowed("192.168.1.20", "0.0.0.0")).toBe(true);
  });

  it("refuses a request that carries an Origin header", () => {
    expect(originHeaderAllowed(undefined)).toBe(true);
    expect(originHeaderAllowed("")).toBe(true);
    expect(originHeaderAllowed("   ")).toBe(true);
    expect(originHeaderAllowed("null")).toBe(false);
    expect(originHeaderAllowed("http://127.0.0.1:8000")).toBe(false);
    expect(originHeaderAllowed("https://evil.example")).toBe(false);

    expect(serveRequestProblem({ host: "evil.example" }, "127.0.0.1")).toEqual({
      status: 403,
      error:
        "The Host header must be the loopback name or address this server is bound to.",
    });
    expect(
      serveRequestProblem(
        { host: "127.0.0.1:8000", origin: "https://evil.example" },
        "127.0.0.1",
      )?.status,
    ).toBe(403);
    expect(
      serveRequestProblem({ host: "127.0.0.1:8000" }, "127.0.0.1"),
    ).toBeUndefined();
  });
});

describe("serve request guards", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  async function start(
    boundHost = "127.0.0.1",
    token: string | null = TOKEN,
  ): Promise<number> {
    const app = express();
    installServeGuards(app, { boundHost, token: token ?? undefined });
    app.use(express.json());
    let hits = 0;
    app.post("/exit", (_req, res) => {
      hits += 1;
      res.json({ ok: true, hits });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closers.push(
      () =>
        new Promise((resolve) => {
          server.close(() => resolve());
        }),
    );
    return (server.address() as AddressInfo).port;
  }

  function request(
    port: number,
    headers: http.OutgoingHttpHeaders,
    method = "POST",
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/exit", method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("rejects a Host that is not the bound loopback name or address", async () => {
    const port = await start();
    const res = await request(port, {
      host: "evil.example",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("loopback");
  });

  it("rejects a request that carries Origin, including one with the token", async () => {
    const port = await start();
    const res = await request(port, {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("Origin");
  });

  it("requires the bearer token and then accepts the request", async () => {
    const port = await start();
    const missing = await request(port, { host: `localhost:${port}` });
    expect(missing.status).toBe(401);

    const accepted = await request(port, {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body).hits).toBe(1);
  });

  it("without a token still checks Host and Origin but needs no bearer", async () => {
    const port = await start("127.0.0.1", null);
    const ok = await request(port, { host: `127.0.0.1:${port}` });
    expect(ok.status).toBe(200);
    const badHost = await request(port, { host: "evil.example" });
    expect(badHost.status).toBe(403);
    const badOrigin = await request(port, {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
    });
    expect(badOrigin.status).toBe(403);
  });

  it("accepts localhost when the server is bound to the loopback address", async () => {
    const port = await start("127.0.0.1");
    const res = await request(port, {
      host: `localhost:${port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(200);
  });

  it("refuses a request a web page made (Sec-Fetch-Site), allows none and absent", async () => {
    const port = await start("127.0.0.1", null);
    const host = `127.0.0.1:${port}`;
    for (const site of ["cross-site", "same-site", "same-origin"]) {
      const res = await request(port, { host, "sec-fetch-site": site });
      expect(res.status).toBe(403);
      expect(res.body).toContain("Sec-Fetch-Site");
    }
    expect(
      (await request(port, { host, "sec-fetch-site": "none" })).status,
    ).toBe(200);
    expect((await request(port, { host })).status).toBe(200);
  });

  it("answers 415 to a body that is not JSON, and still takes JSON and bodiless posts", async () => {
    const port = await start("127.0.0.1", null);
    const host = `127.0.0.1:${port}`;
    const text = "hello";
    const length = String(Buffer.byteLength(text));
    const plain = await request(
      port,
      { host, "content-type": "text/plain", "content-length": length },
      "POST",
      text,
    );
    expect(plain.status).toBe(415);
    const none = await request(
      port,
      { host, "content-length": length },
      "POST",
      text,
    );
    expect(none.status).toBe(415);
    const json = await request(
      port,
      {
        host,
        "content-type": "application/json; charset=utf-8",
        "content-length": "2",
      },
      "POST",
      "{}",
    );
    expect(json.status).toBe(200);
    // /pause and /exit post nothing: no content type is needed
    expect((await request(port, { host })).status).toBe(200);
    expect((await request(port, { host }, "GET")).status).toBe(404);
  });
});
