import { RequestOptions } from "@continuedev/config-types";

/** `scheme://host[:port]` of each URL, skipping values that do not parse. */
export function originsOf(urls: Iterable<string | undefined>): Set<string> {
  const origins = new Set<string>();
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const { origin } = new URL(raw);
      if (origin && origin !== "null") origins.add(origin);
    } catch {
      // not a URL: it scopes nothing
    }
  }
  return origins;
}

/**
 * The request options to use for a request whose URL was chosen by someone
 * other than the person who wrote the options (a tool call from the model).
 *
 * Top-level `requestOptions` are merged into every model, data destination
 * and MCP server (core/config/yaml/models.ts, loadYaml.ts), so a header there
 * is meant for the endpoints the person configured: a gateway or proxy token.
 * Those headers, and `extraBodyProperties`, are therefore kept only when the
 * URL's origin (scheme, host and port) is one of `allowedOrigins`, and are
 * dropped for every other host. Proxy, CA, certificate and TLS settings are
 * kept for all hosts: they are transport settings, not credentials.
 */
export function requestOptionsForUrl(
  requestOptions: RequestOptions | undefined,
  url: URL | string,
  allowedOrigins: ReadonlySet<string>,
): RequestOptions | undefined {
  if (!requestOptions) return requestOptions;
  if (!requestOptions.headers && !requestOptions.extraBodyProperties) {
    return requestOptions;
  }
  let origin: string;
  try {
    origin = (typeof url === "string" ? new URL(url) : url).origin;
  } catch {
    origin = "";
  }
  if (origin && allowedOrigins.has(origin)) return requestOptions;
  const {
    headers: _headers,
    extraBodyProperties: _body,
    ...rest
  } = requestOptions;
  return rest;
}
