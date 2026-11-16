import type { FetchFunction, IDE } from "../..";

/**
 * The web search provider layer (plans/research/web-search-providers.md,
 * row WB53). Every client-side search backend, the `search_web` tool and
 * `@web` go through one interface, so a provider is one adapter file and the
 * tool and context provider never know which one answered.
 *
 * An adapter only builds the request and reads the reply. The request itself
 * goes through `searchRequest` (below), which sends it through
 * `guardedWebRequest` (#908) with the person's byte cap and deadline and the
 * search User-Agent (UA-3), and never quotes a response body in an error.
 *
 * The result shape here is deliberately thin: normalisation (canonical URLs,
 * caps, dedupe, cleaning), the provenance line and the typed outcomes are
 * WB54.
 */

export type WebSearchFreshness = "day" | "week" | "month" | "year";

export const WEB_SEARCH_FRESHNESS: readonly WebSearchFreshness[] = [
  "day",
  "week",
  "month",
  "year",
];

export interface WebSearchQuery {
  /** The search text, as the model or the person wrote it. */
  query: string;
  /** Only results from this period, where the provider can filter by date. */
  freshness?: WebSearchFreshness;
  /** Only results from this host, for example `docs.python.org`. */
  site?: string;
  /** Results wanted; the adapter returns at most this many. */
  maxResults: number;
}

export interface WebSearchHit {
  title: string;
  url: string;
  /** The provider's short text for the hit, as given (not yet capped or cleaned). */
  snippet: string;
  /** The published or page date, when the provider gives one. */
  published?: string;
}

/**
 * How a filter was carried out: `filter` by the provider's own parameter,
 * `query` written into the query text (`site:`), `ignored` when the provider
 * has no way to apply it (the provenance line of WB54 says so).
 */
export type WebSearchFilterUse = "filter" | "query" | "ignored";

export interface WebSearchResponse {
  /** The provider id, for example `searxng`. */
  provider: string;
  /** The host that answered. */
  host: string;
  hits: WebSearchHit[];
  filters: { freshness?: WebSearchFilterUse; site?: WebSearchFilterUse };
}

/** What a search needs from its caller; the provider holds its own settings. */
export interface WebSearchContext {
  /**
   * A fetch that adds no global request headers (`modelToolFetch(config)`):
   * only the provider's own key is sent, and only to the provider.
   */
  fetchFn: FetchFunction;
  /** The tool call that made the request, for the fetch record. */
  callId?: string;
  /** Body cap and total deadline; default: the person's web limits. */
  limits?: { maxBytes: number; deadlineMs: number };
  /** The `User-Agent` value; `""` sends none. Default: `searchUserAgent()`. */
  userAgent?: string;
}

/** Why a search failed, for `test()` and the outcomes of WB54. */
export type WebSearchFailureKind =
  | "auth-failed"
  | "not-enabled"
  | "quota-exhausted"
  | "rate-limited"
  | "backend-error"
  | "bad-response";

/** A failed search. The message names the status or the problem, never the body. */
export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly kind: WebSearchFailureKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}

export type WebSearchTestResult =
  | { ok: true; count: number; latencyMs: number }
  | {
      ok: false;
      kind: WebSearchFailureKind | "error";
      message: string;
      status?: number;
    };

/** The fixed query of a test search (SP-13): never text from the person. */
export const WEB_SEARCH_TEST_QUERY = "continuous search test";

export interface WebSearchProvider {
  /** The provider id from `web.search.provider`, for example `searxng`. */
  readonly id: string;
  /** A name for people, for example "SearXNG (your server)". */
  readonly label: string;
  /** Where the queries go: the endpoint the person configured. */
  readonly destination: URL;
  search(
    query: WebSearchQuery,
    context: WebSearchContext,
  ): Promise<WebSearchResponse>;
  /** One search with `WEB_SEARCH_TEST_QUERY`, reported rather than thrown. */
  test(context: WebSearchContext): Promise<WebSearchTestResult>;
}

/** The settings an adapter is built from: the selected provider's part of `web.search`. */
export interface WebSearchProviderSettings {
  url?: string;
  apiKey?: string;
  safeSearch?: "off" | "moderate" | "strict";
  country?: string;
  custom?: { method?: "GET" | "POST" };
}

/** Builds an adapter, or says why it cannot (a missing or malformed URL). */
export type WebSearchProviderFactory = (
  settings: WebSearchProviderSettings,
) => WebSearchProvider | { error: string };

