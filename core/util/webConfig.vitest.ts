import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUserFetchLimits } from "./userFetchLimits";
import {
  applyWebConfig,
  getWebConfig,
  readUserWebInputs,
  resetWebConfigForTests,
  resolveWebConfig,
} from "./webConfig";

beforeEach(() => resetWebConfigForTests());
afterEach(() => resetWebConfigForTests());

describe("resolveWebConfig: defaults", () => {
  it("with nothing set, matches what the code does today", () => {
    const { config, notices, deprecations } = resolveWebConfig();
    expect(config).toMatchObject({
      enabled: true,
      policy: undefined,
      userAgent: { preset: "continuous" },
      acceptLanguage: "",
      requireHttps: false,
      robots: "ask",
      spotlight: false,
      limits: {
        maxBytes: 2 * 1024 * 1024,
        timeoutSeconds: 20,
        maxRedirects: 5,
        perHostPerMinute: 10,
        modelChars: 20_000,
      },
      cache: { minutes: 15 },
      hosts: {},
      reputation: { onHit: "ask", providers: [] },
      crawler: { contact: "", concurrencyPerHost: 2, minDelayMs: 1000 },
      search: {},
      sources: {},
    });
    expect(notices).toEqual([]);
    expect(deprecations).toEqual([]);
  });

  it("takes every key from the person's own config", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        enabled: false,
        userAgent: { preset: "chrome-windows" },
        robots: "ignore",
        spotlight: true,
        limits: { maxBytes: 4096 },
        hosts: { "intranet.example": { headers: { "X-Token": "t" } } },
        crawler: { contact: "me@example.com" },
      },
    });
    expect(notices).toEqual([]);
    expect(config.enabled).toBe(false);
    expect(config.userAgent).toEqual({ preset: "chrome-windows" });
    expect(config.robots).toBe("ignore");
    expect(config.limits.maxBytes).toBe(4096);
    expect(config.hosts["intranet.example"].headers).toEqual({
      "X-Token": "t",
    });
    expect(config.crawler.contact).toBe("me@example.com");
    expect(config.sources).toMatchObject({
      enabled: "user-config",
      robots: "user-config",
      "limits.maxBytes": "user-config",
    });
  });

  it("holds a value above a ceiling to the ceiling, with a notice", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        limits: { maxBytes: 10 ** 12, timeoutSeconds: 9999, maxRedirects: 50 },
      },
    });
    expect(config.limits).toMatchObject({
      maxBytes: 64 * 1024 * 1024,
      timeoutSeconds: 300,
      maxRedirects: 10,
    });
    expect(notices).toHaveLength(3);
  });

  it("drops an unknown User-Agent preset and a malformed value, saying so", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        userAgent: { preset: "netscape-4" },
        robots: "sometimes",
        hosts: {
          "a.example": { userAgent: { preset: "nope" }, headers: { A: "1" } },
        },
      },
    });
    expect(config.userAgent).toEqual({ preset: "continuous" });
    expect(config.robots).toBe("ask");
    expect(config.hosts["a.example"]).toEqual({ headers: { A: "1" } });
    expect(notices).toHaveLength(3);
  });

  it("fills a personal secret template from the rendered config", () => {
    const { config } = resolveWebConfig({
      user: {
        hosts: {
          "i.example": { headers: { Authorization: "${{ secrets.T }}" } },
        },
      },
      other: {
        hosts: { "i.example": { headers: { Authorization: "Bearer real" } } },
      },
    });
    expect(config.hosts["i.example"].headers).toEqual({
      Authorization: "Bearer real",
    });
  });

  it("never takes a literal personal value from the rendered config", () => {
    const { config, notices } = resolveWebConfig({
      user: { hosts: { "i.example": { headers: { Authorization: "mine" } } } },
      other: {
        hosts: { "i.example": { headers: { Authorization: "theirs" } } },
      },
    });
    expect(config.hosts["i.example"].headers).toEqual({
      Authorization: "mine",
    });
    expect(notices).toHaveLength(1);
  });
});

