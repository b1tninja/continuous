import { WEB_SEARCH_PROVIDER_IDS } from "@continuedev/config-yaml";

import { getWebConfig, type ResolvedWebConfig } from "../../util/webConfig";
import { createCustomProvider } from "./custom";
import type {
  WebSearchContext,
  WebSearchProvider,
  WebSearchProviderFactory,
  WebSearchProviderSettings,
  WebSearchQuery,
  WebSearchResponse,
} from "./provider";
import { createSearxngProvider } from "./searxng";

/**
 * Which search provider is in force, from `getWebConfig().search`
 * (plans/research/web-search-providers.md, section 6):
 *
 * - SR-1: `web.enabled: false` or `provider: off` from any config turns
 *   search off. Everything else comes from the person's own config.yaml
 *   (core/util/webConfig.ts enforces that).
 * - SR-2: no `provider` and a `url`: `searxng`, as before WB53. Neither: off.
 *   Off is the default (SP-1): nothing is contacted and the tool is not offered.
 * - SR-6: an unknown provider id is off (the config reader gives the notice).
 * - `native` is the selected model's own search. It is not built yet (WB60),
 *   so `search_web` and `@web` use `fallback` when one is set and are not
 *   offered otherwise.
 *
 * The adapters built in: `searxng` and `custom`. The other known ids are
 * added by their own rows; until then they read as off, with a reason.
 */

const FACTORIES = new Map<string, WebSearchProviderFactory>([
  ["searxng", createSearxngProvider],
  ["custom", createCustomProvider],
]);

/** Add (or, for tests, replace) an adapter. Returns a function that removes it again. */
export function registerWebSearchProvider(
  id: string,
  factory: WebSearchProviderFactory,
): () => void {
  const previous = FACTORIES.get(id);
  FACTORIES.set(id, factory);
  return () => {
    if (previous) FACTORIES.set(id, previous);
    else FACTORIES.delete(id);
  };
}

/** The provider ids this build has an adapter for. */
export function availableWebSearchProviders(): string[] {
  return [...FACTORIES.keys()];
}

export type WebSearchSelection =
  | {
      state: "ready";
      provider: WebSearchProvider;
      /** `fallback` when `provider: native` and the fallback answers. */
      via: "provider" | "fallback";
      /** Results per search unless the caller asks for fewer: `maxResults`, default 5. */
      maxResults: number;
      /** `web.search.maxResults` when the person or a config set it. */
      maxResultsSet?: number;
    }
  | {
      state: "off" | "native-only" | "unavailable";
      /** One sentence for the person (the `@web` error, `continuous doctor`). */
      reason: string;
    };

const DEFAULT_MAX_RESULTS = 5;

function build(
  id: string,
  settings: WebSearchProviderSettings,
  key: string,
): WebSearchProvider | { error: string } {
  const factory = FACTORIES.get(id);
  if (!factory) {
    const known = (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(id);
    return {
      error: `web.search.${key}: ${JSON.stringify(id)} is ${known ? "not available in this build yet" : "not a known search provider"}, so web search is off.`,
    };
  }
  const made = factory(settings);
  return "error" in made
    ? {
        error: `Web search is off: ${made.error}${key === "fallback" ? " (for web.search.fallback, set web.search.fallbackUrl)" : ""}.`,
      }
    : made;
}

/** The search provider in force, or why there is none. Pure apart from reading the config. */
export function selectWebSearch(
  config: ResolvedWebConfig = getWebConfig(),
): WebSearchSelection {
  const search = config.search;
  if (!config.enabled) {
    return { state: "off", reason: "Web search is off: web.enabled is false." };
  }
  const id = search.provider ?? (search.url?.trim() ? "searxng" : undefined);
  if (id === undefined) {
    return {
      state: "off",
      reason:
        "Web search is off until you pick a provider: set web.search in your config.yaml.",
    };
  }
  if (id === "off") {
    return {
      state: "off",
      reason: "Web search is off: web.search.provider is off.",
    };
  }
  const shared: WebSearchProviderSettings = {
    safeSearch: search.safeSearch,
    country: search.country,
    custom: search.custom,
  };
  let made: WebSearchProvider | { error: string };
  let via: "provider" | "fallback" = "provider";
  if (id === "native") {
    if (!search.fallback || search.fallback === "off") {
      return {
        state: "native-only",
        reason:
          "Web search is set to your model's own search (web.search.provider: native), which @web and search_web cannot use. Set web.search.fallback to a provider they can call, such as searxng.",
      };
    }
    if (search.fallback === "native") {
      return {
        state: "unavailable",
        reason: "Web search is off: web.search.fallback cannot be native.",
      };
    }
    via = "fallback";
    made = build(
      search.fallback,
      { ...shared, url: search.fallbackUrl, apiKey: search.fallbackApiKey },
      "fallback",
    );
  } else {
    made = build(
      id,
      { ...shared, url: search.url, apiKey: search.apiKey },
      "provider",
    );
  }
  if ("error" in made) return { state: "unavailable", reason: made.error };
  return {
    state: "ready",
    provider: made,
    via,
    maxResults: search.maxResults ?? DEFAULT_MAX_RESULTS,
    ...(search.maxResults === undefined
      ? {}
      : { maxResultsSet: search.maxResults }),
  };
}

/** True when `search_web` and `@web` are offered: a provider is set up and this build can call it. */
export function isWebSearchConfigured(
  config: ResolvedWebConfig = getWebConfig(),
): boolean {
  return selectWebSearch(config).state === "ready";
}

/** Thrown by `runWebSearch` when no provider is in force; the message is the reason. */
export class WebSearchNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchNotConfiguredError";
  }
}

/**
 * One search with the provider in force. `maxResults` defaults to the
 * configured count and is never more than `web.search.maxResults` when that is
 * set.
 */
export async function runWebSearch(
  query: Omit<WebSearchQuery, "maxResults"> & { maxResults?: number },
  context: WebSearchContext,
  selection: WebSearchSelection = selectWebSearch(),
): Promise<WebSearchResponse> {
  if (selection.state !== "ready") {
    throw new WebSearchNotConfiguredError(selection.reason);
  }
  const wanted = query.maxResults ?? selection.maxResults;
  const maxResults = Math.min(wanted, selection.maxResultsSet ?? wanted);
  return selection.provider.search({ ...query, maxResults }, context);
}
