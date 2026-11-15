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
import { fetchFavicon } from "../../util/fetchFavicon";
import { readBodyCapped, withDeadline } from "../../util/boundedBody";
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
import { fetchWithGuardedRedirects } from "../../util/guardedFetch";
import { readUserFetchLimits } from "../../util/userFetchLimits";

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
    return await getUrlContextItems(query, extras.fetch, {
      requestOptions: extras.config?.requestOptions,
    });
  }
}

export default URLContextProvider;

export interface UrlFetchOptions {
  /**
   * For URLs chosen by the model (the fetch tool) rather than typed by the
   * user: follow redirects one at a time and refuse one that leads from a
   * public address to a non-public one (loopback, private network, the cloud
   * metadata address), skip the favicon lookup, which would fetch another
   * URL from the page, and refuse a URL that carries a credential-shaped
   * value. A URL that is itself non-public is the caller's decision (the
   * tool asks for approval first).
   */
  guardRedirects?: boolean;
  /** For the favicon lookup, which does not go through `fetchFn`. */
  requestOptions?: RequestOptions;
  /** Byte ceiling for the body after decoding. Default: the person's config, else 2 MiB. */
  maxBytes?: number;
  /** Deadline in milliseconds for the whole request including the body. Default: 20 s. */
  deadlineMs?: number;
}

export async function getUrlContextItems(
  query: string,
  fetchFn: FetchFunction,
  options: UrlFetchOptions = {},
): Promise<ContextItem[]> {
  const startUrl = new URL(query.trim());
  let url = startUrl;
  // Before any network call, and for typed and model-chosen URLs alike
  assertFetchableScheme(startUrl);
  assertNoUserinfo(startUrl);
  if (options.guardRedirects) assertNoSecretInUrl(startUrl);

  const limits = readUserFetchLimits();
  const maxBytes = options.maxBytes ?? limits.maxBytes;
  const deadlineMs = options.deadlineMs ?? limits.deadlineMs;

  const icon = options.guardRedirects
    ? undefined
    : await fetchFavicon(startUrl, options.requestOptions);
  const { text, truncated, contentType } = await withDeadline(
    deadlineMs,
    async (signal) => {
      const resp = options.guardRedirects
        ? await fetchWithGuardedRedirects(
            startUrl,
            fetchFn,
            {
              classify: classifyFetchTarget,
              // The page is labelled with where it was read, not where the
              // model pointed: a redirect can lead to another host
              onFinalUrl: (final) => {
                url = final;
              },
            },
            { signal },
          )
        : await fetchFn(startUrl, { signal } as never);

      // Check if the response is not OK
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      const contentType: string | null =
        resp.headers?.get?.("content-type") ?? null;
      if (classifyContentType(contentType) === "binary") {
        throw binaryRefusal(contentType);
      }
      const body = await readBodyCapped(resp, { maxBytes, signal, deadlineMs });
      return { ...body, contentType };
    },
  );

  let kind: BodyKind = classifyContentType(contentType);
  if (kind === "unknown") kind = sniffBody(text);
  if (kind === "binary") throw binaryRefusal(contentType);

  const { markdown, title } = convert(text, kind, url);

  const items: ContextItem[] = [
    {
      icon,
      description: url.toString(),
      content: sanitizeFetchedText(markdown),
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

function binaryRefusal(contentType: string | null): Error {
  return new Error(
    `Refused: the response is ${mediaType(contentType) || "binary data"}, not text. Only HTML, plain text, markdown, JSON and XML are read`,
  );
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