/** An `http:` or `https:` URL without user name or password, or why not. */
export function endpointUrl(
  raw: string | undefined,
  key: string,
): URL | { error: string } {
  const text = raw?.trim();
  if (!text) return { error: `${key} is not set` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `${key} is not a URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `${key} must be an http or https URL` };
  }
  if (url.username || url.password) {
    return {
      error: `${key} must not carry a user name or password; use apiKey`,
    };
  }
  return url;
}

/** `docs.python.org` from `site`, or undefined when it is not a plain host name. */
export function siteHost(site: string | undefined): string | undefined {
  const host = site?.trim().toLowerCase();
  return host &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(
      host,
    )
    ? host
    : undefined;
}

/** The query with ` site:<host>` added, for providers without a site filter. */
export function queryWithSite(
  query: string,
  site: string | undefined,
): { q: string; site?: WebSearchFilterUse } {
  const host = siteHost(site);
  if (!host) return { q: query, site: site ? "ignored" : undefined };
  return { q: `${query} site:${host}`, site: "query" };
}

/** The extension version for the User-Agent's major.minor; none when the IDE cannot say. */
export async function productVersion(
  ide: Pick<IDE, "getIdeInfo"> | undefined,
): Promise<string | undefined> {
  try {
    return (await ide?.getIdeInfo())?.extensionVersion;
  } catch {
    return undefined;
  }
}

/** The search User-Agent (UA-3) for the person's `web.userAgent`. */
export async function searchUserAgent(
  version: string | undefined,
): Promise<string> {
  const [{ userAgentFor }, { getWebConfig }] = await Promise.all([
    import("../../web/userAgent"),
    import("../../util/webConfig"),
  ]);
  return userAgentFor(getWebConfig().userAgent, {
    purpose: "search",
    version,
  });
}

export interface SearchRequest {
  provider: string;
  url: URL;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  /** A JSON body, for POST. */
  json?: unknown;
  /** Header names that carry the key and must not cross to another origin. */
  keyHeaders?: string[];
  /** SearXNG answers 403 when `format=json` is not enabled. */
  forbiddenMeansNotEnabled?: boolean;
}

/**
 * Send one search request through the shared guard and parse the JSON reply.
 * The guard follows redirects by hand, pins DNS, refuses a hop to a private
 * address and drops `Authorization` (and `keyHeaders`) on a cross-origin
 * redirect. An error names the status, never the body.
 */
export async function searchRequest(
  request: SearchRequest,
  context: WebSearchContext,
): Promise<{ body: unknown; host: string }> {
  // Loaded on demand: the registry is imported by code that only asks whether
  // search is configured, and must not pull in the network stack
  const [{ guardedWebRequest }, { decodeBytes }, { readUserFetchLimits }] =
    await Promise.all([
      import("../../util/guardedFetch"),
      import("../../util/boundedBody"),
      import("../../util/userFetchLimits"),
    ]);
  const limits = context.limits ?? readUserFetchLimits();
  const userAgent = context.userAgent ?? (await searchUserAgent(undefined));
  const hasBody = request.json !== undefined;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(userAgent ? { "User-Agent": userAgent } : {}),
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...request.headers,
  };
  const resp = await guardedWebRequest(request.url, {
    purpose: "search",
    origin: "config",
    fetchFn: context.fetchFn,
    init: {
      method: request.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(request.json) } : {}),
    },
    guard: { originHeaders: request.keyHeaders },
    maxBytes: limits.maxBytes,
    deadlineMs: limits.deadlineMs,
    callId: context.callId,
  });
  if (!resp.ok) {
    throw new WebSearchError(
      `Web search failed (HTTP ${resp.status})`,
      failureKind(resp.status, request.forbiddenMeansNotEnabled === true),
      resp.status,
    );
  }
  if (resp.truncated) {
    throw new WebSearchError(
      `Web search failed: the response is larger than ${limits.maxBytes} bytes`,
      "bad-response",
    );
  }
  try {
    return {
      body: JSON.parse(decodeBytes(resp.data, resp.contentType, false)),
      host: resp.finalUrl.host,
    };
  } catch {
    throw new WebSearchError(
      "Web search failed: the response is not JSON",
      "bad-response",
    );
  }
}

function failureKind(
  status: number,
  forbiddenMeansNotEnabled: boolean,
): WebSearchFailureKind {
  if (status === 403 && forbiddenMeansNotEnabled) return "not-enabled";
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 402) return "quota-exhausted";
  if (status === 429) return "rate-limited";
  return "backend-error";
}

/** `test()` for any provider: the fixed query, timed, reported rather than thrown. */
export async function testBySearching(
  provider: WebSearchProvider,
  context: WebSearchContext,
): Promise<WebSearchTestResult> {
  const started = Date.now();
  try {
    const result = await provider.search(
      { query: WEB_SEARCH_TEST_QUERY, maxResults: 1 },
      context,
    );
    return {
      ok: true,
      count: result.hits.length,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return e instanceof WebSearchError
      ? { ok: false, kind: e.kind, message: e.message, status: e.status }
      : {
          ok: false,
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        };
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Hits from a `{ "results": [...] }` reply: the SearXNG shape (`content`) and
 * the custom POST shape (`snippet`). A reply without a `results` list has no
 * hits, as before WB53; WB54's `bad-response` outcome will tell them apart.
 */
export function hitsFromResults(body: unknown, max: number): WebSearchHit[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .slice(0, Math.max(0, max))
    .map((r) => {
      const published = text(r.publishedDate) ?? text(r.published);
      return {
        title: text(r.title) ?? "",
        url: text(r.url) ?? "",
        snippet: text(r.content) ?? text(r.snippet) ?? "",
        ...(published ? { published } : {}),
      };
    });
}
