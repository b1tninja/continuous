import { describe, expect, it } from "vitest";

import { resolveWebConfig } from "../util/webConfig";
import {
  BROWSER_USER_AGENT_PRESETS,
  CRAWLER_PRODUCT_TOKEN,
  GENERIC_AGENT_USER_AGENT,
  ROBOTS_PRODUCT_TOKEN,
  robotsProductToken,
  USER_PRODUCT_TOKEN,
  WEB_AGENT_INFO_URL,
} from "./userAgent";
import {
  CRAWLER_ACCEPT,
  hostOverrideFor,
  hostPatternMatches,
  mergeHeaders,
  PAGE_ACCEPT,
  webRequestHeaders,
  webUserAgent,
} from "./webHeaders";

/** WB17: the header policy as a pure function of the resolved `web:` config. */

const config = (user?: unknown, other?: unknown) =>
  resolveWebConfig({ user, other, env: {} }).config;

const VERSION = "2.26.3";
const url = (s: string) => new URL(s);

describe("the User-Agent per path", () => {
  const defaults = config();
  it.each([
    ["tool", `Continuous-User/2.26 (+${WEB_AGENT_INFO_URL})`],
    ["url", `Continuous-User/2.26 (+${WEB_AGENT_INFO_URL})`],
    ["favicon", `Continuous-User/2.26 (+${WEB_AGENT_INFO_URL})`],
    ["panel", `Continuous-User/2.26 (+${WEB_AGENT_INFO_URL})`],
    ["crawler", `Continuous-Crawler/2.26 (+${WEB_AGENT_INFO_URL})`],
    // UA-3: the search backend is the person's own; no info page
    ["search", "Continuous-User/2.26"],
  ] as const)("%s sends %s", (purpose, expected) => {
    expect(
      webRequestHeaders(purpose, url("https://a.example/"), defaults, VERSION)[
        "User-Agent"
      ],
    ).toBe(expected);
  });

  it("never carries the OS, the editor, the Node version, the patch version or an id (UA-4)", () => {
    for (const purpose of [
      "tool",
      "url",
      "favicon",
      "search",
      "crawler",
      "panel",
    ] as const) {
      const ua = webUserAgent(
        purpose,
        url("https://a.example/"),
        defaults,
        VERSION,
      );
      expect(ua).not.toContain(VERSION);
      expect(ua).not.toContain(process.version);
      expect(ua).not.toMatch(
        /windows|win32|win64|darwin|mac ?os|linux|vs ?code|jetbrains|intellij|node/i,
      );
      expect(ua).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });

  it("says 0.0 before a version is known, never a longer string", () => {
    expect(
      webUserAgent("tool", url("https://a.example/"), defaults, undefined),
    ).toMatch(/^Continuous-User\/0\.0 /);
  });
});

describe("presets chosen in the person's config", () => {
  const ua = (setting: unknown, purpose: "tool" | "crawler" = "tool") =>
    webUserAgent(
      purpose,
      url("https://a.example/"),
      config({ userAgent: setting }),
      VERSION,
    );

  it("serves generic-agent, a browser preset and a custom string on every path", () => {
    expect(ua({ preset: "generic-agent" })).toBe(GENERIC_AGENT_USER_AGENT);
    expect(ua({ preset: "generic-agent" }, "crawler")).toBe(
      GENERIC_AGENT_USER_AGENT,
    );
    const chrome = BROWSER_USER_AGENT_PRESETS.find(
      (p) => p.id === "chrome-windows",
    )!;
    expect(ua({ preset: "chrome-windows" })).toBe(chrome.userAgent);
    expect(ua({ preset: "custom", custom: "Mine/1" }, "crawler")).toBe(
      "Mine/1",
    );
  });

  it('sends an empty User-Agent for custom "", so the client cannot add its own', () => {
    const headers = webRequestHeaders(
      "tool",
      url("https://a.example/"),
      config({ userAgent: { preset: "custom", custom: "" } }),
    );
    expect(headers["User-Agent"]).toBe("");
  });

  it("falls back to continuous for an unknown preset id", () => {
    expect(ua({ preset: "netscape-4" })).toMatch(/^Continuous-User\/2\.26 /);
  });
});

describe("per-host overrides (web.hosts)", () => {
  const hosts = {
    "*.intranet.example": {
      userAgent: { preset: "chrome-windows" },
      headers: { "X-Intranet-Token": "t0k", Cookie: "no", Host: "evil" },
    },
    "wiki.intranet.example": {
      userAgent: { preset: "custom", custom: "Wiki-Gate/1" },
    },
    "host:plain.example": { headers: { "X-Plain": "1" } },
  };
  const c = config({ hosts });

  it("matches the host: rule syntax on whole labels", () => {
    expect(hostPatternMatches("*.intranet.example", "a.intranet.example")).toBe(
      true,
    );
    expect(
      hostPatternMatches("*.intranet.example", "A.B.Intranet.Example."),
    ).toBe(true);
    // Not the apex, not a look-alike suffix
    expect(hostPatternMatches("*.intranet.example", "intranet.example")).toBe(
      false,
    );
    expect(
      hostPatternMatches("*.intranet.example", "evilintranet.example"),
    ).toBe(false);
    expect(hostPatternMatches("plain.example", "x.plain.example")).toBe(false);
    expect(hostPatternMatches("host:plain.example", "plain.example")).toBe(
      true,
    );
    // A bare * is only for deny rules
    expect(hostPatternMatches("*", "anything.example")).toBe(false);
  });

  it("prefers an exact pattern over a wildcard", () => {
    expect(
      hostOverrideFor(c.hosts, "wiki.intranet.example")?.userAgent,
    ).toEqual({ preset: "custom", custom: "Wiki-Gate/1" });
    expect(
      hostOverrideFor(c.hosts, "docs.intranet.example")?.userAgent,
    ).toEqual({ preset: "chrome-windows" });
  });

  it("sends the host's User-Agent and headers to that host only", () => {
    const inside = webRequestHeaders(
      "tool",
      url("https://docs.intranet.example/"),
      c,
      VERSION,
    );
    expect(inside["User-Agent"]).toMatch(/Chrome\//);
    expect(inside["X-Intranet-Token"]).toBe("t0k");
    // The client's and the session's headers cannot be set this way
    expect(inside.Cookie).toBeUndefined();
    expect(inside.Host).toBeUndefined();

    const outside = webRequestHeaders(
      "tool",
      url("https://elsewhere.example/"),
      c,
      VERSION,
    );
    expect(outside["User-Agent"]).toMatch(/^Continuous-User\/2\.26 /);
    expect(outside["X-Intranet-Token"]).toBeUndefined();
  });
});

describe("a workspace or assistant config cannot set what is sent", () => {
  it("ignores userAgent, hosts and acceptLanguage from any other source, with a notice", () => {
    const resolution = resolveWebConfig({
      other: {
        userAgent: { preset: "chrome-windows" },
        acceptLanguage: "fr-FR",
        hosts: {
          "*.example": {
            userAgent: { preset: "firefox-linux" },
            headers: { "X-Repo": "1" },
          },
        },
      },
      env: {},
    });
    const headers = webRequestHeaders(
      "tool",
      url("https://a.example/"),
      resolution.config,
      VERSION,
    );
    expect(headers).toEqual({
      Accept: PAGE_ACCEPT,
      "User-Agent": `Continuous-User/2.26 (+${WEB_AGENT_INFO_URL})`,
    });
    expect(resolution.notices.join("\n")).toMatch(/userAgent/);
    expect(resolution.notices.join("\n")).toMatch(/hosts/);
  });

  it("keeps the person's own choice when a workspace names another", () => {
    const c = config(
      { userAgent: { preset: "generic-agent" } },
      { userAgent: { preset: "chrome-windows" } },
    );
    expect(webUserAgent("tool", url("https://a.example/"), c)).toBe(
      GENERIC_AGENT_USER_AGENT,
    );
  });
});

describe("the other headers", () => {
  it("asks for Markdown first on a page, HTML first for the crawler, nothing extra elsewhere", () => {
    const c = config();
    const u = url("https://a.example/");
    expect(webRequestHeaders("tool", u, c).Accept).toBe(PAGE_ACCEPT);
    expect(webRequestHeaders("url", u, c).Accept).toBe(PAGE_ACCEPT);
    expect(PAGE_ACCEPT.startsWith("text/markdown,")).toBe(true);
    expect(webRequestHeaders("crawler", u, c).Accept).toBe(CRAWLER_ACCEPT);
    expect(webRequestHeaders("search", u, c).Accept).toBeUndefined();
    expect(webRequestHeaders("favicon", u, c).Accept).toBeUndefined();
  });

  it("sends no From, Referer, Cookie, Accept-Language or client hint by default", () => {
    for (const purpose of [
      "tool",
      "url",
      "favicon",
      "search",
      "crawler",
      "panel",
    ] as const) {
      const names = Object.keys(
        webRequestHeaders(purpose, url("https://a.example/"), config()),
      ).map((k) => k.toLowerCase());
      expect(names.filter((n) => n !== "accept")).toEqual(["user-agent"]);
    }
  });

  it("sends Accept-Language only when the person set one, and only for pages", () => {
    const c = config({ acceptLanguage: "en-GB" });
    const u = url("https://a.example/");
    expect(webRequestHeaders("tool", u, c)["Accept-Language"]).toBe("en-GB");
    expect(webRequestHeaders("crawler", u, c)["Accept-Language"]).toBe("en-GB");
    expect(
      webRequestHeaders("search", u, c)["Accept-Language"],
    ).toBeUndefined();
  });

  it("lets a caller's header win, except the User-Agent", () => {
    expect(
      mergeHeaders(
        { Accept: PAGE_ACCEPT, "User-Agent": "Continuous-User/1.2" },
        { accept: "application/json", "user-agent": "node-fetch", "X-K": "1" },
      ),
    ).toEqual({
      "User-Agent": "Continuous-User/1.2",
      accept: "application/json",
      "X-K": "1",
    });
  });
});

describe("robots tokens", () => {
  it("are the product tokens, whatever preset is sent", () => {
    expect(ROBOTS_PRODUCT_TOKEN).toBe("Continuous-User");
    expect(USER_PRODUCT_TOKEN).toBe("Continuous-User");
    expect(CRAWLER_PRODUCT_TOKEN).toBe("Continuous-Crawler");
    expect(robotsProductToken("user")).toBe("Continuous-User");
    expect(robotsProductToken("search")).toBe("Continuous-User");
    expect(robotsProductToken("crawler")).toBe("Continuous-Crawler");
    // RFC 9309 section 2.2.1: letters, underscores and hyphens only
    for (const token of [USER_PRODUCT_TOKEN, CRAWLER_PRODUCT_TOKEN]) {
      expect(token).toMatch(/^[A-Za-z_-]+$/);
    }
  });

  it("appear in the default User-Agent they stand for", () => {
    const c = config();
    const u = url("https://a.example/");
    expect(webUserAgent("tool", u, c)).toContain(robotsProductToken("user"));
    expect(webUserAgent("crawler", u, c)).toContain(
      robotsProductToken("crawler"),
    );
  });
});
