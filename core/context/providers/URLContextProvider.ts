import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { NodeHtmlMarkdown } from "node-html-markdown";

import { BaseContextProvider } from "../";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
  FetchFunction,
  RequestOptions,
} from "../../index.js";
import { decodeBytes } from "../../util/boundedBody";
import { fetchFavicon } from "../../util/fetchFavicon";
import { assertWebEnabled } from "../../util/webConfig";
import {
  classifyContentType,
  mediaType,
  prettyJson,
  sanitizeFetchedText,
  sniffBody,
  TRUNCATION_ITEM_NAME,
  stripHtmlComments,
  type BodyKind,
} from "../../util/fetchedText";
import {
  assertFetchableScheme,
  assertNoSecretInUrl,
  assertNoUserinfo,
  classifyFetchTarget,
} from "../../util/fetchUrlSafety";
import { withProvenance, type FetchPurpose } from "../../util/fetchRecord";
import { guardedWebRequest } from "../../util/guardedFetch";
import { modelToolFetch } from "../../util/modelToolFetch";
import { readUserFetchLimits } from "../../util/userFetchLimits";
import {
  NotTextRefusal,
  statusOutcomeError,
  toOutcomeError,
  WebOutcomeError,
} from "../../util/web/fetchOutcome";
import { needsJavaScript } from "../../util/web/needsJs";
import {
  needsJsOutcome,
  notTextOutcome,
  type BrowserTail,
} from "../../util/web/outcomes";

class URLContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "url",
    displayTitle: "URL",
    description: "Reference a webpage at a given URL",
    type: "query",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    // Not `extras.fetch`, which carries the global request headers (often a
    // gateway token) to every host: a site the person names gets the
    // transport settings only, as the fetch tool's sites do
    return await getUrlContextItems(
      query,
      modelToolFetch(extras.config ?? {}),
      {
        requestOptions: extras.config?.requestOptions,
      },
    );
  }
}

export default URLContextProvider;

export interface UrlFetchOptions {
  /**
   * For URLs chosen by the model (the fetch tool) rather than typed by the
   * user: skip the favicon lookup, which would fetch another URL from the
   * page, and refuse a URL that carries a credential-shaped value. Redirects
   * are guarded for both (every hop re-checked, a public-to-non-public hop
   * refused). A URL that is itself non-public is the caller's decision (the
   * tool asks for approval first; a person who types one meant it).
   */
  guardRedirects?: boolean;
  /** For the favicon lookup, which does not go through `fetchFn`. */
  requestOptions?: RequestOptions;
  /** Byte ceiling for the body after decoding. Default: the person's config, else 2 MiB. */
  maxBytes?: number;
  /** Deadline in milliseconds for the whole request including the body. Default: 20 s. */
  deadlineMs?: number;
  /** The tool call that asked, for the fetch record. */
  callId?: string;
  /** Which path is fetching. Default: `tool` with `guardRedirects`, else `url`. */
  purpose?: FetchPurpose;
  /**
   * The browser the `needs-js` text points to (section 7.2 of
   * plans/research/web-fetch-large-pages-and-policy.md). Default: none.
   */
  browser?: BrowserTail;
  /** With guardRedirects: a redirect to a host this refuses is not followed. */
  allowRedirectHost?: (host: string) => boolean;
}

/**
 * Fetch a URL as context items: the page, with its provenance line. Any other
 * outcome (a refusal, a status that is not 2xx, a network failure, a binary
 * or JavaScript-only page) is thrown as a `WebOutcomeError` carrying the typed
 * outcome and its exact text (`core/util/web/outcomes.ts`); its message is the
 * outcome's first sentence, for `@url`.
 */
