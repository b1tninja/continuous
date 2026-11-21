import * as dns from "node:dns";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { fetchwithRequestOptions } from "./fetch.js";

/** Starts a server on one loopback address only, or returns the reason it cannot. */
async function listenOn(
  address: string,
): Promise<{ server: http.Server; port: number } | { reason: string }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("connection", "close");
    res.end(`served from ${address}`);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, address, resolve);
    });
  } catch (e) {
    return { reason: `cannot listen on ${address}: ${(e as Error).message}` };
  }
  return { server, port: (server.address() as AddressInfo).port };
}

describe.each([
  ["node-fetch", undefined],
  ["web fetch", "1"],
])("localhost over %s", (_name, webFetchFlag) => {
  let localhostFamilies: number[] = [];
  const servers: http.Server[] = [];
  const savedFlag = process.env.CONTINUE_USE_WEB_FETCH;
  const savedAutoSelect = net.getDefaultAutoSelectFamily();

  beforeAll(async () => {
    if (webFetchFlag) process.env.CONTINUE_USE_WEB_FETCH = webFetchFlag;
    else delete process.env.CONTINUE_USE_WEB_FETCH;
    const addresses = await dns.promises
      .lookup("localhost", { all: true })
      .catch(() => []);
    localhostFamilies = addresses.map((a) => a.family);
  });

  afterEach(() => {
    net.setDefaultAutoSelectFamily(savedAutoSelect);
    for (const server of servers) {
      server.closeAllConnections?.();
      server.close();
    }
    servers.length = 0;
  });

  afterAll(() => {
    if (savedFlag === undefined) delete process.env.CONTINUE_USE_WEB_FETCH;
    else process.env.CONTINUE_USE_WEB_FETCH = savedFlag;
  });

  // The process default is turned off in half the cases so the result does
  // not depend on the runtime's own setting.
  test.for([
    ["::1", 6, true],
    ["::1", 6, false],
    ["127.0.0.1", 4, true],
    ["127.0.0.1", 4, false],
  ] as const)(
    "reaches a server bound to %s only (family %i, process auto-select %s)",
    async ([address, family, processDefault], ctx) => {
      if (!localhostFamilies.includes(family)) {
        ctx.skip(
          `localhost does not resolve to an IPv${family} address on this machine`,
        );
        return;
      }
      const started = await listenOn(address);
      if ("reason" in started) {
        ctx.skip(started.reason);
        return;
      }
      servers.push(started.server);
      net.setDefaultAutoSelectFamily(processDefault);

      const resp = await fetchwithRequestOptions(
        `http://localhost:${started.port}/`,
      );
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe(`served from ${address}`);
    },
  );
});
