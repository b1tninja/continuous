import { ContextItem, FetchFunction } from "../..";
import type { WebSearchQuery } from "../../tools/webSearch/provider";
import {
  runWebSearch,
  selectWebSearch,
  type WebSearchSelection,
} from "../../tools/webSearch/registry";

/**
 * The bridge from the web search provider layer (core/tools/webSearch) to
 * the context items `search_web` and `@web` return. Nothing is contacted
 * until the person picks a provider in `web.search` of their own config.yaml
 * (SP-1); until then neither is offered. The old variables still map in, with
 * a deprecation notice: CONTINUOUS_WEB_SEARCH_URL is `web.search.url` (read as
 * SearXNG) and CONTINUOUS_WEB_SEARCH_KEY is `web.search.apiKey`.
 */
export const WEB_SEARCH_URL_ENV = "CONTINUOUS_WEB_SEARCH_URL";
export const WEB_SEARCH_KEY_ENV = "CONTINUOUS_WEB_SEARCH_KEY";

export {
  isWebSearchConfigured,
  selectWebSearch,
} from "../../tools/webSearch/registry";

/** Why `@web` is not offered, for the config error that names it. */
export function webSearchUnavailableReason(
  selection: WebSearchSelection = selectWebSearch(),
): string | undefined {
  return selection.state === "ready" ? undefined : selection.reason;
}

export interface FetchSearchOptions {
  callId?: string;
  freshness?: WebSearchQuery["freshness"];
  site?: string;
  /** Default: the provider in force (`selectWebSearch()`). */
  selection?: WebSearchSelection;
}

/**
 * Search with the provider in force and return one context item per hit:
 * the title as the name, the URL as the description and the snippet as the
 * content, as before the provider layer. `n` is the count wanted (default
 * `web.search.maxResults`, else 5), never more than `web.search.maxResults`
 * when that is set. `fetchFn` must not add the global request headers (pass
 * `modelToolFetch(config)`): only the provider's own key is sent, and only to
 * the provider. An error says the status and never quotes the response body.
 */
export const fetchSearchResults = async (
  query: string,
  n: number | undefined,
  fetchFn: FetchFunction,
  options: FetchSearchOptions = {},
): Promise<ContextItem[]> => {
  const result = await runWebSearch(
    {
      query,
      maxResults: n,
      freshness: options.freshness,
      site: options.site,
    },
    { fetchFn, callId: options.callId },
    options.selection,
  );
  return result.hits.map((hit) => ({
    name: hit.title || hit.url || "Search result",
    description: hit.url,
    content: hit.snippet,
  }));
};
