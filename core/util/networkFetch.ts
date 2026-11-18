import type { RequestOptions } from "..";

/**
 * The part of `requestOptions` that is about reaching a host: proxy, CA
 * bundle, the OS store, client certificate, `verifySsl`, timeouts.
 *
 * For hosts that are not a model endpoint (docs sites, favicons, model lists,
 * GitHub). `headers` and `extraBodyProperties` are deliberately dropped: they
 * are meant for the model provider and would leak an API gateway token or add
 * fields to a request body of some other site.
 */
export function transportOptions(
  requestOptions: RequestOptions | undefined,
): RequestOptions | undefined {
  if (!requestOptions) return undefined;
  const {
    headers: _headers,
    extraBodyProperties: _extra,
    ...transport
  } = requestOptions;
  return transport;
}

/**
 * `fetch` through the shared client (`@continuedev/fetch`), so proxy
 * variables, the system CA store and the user's `requestOptions` apply.
 * Imported on demand: modules that use this are also loaded by the webview,
 * and @continuedev/fetch pulls in node-fetch, which crashes that page.
 */
export async function networkFetch(
  url: string | URL | Request,
  init?: any,
  requestOptions?: RequestOptions,
): Promise<Response> {
  const { fetchwithRequestOptions } = await import("@continuedev/fetch");
  return (await fetchwithRequestOptions(
    typeof url === "object" && "url" in url ? url.url : url,
    init,
    transportOptions(requestOptions),
  )) as unknown as Response;
}

/** A `FetchFunction` bound to some request options. */
export function networkFetchWith(requestOptions: RequestOptions | undefined) {
  return (url: string | URL | Request, init?: any) =>
    networkFetch(url, init, requestOptions);
}
