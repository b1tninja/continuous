import * as z from "zod";

/**
 * The `web:` section of config.yaml: how the agent fetches web pages for the
 * person (the fetch tool, `@url`, the docs crawler, the favicon lookup, the
 * search backend and, later, the Browser panel). Design and decisions:
 * plans/research/web-fetch-deep-dive.md, section 8.1.
 *
 * Who may set what is not expressed here, because a schema cannot know which
 * file a value came from. Core reads the person's own config.yaml for the
 * keys marked "personal", and lets any other source (an assistant, the hub, a
 * project folder) only tighten (core/util/webConfig.ts):
 *
 * - personal only: `userAgent`, `acceptLanguage`, `hosts`,
 *   `reputation.providers`, `crawler.contact`, `search`, and the loosening
 *   values `robots: ignore` and `spotlight: false`;
 * - tighten only from elsewhere: `requireHttps: true`, a stricter `robots`,
 *   `spotlight: true`, lower `limits.*` and `cache.minutes`,
 *   `reputation.onHit: refuse`, lower `crawler.concurrencyPerHost` and higher
 *   `crawler.minDelayMs`.
 *
 * Domain allow and deny rules are not here: they are `host:` and `net:` rules
 * in permissions.yaml, so there is one place for permissions. The transport
 * (proxy, CA bundle, client certificate, timeouts for the connection) stays in
 * `requestOptions`, which every web path already reuses.
 */

/** `robots.txt` for the model's fetch tool: `ask` (default) asks on a disallow, `respect` refuses, `ignore` skips the check. */
export const webRobotsModeSchema = z.enum(["ask", "respect", "ignore"]);
export type WebRobotsMode = z.infer<typeof webRobotsModeSchema>;

/** What a reputation hit does: `ask` (default) or `refuse`. */
export const webReputationOnHitSchema = z.enum(["ask", "refuse"]);
export type WebReputationOnHit = z.infer<typeof webReputationOnHitSchema>;

const wholeNumber = z.number().int().min(1);

export const webLimitsSchema = z.object({
  /** Largest body, after decompression, in bytes (default 2 MiB, ceiling 64 MiB). */
  maxBytes: wholeNumber.optional(),
  /** Seconds a fetch may take in all, body included (default 20, ceiling 300). */
  timeoutSeconds: wholeNumber.optional(),
  /** Redirects followed (default 5, ceiling 10). */
  maxRedirects: z.number().int().min(0).optional(),
  /** Requests to one host per minute from the tool and `@url` (default 10). */
  perHostPerMinute: wholeNumber.optional(),
  /** Characters of a page returned to the model per call (default 20,000). */
  modelChars: wholeNumber.optional(),
});
export type WebLimits = z.infer<typeof webLimitsSchema>;

export const webCacheSchema = z.object({
  /** Minutes a fetched page is kept in the session cache (default 15); 0 turns the cache off. */
  minutes: z.number().int().min(0).optional(),
});

/**
 * Which User-Agent to send. `continuous` (default) is the product token
 * (`Continuous-User/<major.minor> (+<info URL>)`, `Continuous-Crawler/...`
 * for the docs crawler); `generic-agent` names no product; `custom` sends
 * `custom` as written (`""` sends none); any other value is the `id` of a
 * browser preset in core/web/userAgentPresets.json. The browser presets live
 * only in that data file, never in this schema, so a new browser version is a
 * data change; core checks the id.
 */
export const webUserAgentSchema = z.object({
  preset: z.string().min(1),
  custom: z.string().optional(),
});
export type WebUserAgent = z.infer<typeof webUserAgentSchema>;

/** The presets that are not browsers; every other preset id is a browser preset. */
export const WEB_USER_AGENT_BUILTIN_PRESETS = [
  "continuous",
  "generic-agent",
  "custom",
] as const;

/** One per-host override. The pattern is the key, in `host:` rule syntax. */
export const webHostOverrideSchema = z.object({
  /** Sent only to hosts matching the pattern, and dropped on a redirect to another host. */
  headers: z.record(z.string(), z.string()).optional(),
  /** The User-Agent sent to these hosts. */
  userAgent: webUserAgentSchema.optional(),
});
export type WebHostOverride = z.infer<typeof webHostOverrideSchema>;

export const webReputationProviderSchema = z.discriminatedUnion("type", [
  z.object({
    /** A hostfile or a plain list of hosts or URLs, refreshed on the person's schedule. */
    type: z.literal("feed"),
    url: z.string().min(1),
    refreshHours: z.number().positive().optional(),
  }),
  z.object({
    /** Google Safe Browsing v5 hash-prefix lookups, with the person's own key. */
    type: z.literal("safeBrowsing"),
    apiKey: z.string().min(1),
  }),
  z.object({
    /** A domain list (RHSBL) zone; each lookup sends the domain to that zone's servers. */
    type: z.literal("rhsbl"),
    zone: z.string().min(1),
  }),
]);
export type WebReputationProvider = z.infer<typeof webReputationProviderSchema>;