describe("resolveWebConfig: another source may only tighten", () => {
  it("ignores every identity and credential key from an assistant or project", () => {
    const { config, notices } = resolveWebConfig({
      other: {
        policy: { level: "allowed" },
        userAgent: { preset: "custom", custom: "Mozilla/5.0 Chrome" },
        acceptLanguage: "fr",
        hosts: { "*.example.com": { headers: { Cookie: "x" } } },
        reputation: {
          providers: [{ type: "rhsbl", zone: "attacker.example" }],
        },
        crawler: { contact: "evil@example.com" },
        search: { url: "https://collector.example" },
      },
    });
    expect(config.policy).toBeUndefined();
    expect(config.userAgent).toEqual({ preset: "continuous" });
    expect(config.acceptLanguage).toBe("");
    expect(config.hosts).toEqual({});
    expect(config.reputation.providers).toEqual([]);
    expect(config.crawler.contact).toBe("");
    expect(config.search).toEqual({});
    expect(notices).toHaveLength(7);
    expect(notices.every((n) => n.includes("own config.yaml"))).toBe(true);
  });

  it("ignores every loosening value", () => {
    const { config, notices } = resolveWebConfig({
      user: { enabled: false, spotlight: true, requireHttps: true },
      other: {
        enabled: true,
        robots: "ignore",
        spotlight: false,
        requireHttps: false,
        limits: {
          maxBytes: 64 * 1024 * 1024,
          timeoutSeconds: 300,
          maxRedirects: 10,
        },
        cache: { minutes: 600 },
        crawler: { concurrencyPerHost: 50, minDelayMs: 0 },
      },
    });
    expect(config).toMatchObject({
      enabled: false,
      robots: "ask",
      spotlight: true,
      requireHttps: true,
      limits: {
        maxBytes: 2 * 1024 * 1024,
        timeoutSeconds: 20,
        maxRedirects: 5,
      },
      cache: { minutes: 15 },
      crawler: { concurrencyPerHost: 2, minDelayMs: 1000 },
    });
    expect(notices).toHaveLength(10);
  });

  it("does not let an assistant undo the person's reputation refusal", () => {
    const { config, notices } = resolveWebConfig({
      user: { reputation: { onHit: "refuse" } },
      other: { reputation: { onHit: "ask" } },
    });
    expect(config.reputation.onHit).toBe("refuse");
    expect(notices).toHaveLength(1);
  });

  it("honours every tightening value and records where it came from", () => {
    const { config, notices } = resolveWebConfig({
      user: { robots: "ignore", limits: { maxBytes: 8 * 1024 * 1024 } },
      other: {
        enabled: false,
        robots: "respect",
        requireHttps: true,
        spotlight: true,
        limits: {
          maxBytes: 1024,
          timeoutSeconds: 5,
          maxRedirects: 0,
          perHostPerMinute: 2,
          modelChars: 100,
        },
        cache: { minutes: 0 },
        reputation: { onHit: "refuse" },
        crawler: { concurrencyPerHost: 1, minDelayMs: 5000 },
      },
    });
    expect(notices).toEqual([]);
    expect(config).toMatchObject({
      enabled: false,
      robots: "respect",
      requireHttps: true,
      spotlight: true,
      limits: {
        maxBytes: 1024,
        timeoutSeconds: 5,
        maxRedirects: 0,
        perHostPerMinute: 2,
        modelChars: 100,
      },
      cache: { minutes: 0 },
      reputation: { onHit: "refuse" },
      crawler: { concurrencyPerHost: 1, minDelayMs: 5000 },
    });
    expect(config.sources.robots).toBe("assistant-config");
    expect(config.sources["limits.maxBytes"]).toBe("assistant-config");
  });

  it("is silent when the loaded config is the person's own file", () => {
    const own = {
      userAgent: { preset: "custom", custom: "Me/1" },
      robots: "ignore",
      spotlight: false,
      limits: { maxBytes: 8 * 1024 * 1024 },
      hosts: { "a.example": { headers: { A: "1" } } },
    };
    const { config, notices } = resolveWebConfig({ user: own, other: own });
    expect(notices).toEqual([]);
    expect(config.robots).toBe("ignore");
    expect(config.limits.maxBytes).toBe(8 * 1024 * 1024);
  });
});

