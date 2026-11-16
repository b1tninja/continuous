import * as fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { getUrlContextItems } from "../context/providers/URLContextProvider";
import { fetchSearchResults } from "../context/providers/webSearchBackend";
import CheerioCrawler from "../indexing/docs/crawlers/CheerioCrawler";
import { chromiumUserAgentArgs } from "../indexing/docs/crawlers/ChromiumCrawler";
import { fetchUrlContentImpl } from "../tools/implementations/fetchUrlContent";
import { findFaviconPath } from "../util/fetchFavicon";
import { getFetchLog, resetFetchLogForTests } from "../util/fetchRecord";
import {
  fetchWithGuardedRedirects,
  MAX_REDIRECTS_CEILING,
} from "../util/guardedFetch";
import { modelToolFetch } from "../util/modelToolFetch";
import { setHostResolver } from "../util/networkAddress";
import { networkFetchWith } from "../util/networkFetch";
import { applyWebConfig, resetWebConfigForTests } from "../util/webConfig";

import { WEB_AGENT_INFO_URL } from "./userAgent";
import { setWebAgentVersion } from "./webHeaders";

/**
 * WB17 on the wire: every path's request reaches a local HTTP proxy, which
 * records the headers exactly as the HTTP client sent them. The proxy answers
 * for every host itself, so nothing leaves the machine.
 */

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: string[];
}

let proxy: http.Server;
let proxyUrl: string;
const seen: Seen[] = [];
let dir: string;

function writeUserConfig(yaml: string) {
  const file = path.join(dir, "config.yaml");
  fs.writeFileSync(file, yaml);
  resetWebConfigForTests(file);
}

const transport = () => ({ proxy: proxyUrl, useSystemCa: false });
const toolFetch = () => modelToolFetch({ requestOptions: transport() });

const USER_UA = `Continuous-User/2.26 (+${WEB_AGENT_INFO_URL})`;
const CRAWLER_UA = `Continuous-Crawler/2.26 (+${WEB_AGENT_INFO_URL})`;

beforeAll(async () => {
  for (const k of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
  ]) {
    delete process.env[k];
  }
  proxy = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/");
    seen.push({ url: u.toString(), headers: req.headers, raw: req.rawHeaders });
    const hop = /^\/hop\/(\d+)$/.exec(u.pathname);
    if (hop) {
      res.statusCode = 302;
      res.setHeader("location", `/hop/${Number(hop[1]) + 1}`);
      res.end();
    } else if (u.pathname === "/to-other") {
      res.statusCode = 302;
      res.setHeader("location", "http://other.example/landing");
      res.end();
    } else if (u.pathname === "/search") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [{ title: "T", url: "u" }] }));
    } else {
      res.setHeader("content-type", "text/html");
      res.end(
        '<html><head><link rel="icon" href="/i.png"><title>t</title></head><body><a href="/two">two</a><p>words</p></body></html>',
      );
    }
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  setHostResolver(async () => ["93.184.215.14"]);
});

afterAll(async () => {
  setHostResolver(undefined);
  (proxy as any).closeAllConnections?.();
  await new Promise((r) => proxy.close(r));
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb17-"));
  writeUserConfig("");
  seen.length = 0;
  resetFetchLogForTests();
  setWebAgentVersion("2.26.3");
});

afterEach(() => {
  setWebAgentVersion(undefined);
  resetWebConfigForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Header names a request must never carry by default. */
const NEVER = ["from", "referer", "cookie", "accept-language", "sec-ch-ua"];

function expectClean(s: Seen) {
  for (const name of NEVER)
    expect(s.headers[name], `${name} on ${s.url}`).toBeUndefined();
  expect(s.headers["user-agent"]).not.toMatch(/node-fetch|node\/|undici/i);
  expect(s.headers["user-agent"]).not.toContain("2.26.3");
  expect(JSON.stringify(s.headers)).not.toMatch(
    /x-continue-unique-id|win32|darwin|vscode|jetbrains/i,
  );
}

describe("the User-Agent on every path, as sent", () => {
  it("the fetch tool (and the CLI Fetch, which runs it)", async () => {
    await fetchUrlContentImpl({ url: "http://site.example/page" }, {
      fetch: toolFetch(),
    } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["user-agent"]).toBe(USER_UA);
    expect(seen[0].headers.accept).toMatch(/^text\/markdown,/);
    expectClean(seen[0]);
    expect(getFetchLog().list()[0].userAgent).toBe(USER_UA);
  });

  it("@url and its favicon lookup", async () => {
    await getUrlContextItems("http://site.example/page", toolFetch(), {
      requestOptions: transport(),
    });
    // the favicon's page, the icon, then the page
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.headers["user-agent"], s.url).toBe(USER_UA);
      expectClean(s);
    }
    expect(seen.at(-1)!.headers.accept).toMatch(/^text\/markdown,/);
  });

  it("the favicon lookup alone", async () => {
    await findFaviconPath(new URL("http://site.example/x"), transport());
    expect(seen[0].headers["user-agent"]).toBe(USER_UA);
    expectClean(seen[0]);
  });

  it("the search backend: the product token without the info URL (UA-3)", async () => {
    await fetchSearchResults("q", 1, toolFetch(), {
      url: "http://search.example/search",
    } as never);
    expect(seen[0].headers["user-agent"]).toBe("Continuous-User/2.26");
    expect(seen[0].headers.accept).toBe("application/json");
    expectClean(seen[0]);
  });

  it("the Cheerio docs crawler sends Continuous-Crawler, not node-fetch", async () => {
    const crawler = new CheerioCrawler(
      new URL("http://docs.example/"),
      2,
      1,
      transport(),
    );
    for await (const _ of crawler.crawl()) {
      // read every page
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) {
      expect(s.headers["user-agent"], s.url).toBe(CRAWLER_UA);
      expect(s.headers.accept).toMatch(/^text\/html,/);
      expectClean(s);
    }
  });

  it("the Chromium docs crawler gets Continuous-Crawler, not the Chrome 88 string", () => {
    expect(chromiumUserAgentArgs(new URL("https://docs.example/"))).toEqual([
      `--user-agent=${CRAWLER_UA}`,
    ]);
    writeUserConfig("web:\n  userAgent:\n    preset: custom\n    custom: ''\n");
    expect(chromiumUserAgentArgs(new URL("https://docs.example/"))).toEqual([]);
  });
});