export const webReputationSchema = z.object({
  onHit: webReputationOnHitSchema.optional(),
  /** Nothing is looked up until a provider is listed here. */
  providers: z.array(webReputationProviderSchema).optional(),
});

export const webCrawlerSchema = z.object({
  /** Sent as `From:` by the docs crawler, and only when set. */
  contact: z.string().optional(),
  /** Requests in flight to one host (default 2). */
  concurrencyPerHost: wholeNumber.optional(),
  /** Milliseconds between two requests to one host (default 1000), or `Crawl-delay` if larger. */
  minDelayMs: z.number().int().min(0).optional(),
});

/**
 * The search provider ids (plans/research/web-search-providers.md, section 6).
 * `off` turns search off; `native` is the selected model's own search. Which
 * of the others a build can call is core's business (core/tools/webSearch):
 * a known id without an adapter yet is treated as off. `provider` itself stays
 * a plain string in the schema, so an unknown id is read as off with a notice
 * (SR-6) instead of being dropped, which would turn a `url` into SearXNG.
 */
export const WEB_SEARCH_PROVIDER_IDS = [
  "off",
  "native",
  "searxng",
  "brave",
  "mojeek",
  "kagi",
  "tavily",
  "exa",
  "custom",
  "mcp",
] as const;
export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** `safeSearch` levels from loosest to strictest. */
export const WEB_SEARCH_SAFE_SEARCH = ["off", "moderate", "strict"] as const;
export const webSearchSafeSearchSchema = z.enum(WEB_SEARCH_SAFE_SEARCH);
export type WebSearchSafeSearch = z.infer<typeof webSearchSafeSearchSchema>;

/** Most results a single search may return. */
export const WEB_SEARCH_MAX_RESULTS_CEILING = 10;

export const webSearchSchema = z.object({
  /**
   * `off | native | searxng | brave | mojeek | kagi | tavily | exa | custom | mcp`.
   * Unset with a `url`: `searxng`. Unset with no `url`: off. Personal config
   * only, except `off`, which any config may set.
   */
  provider: z.string().optional(),
  /** The endpoint for `searxng` and `custom`; for the others, an optional base URL override. Replaces CONTINUOUS_WEB_SEARCH_URL. */
  url: z.string().optional(),
  /**
   * Sent to the provider as its key (a bearer token for `searxng` and
   * `custom`). Write it as `${{ secrets.NAME }}`; a key typed in is read for
   * now with a warning. Replaces CONTINUOUS_WEB_SEARCH_KEY.
   */
  apiKey: z.string().optional(),
  /** With `provider: native`: the provider for a model that has no search of its own. Default none. */
  fallback: z.string().optional(),
  /** The fallback's `url`, when it needs one. */
  fallbackUrl: z.string().optional(),
  /** The fallback's `apiKey`, when it needs one; a `${{ secrets.NAME }}` reference. */
  fallbackApiKey: z.string().optional(),
  /** Results per search, 1 to 10. Any config may lower it. */
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(WEB_SEARCH_MAX_RESULTS_CEILING)
    .optional(),
  /** Searches per agent turn. Any config may lower it. */
  maxPerTurn: wholeNumber.optional(),
  /** Searches per month, counted locally; 0 is no limit. Any config may lower it. */
  monthlyLimit: z.number().int().min(0).optional(),
  /** ISO 3166-1 alpha-2 country code, sent only when set and only to providers that take one. */
  country: z
    .string()
    .regex(/^([A-Za-z]{2})?$/)
    .optional(),
  /** Where the provider has it. Any config may make it stricter. */
  safeSearch: webSearchSafeSearchSchema.optional(),
  native: z
    .object({
      /** Anthropic: `true` uses code-execution filtering, which is not ZDR-eligible. */
      dynamicFiltering: z.boolean().optional(),
      /** Gemini: `standard` (Grounding with Google Search) or `enterprise` (Web Grounding for Enterprise, Vertex only). */
      google: z.enum(["standard", "enterprise"]).optional(),
      /** OpenRouter's search engine; `native` keeps the query with the model's provider. */
      openrouterEngine: z
        .enum(["native", "exa", "parallel", "perplexity", "firecrawl"])
        .optional(),
    })
    .optional(),
  custom: z
    .object({
      /** `GET` (`?q=…&format=json`, the SearXNG shape) or `POST` (a `{"q": …}` body). */
      method: z.enum(["GET", "POST"]).optional(),
    })
    .optional(),
  mcp: z
    .object({
      /** A configured MCP server's name. */
      server: z.string().min(1).optional(),
      /** The tool of that server to call. */
      tool: z.string().min(1).optional(),
    })
    .optional(),
});
export type WebSearchConfig = z.infer<typeof webSearchSchema>;