describe("resolveWebConfig: old keys and variables", () => {
  it("reads toolPermissions.auto.environment.fetch* as aliases and deprecates them", () => {
    const { config, deprecations } = resolveWebConfig({
      userLegacy: { fetchMaxBytes: 4096, fetchTimeoutSeconds: 3 },
    });
    expect(config.limits.maxBytes).toBe(4096);
    expect(config.limits.timeoutSeconds).toBe(3);
    expect(config.sources["limits.maxBytes"]).toBe("legacy-key");
    expect(deprecations.map((d) => [d.key, d.replacement])).toEqual([
      ["toolPermissions.auto.environment.fetchMaxBytes", "web.limits.maxBytes"],
      [
        "toolPermissions.auto.environment.fetchTimeoutSeconds",
        "web.limits.timeoutSeconds",
      ],
    ]);
  });

  it("lets the web: key win over the old one, and says the old one is unused", () => {
    const { config, deprecations } = resolveWebConfig({
      user: { limits: { maxBytes: 1000 } },
      userLegacy: { fetchMaxBytes: 4096 },
    });
    expect(config.limits.maxBytes).toBe(1000);
    expect(deprecations).toHaveLength(1);
    expect(deprecations[0].message).toContain("was not used");
  });

  it("ignores malformed old values, as before", () => {
    const { config } = resolveWebConfig({
      userLegacy: { fetchMaxBytes: "4096", fetchTimeoutSeconds: 0 },
    });
    expect(config.limits.maxBytes).toBe(2 * 1024 * 1024);
    expect(config.limits.timeoutSeconds).toBe(20);
  });

  it("maps the environment variables, announcing only the search ones, whose reader now takes web.search", () => {
    const { config, deprecations } = resolveWebConfig({
      env: {
        CONTINUOUS_SPOTLIGHT_UNTRUSTED: "1",
        CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH: "5000",
        CONTINUOUS_WEB_SEARCH_URL: "http://127.0.0.1:8888",
        CONTINUOUS_WEB_SEARCH_KEY: "k",
      },
    });
    expect(config.spotlight).toBe(true);
    expect(config.limits.modelChars).toBe(5000);
    expect(config.search).toEqual({
      url: "http://127.0.0.1:8888",
      apiKey: "k",
    });
    expect(config.sources).toMatchObject({
      spotlight: "env",
      "limits.modelChars": "env",
      search: "env",
    });
    expect(deprecations.map((d) => [d.key, d.replacement])).toEqual([
      ["CONTINUOUS_WEB_SEARCH_URL", "web.search.url"],
      ["CONTINUOUS_WEB_SEARCH_KEY", "web.search.apiKey"],
    ]);
    expect(deprecations[0].message).toMatch(/still works for now/);
  });

  it("prefers the web: key over a variable", () => {
    const { config } = resolveWebConfig({
      user: {
        spotlight: false,
        limits: { modelChars: 100 },
        search: { url: "http://a" },
      },
      env: {
        CONTINUOUS_SPOTLIGHT_UNTRUSTED: "1",
        CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH: "5000",
        CONTINUOUS_WEB_SEARCH_URL: "http://b",
      },
    });
    expect(config.spotlight).toBe(false);
    expect(config.limits.modelChars).toBe(100);
    expect(config.search).toEqual({ url: "http://a" });
  });

  it("ignores a variable that is not a whole number", () => {
    const { config } = resolveWebConfig({
      env: {
        CONTINUE_CLI_FETCH_MAX_OUTPUT_LENGTH: "lots",
        CONTINUOUS_SPOTLIGHT_UNTRUSTED: "yes",
      },
    });
    expect(config.limits.modelChars).toBe(20_000);
    expect(config.spotlight).toBe(false);
  });
});

