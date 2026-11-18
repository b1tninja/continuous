import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setHostResolver } from "../../util/networkAddress";
import { fetchUrlContentImpl } from "./fetchUrlContent";

// Two public-looking names stand in for two hosts. A local server answers for
// both: the test's fetch sends every request to it and says which name was
// asked for in a header, so no request leaves the machine.
let server: http.Server;
let port: number;
const asked: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const host = String(req.headers["x-asked-host"]);
    asked.push(`${host}${req.url}`);
    if (req.url === "/same-start") {
      res.writeHead(302, { location: "/same-final" });
      res.end();
    } else if (req.url === "/cross-start") {
      res.writeHead(302, { location: "http://b.example.test/landing" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`served by ${host}${req.url}`);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise((r) => server.close(r)));
afterEach(() => {
  setHostResolver(undefined);
  asked.length = 0;
});

const localFetch = (url: string | URL, init?: any) => {
  const u = new URL(url);
  const headers = { "x-asked-host": u.hostname };
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, {
    ...init,
    headers,
  });
};

function publicNames() {
  setHostResolver(async (host: string) =>
    host.endsWith(".example.test") ? ["93.184.216.34"] : ["127.0.0.1"],
  );
}

describe("fetched pages are labelled with the final URL", () => {
  it("keeps the start URL when nothing redirects", async () => {
    publicNames();
    const [item] = await fetchUrlContentImpl(
      { url: "http://a.example.test/plain" },
      { fetch: localFetch } as never,
    );
    expect(item.description).toBe("http://a.example.test/plain");
    expect(item.uri?.value).toBe("http://a.example.test/plain");
  });

  it("labels a same-host redirect with the path it ended on", async () => {
    publicNames();
    const [item] = await fetchUrlContentImpl(
      { url: "http://a.example.test/same-start" },
      { fetch: localFetch } as never,
    );
    expect(item.description).toBe("http://a.example.test/same-final");
    expect(item.uri?.value).toBe("http://a.example.test/same-final");
    expect(item.content).toContain("served by a.example.test/same-final");
  });

  it("labels a cross-host redirect with the other host, not the start URL", async () => {
    publicNames();
    const [item] = await fetchUrlContentImpl(
      { url: "http://a.example.test/cross-start" },
      { fetch: localFetch } as never,
    );
    expect(asked).toEqual([
      "a.example.test/cross-start",
      "b.example.test/landing",
    ]);
    expect(item.description).toBe("http://b.example.test/landing");
    expect(item.uri?.value).toBe("http://b.example.test/landing");
    expect(item.content).toContain("served by b.example.test/landing");
  });

  it("puts the final URL in the spotlight source", async () => {
    publicNames();
    const items = await fetchUrlContentImpl(
      { url: "http://a.example.test/cross-start" },
      {
        fetch: localFetch,
        config: { experimental: { spotlightUntrusted: true } },
      } as never,
    );
    expect(items[0].description).toBe("http://b.example.test/landing");
    expect(items[0].content).toContain("url: http://b.example.test/landing");
  });
});