export const webConfigSchema = z.object({
  /** `false` turns off every web fetch the agent makes (default `true`). Any config may turn it off; only your own may turn it back on. */
  enabled: z.boolean().optional(),
  /**
   * TODO(web policy area, follow-up): the web policy levels (for example off,
   * ask, allowed domains) that fit the permission levels are being designed
   * separately. The key is reserved and its type left open until then;
   * nothing reads it.
   */
  policy: z.unknown().optional(),
  /** The User-Agent preset. Personal config only. */
  userAgent: webUserAgentSchema.optional(),
  /** An `Accept-Language` value; none is sent by default. Personal config only. */
  acceptLanguage: z.string().optional(),
  /** `true` refuses plain `http:` URLs. */
  requireHttps: z.boolean().optional(),
  robots: webRobotsModeSchema.optional(),
  /** Mark fetched text as untrusted for the model. Replaces `experimental.spotlightUntrusted`. */
  spotlight: z.boolean().optional(),
  limits: webLimitsSchema.optional(),
  cache: webCacheSchema.optional(),
  /** Per-host User-Agent and headers. Personal config only. */
  hosts: z.record(z.string(), webHostOverrideSchema).optional(),
  reputation: webReputationSchema.optional(),
  crawler: webCrawlerSchema.optional(),
  search: webSearchSchema.optional(),
});
export type WebConfig = z.infer<typeof webConfigSchema>;

/**
 * The value each setting has when nobody sets it. Where a setting already has
 * a behaviour in the code, the default is that behaviour (the byte cap, the
 * deadline, five redirects, 20,000 characters, spotlight off); where it is
 * new, the default is the one the design decided.
 */
export const WEB_DEFAULTS = {
  enabled: true,
  userAgent: { preset: "continuous" },
  acceptLanguage: "",
  requireHttps: false,
  robots: "ask",
  // Decided on (WB7), but the fetch tool still reads its own switch; this
  // follows today's behaviour until the tool reads `web.spotlight`.
  spotlight: false,
  limits: {
    maxBytes: 2 * 1024 * 1024,
    timeoutSeconds: 20,
    maxRedirects: 5,
    perHostPerMinute: 10,
    modelChars: 20_000,
  },
  cache: { minutes: 15 },
  reputation: { onHit: "ask" },
  crawler: { concurrencyPerHost: 2, minDelayMs: 1000 },
} as const;

/** The most any source may set: a larger value is held to this. */
export const WEB_CEILINGS = {
  maxBytes: 64 * 1024 * 1024,
  timeoutSeconds: 300,
  maxRedirects: 10,
} as const;

/** `robots` modes from strictest to loosest. */
export const WEB_ROBOTS_STRICTNESS: readonly WebRobotsMode[] = [
  "respect",
  "ask",
  "ignore",
];

function min(a?: number, b?: number): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

function max(a?: number, b?: number): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function stricterRobots(
  a?: WebRobotsMode,
  b?: WebRobotsMode,
): WebRobotsMode | undefined {
  if (!a || !b) return a ?? b;
  return WEB_ROBOTS_STRICTNESS.indexOf(a) <= WEB_ROBOTS_STRICTNESS.indexOf(b)
    ? a
    : b;
}

function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out = Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Merge two `web:` sections when blocks are combined into one config. The
 * safety settings take the tighter side whichever comes first; the personal
 * settings keep the first side's value. This is only the shape of the merged
 * config: which file may set what is decided in core, against the person's
 * own config.yaml.
 */