describe("the accessor and the person's file", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-config-"));
    file = path.join(dir, "config.yaml");
    resetWebConfigForTests(file);
  });
  afterEach(() => {
    resetWebConfigForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the deprecation notice once per process, and the trust notices every load", () => {
    fs.writeFileSync(
      file,
      "toolPermissions:\n  auto:\n    environment:\n      fetchMaxBytes: 4096\n",
    );
    const first = applyWebConfig({ robots: "ignore" }, {});
    expect(first.deprecations).toHaveLength(1);
    expect(first.deprecations[0]).toContain("fetchMaxBytes");
    expect(first.notices).toHaveLength(1);
    const second = applyWebConfig({ robots: "ignore" }, {});
    expect(second.deprecations).toEqual([]);
    expect(second.notices).toHaveLength(1);
    expect(getWebConfig({}).limits.maxBytes).toBe(4096);
  });

  it("re-reads the file when it changes, and keeps what the loaded config tightened", () => {
    fs.writeFileSync(file, "web:\n  limits:\n    timeoutSeconds: 30\n");
    applyWebConfig({ requireHttps: true }, {});
    expect(getWebConfig({}).limits.timeoutSeconds).toBe(30);
    fs.writeFileSync(
      file,
      "web:\n  limits:\n    timeoutSeconds: 45\n    maxBytes: 1\n",
    );
    expect(getWebConfig({}).limits.timeoutSeconds).toBe(45);
    expect(getWebConfig({}).requireHttps).toBe(true);
  });

  it("reads web: and the old keys straight from the file, and nothing from a broken one", () => {
    fs.writeFileSync(file, "web:\n  robots: respect\n");
    expect(readUserWebInputs(file).user).toEqual({ robots: "respect" });
    fs.writeFileSync(file, "web: [unclosed\n");
    expect(readUserWebInputs(file)).toEqual({
      user: undefined,
      userLegacy: undefined,
    });
    expect(getWebConfig({}).robots).toBe("ask");
  });

  it("feeds readUserFetchLimits, so web.limits works for @url and the fetch tool", () => {
    fs.writeFileSync(
      file,
      "web:\n  limits:\n    maxBytes: 2048\n    timeoutSeconds: 4\n",
    );
    expect(readUserFetchLimits()).toEqual({ maxBytes: 2048, deadlineMs: 4000 });
    expect(readUserFetchLimits(file)).toEqual({
      maxBytes: 2048,
      deadlineMs: 4000,
    });
    applyWebConfig({ limits: { maxBytes: 1024 } }, {});
    expect(readUserFetchLimits().maxBytes).toBe(1024);
  });
});

