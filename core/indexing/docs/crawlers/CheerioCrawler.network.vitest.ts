import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import CheerioCrawler from "./CheerioCrawler";

/**
 * A plain HTTP proxy stands in for the corporate one. It answers for every
 * host, so a crawl of docs.test can only succeed if the request was sent to
 * the proxy, which global fetch would not do.
 */
describe("CheerioCrawler network behaviour", () => {
  let proxy: http.Server;
  let proxyUrl: string;
  const seen: string[] = [];

  beforeAll(async () => {
    for (const k of ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]) {
      delete process.env[k];
    }
    proxy = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === "http://docs.test/") {
        res.setHeader("content-type", "text/html");
        res.end('<a href="/redir">r</a><a href="/page">p</a>hello');
      } else if (req.url === "http://docs.test/page") {
        res.end("page two");
      } else if (req.url === "http://docs.test/redir") {
        res.statusCode = 302;
        res.setHeader("location", "http://169.254.169.254/latest/meta-data/");
        res.end();
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    (proxy as any).closeAllConnections?.();
    await new Promise((r) => proxy.close(r));
  });

  it("goes through the configured proxy and refuses a redirect to the metadata address", async () => {
    const crawler = new CheerioCrawler(new URL("http://docs.test/"), 10, 1, {
      proxy: proxyUrl,
      useSystemCa: false,
    });
    const pages: string[] = [];
    for await (const page of crawler.crawl()) pages.push(page.path);

    expect(pages).toContain("/");
    expect(pages).toContain("/page");
    expect(pages).not.toContain("/redir");
    expect(seen).toContain("http://docs.test/redir");
    // The redirect was read and refused: the target was never requested.
    expect(seen.some((u) => u.includes("169.254.169.254"))).toBe(false);
  });
});