describe("the person's choices, as sent", () => {
  it("a preset applies to every path", async () => {
    writeUserConfig("web:\n  userAgent:\n    preset: generic-agent\n");
    await fetchUrlContentImpl({ url: "http://site.example/page" }, {
      fetch: toolFetch(),
    } as never);
    await fetchSearchResults("q", 1, toolFetch(), {
      url: "http://search.example/search",
    } as never);
    expect(seen.map((s) => s.headers["user-agent"])).toEqual([
      "Mozilla/5.0 (compatible)",
      "Mozilla/5.0 (compatible)",
    ]);
  });

  it('custom "" goes out empty, not as node-fetch', async () => {
    writeUserConfig("web:\n  userAgent:\n    preset: custom\n    custom: ''\n");
    await fetchUrlContentImpl({ url: "http://site.example/page" }, {
      fetch: toolFetch(),
    } as never);
    expect(seen[0].headers["user-agent"]).toBe("");
  });

  it("Accept-Language only when set", async () => {
    writeUserConfig("web:\n  acceptLanguage: en-GB\n");
    await fetchUrlContentImpl({ url: "http://site.example/page" }, {
      fetch: toolFetch(),
    } as never);
    expect(seen[0].headers["accept-language"]).toBe("en-GB");
  });

  it("a per-host User-Agent and header stay on that host across a redirect", async () => {
    writeUserConfig(
      [
        "web:",
        "  hosts:",
        "    '*.intranet.example':",
        "      headers:",
        "        X-Intranet-Token: t0k",
        "      userAgent:",
        "        preset: firefox-linux",
      ].join("\n"),
    );
    await getUrlContextItems(
      "http://wiki.intranet.example/to-other",
      toolFetch(),
      { guardRedirects: true },
    );
    expect(seen.map((s) => s.url)).toEqual([
      "http://wiki.intranet.example/to-other",
      "http://other.example/landing",
    ]);
    expect(seen[0].headers["user-agent"]).toMatch(/Firefox\//);
    expect(seen[0].headers["x-intranet-token"]).toBe("t0k");
    expect(seen[1].headers["user-agent"]).toBe(USER_UA);
    expect(seen[1].headers["x-intranet-token"]).toBeUndefined();
  });

  it("a workspace config cannot set the User-Agent, a host header or a language", async () => {
    const out = applyWebConfig({
      userAgent: { preset: "chrome-windows" },
      acceptLanguage: "fr-FR",
      hosts: { "site.example": { headers: { "X-Repo": "1" } } },
    });
    expect(out.notices.length).toBeGreaterThanOrEqual(3);
    await fetchUrlContentImpl({ url: "http://site.example/page" }, {
      fetch: toolFetch(),
    } as never);
    expect(seen[0].headers["user-agent"]).toBe(USER_UA);
    expect(seen[0].headers["x-repo"]).toBeUndefined();
    expect(seen[0].headers["accept-language"]).toBeUndefined();
  });
});

describe("web.limits.maxRedirects", () => {
  const follow = (maxRedirects?: number) =>
    fetchWithGuardedRedirects(
      new URL("http://site.example/hop/0"),
      networkFetchWith(transport()),
      { maxRedirects },
    ).then(
      () => "followed",
      (e: Error) => e.message,
    );

  it("follows 5 by default", async () => {
    expect(await follow()).toMatch(/more than 5/);
    expect(seen).toHaveLength(6);
  });

  it("follows the person's lower or higher number, never above the ceiling", async () => {
    writeUserConfig("web:\n  limits:\n    maxRedirects: 2\n");
    expect(await follow()).toMatch(/more than 2/);
    expect(seen).toHaveLength(3);

    seen.length = 0;
    writeUserConfig("web:\n  limits:\n    maxRedirects: 8\n");
    expect(await follow()).toMatch(/more than 8/);

    seen.length = 0;
    writeUserConfig("web:\n  limits:\n    maxRedirects: 50\n");
    expect(await follow()).toMatch(
      new RegExp(`more than ${MAX_REDIRECTS_CEILING}`),
    );
    expect(MAX_REDIRECTS_CEILING).toBe(10);
  });

  it("a workspace may lower it and not raise it", async () => {
    applyWebConfig({ limits: { maxRedirects: 1 } });
    expect(await follow()).toMatch(/more than 1/);

    seen.length = 0;
    resetWebConfigForTests(path.join(dir, "config.yaml"));
    applyWebConfig({ limits: { maxRedirects: 9 } });
    expect(await follow()).toMatch(/more than 5/);
  });

  it("a caller may only lower it", async () => {
    expect(await follow(1)).toMatch(/more than 1/);
    seen.length = 0;
    expect(await follow(50)).toMatch(/more than 5/);
  });

  it("0 follows none", async () => {
    writeUserConfig("web:\n  limits:\n    maxRedirects: 0\n");
    expect(await follow()).toMatch(/more than 0/);
    expect(seen).toHaveLength(1);
  });
});
