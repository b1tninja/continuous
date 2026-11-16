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
import { SearxngGetProvider } from "./searxng";

/**
 * A search endpoint the person runs (plans/research/web-search-providers.md,
 * section 5.3), in one of two shapes, chosen by `web.search.custom.method`:
 *
 * - `GET` (default): the SearXNG shape, `GET <url>?q=…&format=json`.
 * - `POST`: body `{"q": "…"}`, reply `{"results": [{"title", "url",
 *   "snippet"}]}`, the shape of Claude Desktop's `custom` search server, so a
 *   server written for it works unchanged. The body carries the query only,
 *   so `freshness` is not sent and `site` goes into the query.
 *
 * The key, if any, is sent as a bearer token.
 */

class CustomPostProvider implements WebSearchProvider {
  readonly id = "custom";
  readonly label = "Custom endpoint (POST)";

  constructor(
    readonly destination: URL,
    private readonly settings: WebSearchProviderSettings,
  ) {}

  async search(
    query: WebSearchQuery,
    context: WebSearchContext,
  ): Promise<WebSearchResponse> {
    const { q, site } = queryWithSite(query.query, query.site);
    const { body, host } = await searchRequest(
      {
        provider: this.id,
        url: new URL(this.destination),
        method: "POST",
        json: { q },
        headers: this.settings.apiKey
          ? { Authorization: `Bearer ${this.settings.apiKey}` }
          : undefined,
      },
      context,
    );
    return {
      provider: this.id,
      host,
      hits: hitsFromResults(body, query.maxResults),
      filters: {
        ...(query.freshness ? { freshness: "ignored" as const } : {}),
        ...(site ? { site } : {}),
      },
    };
  }

  test(context: WebSearchContext) {
    return testBySearching(this, context);
  }
}

export const createCustomProvider: WebSearchProviderFactory = (settings) => {
  const url = endpointUrl(settings.url, "web.search.url");
  if ("error" in url) return url;
  return settings.custom?.method === "POST"
    ? new CustomPostProvider(url, settings)
    : new SearxngGetProvider("custom", "Custom endpoint (GET)", url, settings);
};
