import { mergePackages, mergeUnrolledAssistants } from "./load/merge.js";
import { configYamlSchema } from "./schemas/index.js";
import {
  mergeWebConfig,
  sanitizeWebConfig,
  WEB_CEILINGS,
  WEB_DEFAULTS,
  webConfigSchema,
} from "./schemas/web.js";

const base = { name: "c", version: "1" };

describe("web: schema", () => {
  it("accepts the whole proposed section", () => {
    const web = {
      enabled: true,
      policy: { anything: ["goes", "here"] },
      userAgent: { preset: "custom", custom: "Me/1.0" },
      acceptLanguage: "en",
      requireHttps: true,
      robots: "respect",
      spotlight: true,
      limits: {
        maxBytes: 1024,
        timeoutSeconds: 5,
        maxRedirects: 0,
        perHostPerMinute: 3,
        modelChars: 500,
      },
      cache: { minutes: 0 },
      hosts: {
        "*.intranet.example": {
          headers: { Authorization: "${{ secrets.TOKEN }}" },
          userAgent: { preset: "firefox-linux" },
        },
      },
      reputation: {
        onHit: "refuse",
        providers: [
          {
            type: "feed",
            url: "https://example.com/feed.txt",
            refreshHours: 12,
          },
          { type: "safeBrowsing", apiKey: "k" },
          { type: "rhsbl", zone: "dbl.example.internal" },
        ],
      },
      crawler: {
        contact: "me@example.com",
        concurrencyPerHost: 1,
        minDelayMs: 2000,
      },
      search: { provider: "searxng", url: "http://127.0.0.1:8888" },
    };
    expect(webConfigSchema.parse(web)).toEqual(web);
    expect(configYamlSchema.parse({ ...base, web }).web).toEqual(web);
  });

  it("is optional, and every key in it is optional", () => {
    expect(configYamlSchema.parse(base).web).toBeUndefined();
    expect(webConfigSchema.parse({})).toEqual({});
  });

  it.each([
    [{ robots: "sometimes" }],
    [{ limits: { maxBytes: 0 } }],
    [{ limits: { timeoutSeconds: 1.5 } }],
    [{ cache: { minutes: -1 } }],
    [{ userAgent: "Me/1.0" }],
    [{ userAgent: { preset: "" } }],
    [{ reputation: { providers: [{ type: "dnsbl", zone: "x" }] } }],
    [{ reputation: { onHit: "warn" } }],
    [{ enabled: "no" }],
  ])("rejects %j", (web) => {
    expect(webConfigSchema.safeParse(web).success).toBe(false);
  });

  it("keeps browser presets out of the schema: any non-empty preset id parses", () => {
    expect(
      webConfigSchema.parse({ userAgent: { preset: "chrome-windows" } }),
    ).toEqual({ userAgent: { preset: "chrome-windows" } });
  });

  it("defaults follow today's behaviour where the code already has one", () => {
    expect(WEB_DEFAULTS.limits).toEqual({
      maxBytes: 2 * 1024 * 1024,
      timeoutSeconds: 20,
      maxRedirects: 5,
      perHostPerMinute: 10,
      modelChars: 20_000,
    });
    expect(WEB_DEFAULTS.enabled).toBe(true);
    expect(WEB_DEFAULTS.robots).toBe("ask");
    expect(WEB_DEFAULTS.spotlight).toBe(false);
    expect(WEB_DEFAULTS.userAgent).toEqual({ preset: "continuous" });
    expect(WEB_CEILINGS).toEqual({
      maxBytes: 64 * 1024 * 1024,
      timeoutSeconds: 300,
      maxRedirects: 10,
    });
  });
});

describe("sanitizeWebConfig", () => {
  it("keeps the good values and names the bad ones", () => {
    const r = sanitizeWebConfig({
      robots: "never",
      requireHttps: true,
      limits: { maxBytes: -5, timeoutSeconds: 7 },
    });
    expect(r.value).toEqual({
      requireHttps: true,
      limits: { timeoutSeconds: 7 },
    });
    expect(r.dropped.sort()).toEqual(["web.limits.maxBytes", "web.robots"]);
  });

  it("treats a missing section as nothing and a scalar as malformed", () => {
    expect(sanitizeWebConfig(undefined)).toEqual({
      value: undefined,
      dropped: [],
    });
    expect(sanitizeWebConfig("on")).toEqual({
      value: undefined,
      dropped: ["web"],
    });
  });
});

describe("mergeWebConfig", () => {
  it("takes the tighter side of every safety setting, whichever comes first", () => {
    const a = {
      robots: "ignore" as const,
      requireHttps: false,
      limits: { maxBytes: 10, timeoutSeconds: 50 },
      crawler: { minDelayMs: 100, concurrencyPerHost: 4 },
      reputation: { onHit: "ask" as const },
    };
    const b = {
      robots: "respect" as const,
      requireHttps: true,
      enabled: false,
      limits: { maxBytes: 20, timeoutSeconds: 5 },
      crawler: { minDelayMs: 3000, concurrencyPerHost: 1 },
      reputation: { onHit: "refuse" as const },
    };
    for (const merged of [mergeWebConfig(a, b), mergeWebConfig(b, a)]) {
      expect(merged).toMatchObject({
        enabled: false,
        robots: "respect",
        requireHttps: true,
        limits: { maxBytes: 10, timeoutSeconds: 5 },
        crawler: { minDelayMs: 3000, concurrencyPerHost: 1 },
        reputation: { onHit: "refuse" },
      });
    }
  });

  it("keeps the first side's personal values", () => {
    expect(
      mergeWebConfig(
        { userAgent: { preset: "continuous" } },
        { userAgent: { preset: "custom", custom: "x" } },
      )?.userAgent,
    ).toEqual({ preset: "continuous" });
  });

  it("is carried through package and assistant merges", () => {
    const merged = mergePackages(
      { ...base, web: { limits: { maxBytes: 100 } } },
      { ...base, web: { limits: { maxBytes: 50 }, robots: "respect" } },
    );
    expect(merged.web).toEqual({ robots: "respect", limits: { maxBytes: 50 } });
    expect(
      mergeUnrolledAssistants(
        { ...base },
        { ...base, web: { spotlight: true } },
      ).web,
    ).toEqual({ spotlight: true });
  });
});
