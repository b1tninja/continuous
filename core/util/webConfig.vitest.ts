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

  it("maps the environment variables, without a notice while their readers are unchanged", () => {
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
    expect(deprecations).toEqual([]);
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
