import {
  endpointUrl,
  hitsFromResults,
  queryWithSite,
  searchRequest,
  testBySearching,
  type WebSearchContext,
  type WebSearchProvider,
  type WebSearchProviderFactory,
  type WebSearchProviderSettings,
  type WebSearchQuery,
  type WebSearchResponse,
} from "./provider";

/**
 * SearXNG, or any endpoint that answers its JSON shape: `GET <url>?q=…&
 * format=json`, reply `{ "results": [{ "title", "url", "content" }] }`. This
 * is the request the backend made before WB53, unchanged when no filter is
 * asked for. The key, if any, is sent as a bearer token. `format=json` must be
 * enabled in the server's settings.yml, or it answers 403.
 *
 * `freshness` is sent as `time_range`; SearXNG has no site filter, so `site`
 * goes into the query as `site:<host>`. `safeSearch` is sent as `safesearch`
 * (0, 1, 2) only when the person set it.
 */

const SAFE_SEARCH = { off: "0", moderate: "1", strict: "2" } as const;

export class SearxngGetProvider implements WebSearchProvider {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly destination: URL,
    private readonly settings: WebSearchProviderSettings,
  ) {}

  async search(
    query: WebSearchQuery,
    context: WebSearchContext,
  ): Promise<WebSearchResponse> {
    const url = new URL(this.destination);
    const { q, site } = queryWithSite(query.query, query.site);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    if (query.freshness) url.searchParams.set("time_range", query.freshness);
    if (this.settings.safeSearch) {
      url.searchParams.set("safesearch", SAFE_SEARCH[this.settings.safeSearch]);
    }
    const { body, host } = await searchRequest(
      {
        provider: this.id,
        url,
        method: "GET",
        headers: this.settings.apiKey
          ? { Authorization: `Bearer ${this.settings.apiKey}` }
          : undefined,
        forbiddenMeansNotEnabled: this.id === "searxng",
      },
      context,
    );
    return {
      provider: this.id,
      host,
      hits: hitsFromResults(body, query.maxResults),
      filters: {
        ...(query.freshness ? { freshness: "filter" as const } : {}),
        ...(site ? { site } : {}),
      },
    };
  }

  test(context: WebSearchContext) {
    return testBySearching(this, context);
  }
}

export const createSearxngProvider: WebSearchProviderFactory = (settings) => {
  const url = endpointUrl(settings.url, "web.search.url");
  if ("error" in url) return url;
  return new SearxngGetProvider(
    "searxng",
    "SearXNG (your server)",
    url,
    settings,
  );
};