export function mergeWebConfig(
  current: WebConfig | undefined,
  incoming: WebConfig | undefined,
): WebConfig | undefined {
  if (!current || !incoming) return current ?? incoming;
  const a = current;
  const b = incoming;
  const both = (x?: boolean, y?: boolean) =>
    x === undefined && y === undefined ? undefined : x === true || y === true;
  return compact({
    enabled: both(
      a.enabled === undefined ? undefined : !a.enabled,
      b.enabled === undefined ? undefined : !b.enabled,
    )
      ? false
      : (a.enabled ?? b.enabled),
    policy: a.policy ?? b.policy,
    userAgent: a.userAgent ?? b.userAgent,
    acceptLanguage: a.acceptLanguage ?? b.acceptLanguage,
    requireHttps: both(a.requireHttps, b.requireHttps),
    robots: stricterRobots(a.robots, b.robots),
    spotlight: both(a.spotlight, b.spotlight),
    limits: compact({
      maxBytes: min(a.limits?.maxBytes, b.limits?.maxBytes),
      timeoutSeconds: min(a.limits?.timeoutSeconds, b.limits?.timeoutSeconds),
      maxRedirects: min(a.limits?.maxRedirects, b.limits?.maxRedirects),
      perHostPerMinute: min(
        a.limits?.perHostPerMinute,
        b.limits?.perHostPerMinute,
      ),
      modelChars: min(a.limits?.modelChars, b.limits?.modelChars),
    }),
    cache: compact({ minutes: min(a.cache?.minutes, b.cache?.minutes) }),
    hosts: a.hosts || b.hosts ? { ...b.hosts, ...a.hosts } : undefined,
    reputation: compact({
      onHit:
        a.reputation?.onHit === "refuse" || b.reputation?.onHit === "refuse"
          ? "refuse"
          : (a.reputation?.onHit ?? b.reputation?.onHit),
      providers: a.reputation?.providers ?? b.reputation?.providers,
    }),
    crawler: compact({
      contact: a.crawler?.contact ?? b.crawler?.contact,
      concurrencyPerHost: min(
        a.crawler?.concurrencyPerHost,
        b.crawler?.concurrencyPerHost,
      ),
      minDelayMs: max(a.crawler?.minDelayMs, b.crawler?.minDelayMs),
    }),
    search: mergeWebSearch(a.search, b.search),
  } as WebConfig);
}

/** `0` is no monthly limit, so it is the loosest value, not the lowest. */
function lowerMonthlyLimit(a?: number, b?: number): number | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  if (a === 0) return b;
  if (b === 0) return a;
  return Math.min(a, b);
}

function stricterSafeSearch(
  a?: WebSearchSafeSearch,
  b?: WebSearchSafeSearch,
): WebSearchSafeSearch | undefined {
  if (!a || !b) return a ?? b;
  return WEB_SEARCH_SAFE_SEARCH.indexOf(a) >= WEB_SEARCH_SAFE_SEARCH.indexOf(b)
    ? a
    : b;
}

/**
 * `web.search` of two blocks: `provider: off` on either side wins, the
 * limits take the lower side and `safeSearch` the stricter; the rest (which
 * provider, its URL and key) keeps the first side's value.
 */
export function mergeWebSearch(
  a: WebSearchConfig | undefined,
  b: WebSearchConfig | undefined,
): WebSearchConfig | undefined {
  if (!a || !b) return a ?? b;
  return compact({
    ...b,
    ...a,
    provider:
      a.provider === "off" || b.provider === "off"
        ? "off"
        : (a.provider ?? b.provider),
    maxResults: min(a.maxResults, b.maxResults),
    maxPerTurn: min(a.maxPerTurn, b.maxPerTurn),
    monthlyLimit: lowerMonthlyLimit(a.monthlyLimit, b.monthlyLimit),
    safeSearch: stricterSafeSearch(a.safeSearch, b.safeSearch),
  } as WebSearchConfig);
}

/**
 * True when a key is written as a reference (`${{ secrets.NAME }}` or
 * `${{ env.NAME }}`) rather than typed in (SP-8, SR-3).
 */
export function isSecretReference(value: string): boolean {
  return /^\s*\$\{\{\s*(secrets|env)\.[A-Za-z0-9_.-]+\s*\}\}\s*$/.test(value);
}

export interface SanitizedWebConfig {
  /** The well-formed part, or undefined when nothing was usable. */
  value: WebConfig | undefined;
  /** Dot paths of the values that were dropped because they were malformed. */
  dropped: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function innerObject(schema: z.ZodType): z.ZodObject | undefined {
  const unwrapped =
    schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
  return unwrapped instanceof z.ZodObject ? unwrapped : undefined;
}

function pickValid(
  schema: z.ZodObject,
  raw: Record<string, unknown>,
  prefix: string,
  dropped: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (!(key in raw) || raw[key] === undefined || raw[key] === null) continue;
    const parsed = (field as z.ZodType).safeParse(raw[key]);
    if (parsed.success) {
      out[key] = parsed.data;
      continue;
    }
    const inner = innerObject(field as z.ZodType);
    if (inner && isRecord(raw[key])) {
      const sub = pickValid(inner, raw[key], `${prefix}${key}.`, dropped);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else {
      dropped.push(`${prefix}${key}`);
    }
  }
  return out;
}

/**
 * A `web:` value read straight from a file (not through the config loader),
 * keeping what is well formed and naming what is not, so that one bad value
 * does not throw away the person's other web settings.
 */
export function sanitizeWebConfig(raw: unknown): SanitizedWebConfig {
  if (raw === undefined || raw === null)
    return { value: undefined, dropped: [] };
  if (!isRecord(raw)) return { value: undefined, dropped: ["web"] };
  const dropped: string[] = [];
  const value = pickValid(webConfigSchema, raw, "web.", dropped) as WebConfig;
  return {
    value: Object.keys(value).length > 0 ? value : undefined,
    dropped,
  };
}