describe("resolveWebConfig: web.search (WB53)", () => {
  it("keeps every personal key, and maps no variable over a provider of the person's own", () => {
    const search = {
      provider: "native",
      fallback: "searxng",
      fallbackUrl: "http://127.0.0.1:8888",
      maxResults: 7,
      maxPerTurn: 3,
      monthlyLimit: 100,
      country: "DE",
      safeSearch: "strict",
      native: { dynamicFiltering: false, google: "standard" },
      custom: { method: "POST" },
      mcp: { server: "brave", tool: "brave_web_search" },
    };
    const { config, notices, deprecations } = resolveWebConfig({
      user: { search },
      env: { CONTINUOUS_WEB_SEARCH_URL: "http://elsewhere" },
    });
    expect(config.search).toEqual(search);
    expect(notices).toEqual([]);
    expect(deprecations[0].message).toMatch(/was not used/);
  });

  it("lets another config set provider: off and lower limits, and nothing else", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        search: {
          url: "http://127.0.0.1:8888",
          maxResults: 8,
          monthlyLimit: 0,
          safeSearch: "moderate",
        },
      },
      other: {
        search: {
          provider: "off",
          maxResults: 2,
          maxPerTurn: 1,
          monthlyLimit: 50,
          safeSearch: "strict",
        },
      },
    });
    expect(notices).toEqual([]);
    expect(config.search).toEqual({
      provider: "off",
      url: "http://127.0.0.1:8888",
      maxResults: 2,
      maxPerTurn: 1,
      monthlyLimit: 50,
      safeSearch: "strict",
    });
    expect(config.sources).toMatchObject({
      "search.provider": "assistant-config",
      "search.maxResults": "assistant-config",
      "search.monthlyLimit": "assistant-config",
    });
  });

  it("ignores a looser limit, another provider, an endpoint or a key from another config", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        search: {
          url: "http://127.0.0.1:8888",
          maxResults: 3,
          monthlyLimit: 10,
        },
      },
      other: {
        search: {
          provider: "custom",
          url: "https://collector.example",
          apiKey: "theirs",
          fallback: "custom",
          maxResults: 9,
          maxPerTurn: 50,
          monthlyLimit: 0,
          safeSearch: "off",
        },
      },
    });
    expect(config.search).toEqual({
      url: "http://127.0.0.1:8888",
      maxResults: 3,
      monthlyLimit: 10,
    });
    const keys = notices.map((n) => n.split(/[: ]/)[0]).sort();
    expect(keys).toEqual([
      "web.search.apiKey",
      "web.search.fallback",
      "web.search.maxPerTurn",
      "web.search.maxResults",
      "web.search.monthlyLimit",
      "web.search.provider",
      "web.search.url",
    ]);
  });

  it("says nothing when the loaded config repeats the person's own search block", () => {
    const search = { provider: "searxng", url: "http://127.0.0.1:8888" };
    const { notices } = resolveWebConfig({
      user: { search },
      other: { search },
    });
    expect(notices).toEqual([]);
  });

  it("warns about a key typed into web.search.apiKey, and not about a secret reference (SP-8)", () => {
    const typed = resolveWebConfig({
      user: { search: { provider: "brave", apiKey: "BSAx-literal-key" } },
    });
    expect(typed.config.search.apiKey).toBe("BSAx-literal-key");
    expect(typed.deprecations).toHaveLength(1);
    expect(typed.deprecations[0].key).toBe("web.search.apiKey");
    expect(typed.deprecations[0].message).toContain(
      "${{ secrets.BRAVE_SEARCH_KEY }}",
    );
    expect(typed.deprecations[0].message).toMatch(/later release will refuse/);
    expect(typed.deprecations[0].message).not.toContain("BSAx");

    for (const apiKey of [
      "${{ secrets.BRAVE_SEARCH_KEY }}",
      "${{ env.MY_KEY }}",
    ]) {
      expect(
        resolveWebConfig({ user: { search: { provider: "brave", apiKey } } })
          .deprecations,
      ).toEqual([]);
    }
    expect(
      resolveWebConfig({
        user: { search: { fallback: "searxng", fallbackApiKey: "typed" } },
      }).deprecations[0].message,
    ).toContain("${{ secrets.SEARXNG_SEARCH_KEY }}");
  });

  it("fills a secret reference with the loaded config's rendered value", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        search: { url: "http://a", apiKey: "${{ secrets.WEB_SEARCH_KEY }}" },
      },
      other: { search: { url: "http://a", apiKey: "rendered" } },
    });
    expect(config.search.apiKey).toBe("rendered");
    expect(notices).toEqual([]);
  });

  it("reports an unknown provider (SR-6)", () => {
    const { notices } = resolveWebConfig({
      user: { search: { provider: "bing", url: "http://a" } },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/"bing" is not a known search provider/);
  });

  it("drops a malformed search value and keeps the rest", () => {
    const { config, notices } = resolveWebConfig({
      user: {
        search: { url: "http://a", maxResults: 50, safeSearch: "maybe" },
      },
    });
    expect(config.search).toEqual({ url: "http://a" });
    expect(notices.sort()).toEqual([
      "web.search.maxResults in your config.yaml is not a valid value and was ignored.",
      "web.search.safeSearch in your config.yaml is not a valid value and was ignored.",
    ]);
  });
});