export async function getUrlContextItems(
  query: string,
  fetchFn: FetchFunction,
  options: UrlFetchOptions = {},
): Promise<ContextItem[]> {
  const startUrl = new URL(query.trim());
  const byModel = !!options.guardRedirects;
  // web.enabled: false turns off @url and the fetch tool alike (WB45)
  assertWebEnabled("no web page is fetched");
  const limits = readUserFetchLimits();
  const maxBytes = options.maxBytes ?? limits.maxBytes;
  const deadlineMs = options.deadlineMs ?? limits.deadlineMs;
  const ctx = { url: startUrl, deadlineMs };
  try {
    // Before any network call, and for typed and model-chosen URLs alike
    assertFetchableScheme(startUrl);
    assertNoUserinfo(startUrl);
    if (byModel) assertNoSecretInUrl(startUrl);
  } catch (e) {
    throw toOutcomeError(e, ctx);
  }

  const icon = byModel
    ? undefined
    : await fetchFavicon(startUrl, options.requestOptions);
  const resp = await guardedWebRequest(startUrl, {
    purpose: options.purpose ?? (byModel ? "tool" : "url"),
    origin: byModel ? "model" : "person",
    fetchFn,
    maxBytes,
    deadlineMs,
    guard: {
      classify: classifyFetchTarget,
      ...(options.allowRedirectHost
        ? { allowRedirectHost: options.allowRedirectHost }
        : {}),
    },
    callId: options.callId,
    accept: ({ headers }) => {
      const type = headers.get("content-type");
      if (classifyContentType(type) === "binary") {
        throw new NotTextRefusal(mediaType(type));
      }
    },
  }).catch((e: unknown) => {
    throw toOutcomeError(e, ctx);
  });
  if (!resp.ok) {
    // The status and two header values only: an error page is never read
    throw statusOutcomeError(
      {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
        url: resp.finalUrl,
      },
      resp.record,
    );
  }
  // The page is labelled with where it was read, not where it was pointed:
  // a redirect can lead to another host
  const url = resp.finalUrl;
  const { contentType, truncated } = resp;
  const text = decodeBytes(resp.data, contentType, truncated);

  let kind: BodyKind = classifyContentType(contentType);
  if (kind === "unknown") kind = sniffBody(text);
  if (kind === "binary") {
    throw new WebOutcomeError(
      notTextOutcome({
        host: url.host,
        mediaType: mediaType(contentType),
        httpStatus: resp.status,
      }),
      resp.record,
    );
  }

  const { markdown, title } = convert(text, kind, url);
  if (kind === "html") {
    const verdict = needsJavaScript(text, contentType, markdown);
    if (verdict.needsJs) {
      throw new WebOutcomeError(
        needsJsOutcome({
          host: url.host,
          textChars: verdict.textChars,
          noscript: verdict.noscript,
          browser: options.browser,
          httpStatus: resp.status,
        }),
        resp.record,
      );
    }
  }

  const items: ContextItem[] = [
    {
      icon,
      description: url.toString(),
      // Where it was read, its status, size and hash, ahead of the page
      content: withProvenance(resp.record, sanitizeFetchedText(markdown)),
      name:
        sanitizeFetchedText(title).replace(/\s+/g, " ").trim() || url.pathname,
      uri: {
        type: "url",
        value: url.toString(),
      },
    },
  ];
  if (truncated) {
    items.push({
      name: TRUNCATION_ITEM_NAME,
      description: "",
      content: `The response from ${url.toString()} was longer than ${maxBytes} bytes and was cut there; the end of the page is missing.`,
    });
  }
  return items;
}

/** Text of an HTML page that Readability could not use, one line per block. */
function visibleText(document: Document): string {
  return (document.body?.textContent ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function convert(
  text: string,
  kind: BodyKind,
  url: URL,
): { markdown: string; title: string } {
  if (kind === "json") {
    return { markdown: prettyJson(text), title: url.pathname };
  }
  if (kind !== "html") {
    return { markdown: stripHtmlComments(text), title: url.pathname };
  }
  // Comments carry nothing a reader sees and are a place to hide instructions
  const dom = new JSDOM(stripHtmlComments(text));
  const body = visibleText(dom.window.document);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  let markdown = NodeHtmlMarkdown.translate(
    article?.content || "",
    {},
    undefined,
    undefined,
  );
  // An extraction under a quarter of the page's text lost most of it (a
  // listing, a single-page app shell, a page without article markup)
  if (body.length > 0 && markdown.trim().length < body.length / 4) {
    markdown = body;
  }
  return { markdown, title: article?.title || url.pathname };
}
