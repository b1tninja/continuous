import { createWebFetch } from "@continuedev/fetch";

/** The network-related part of a user's `requestOptions`. */
export interface NetworkRequestOptions {
  timeout?: number;
  connectTimeout?: number;
  verifySsl?: boolean;
  useSystemCa?: boolean;
  caBundlePath?: string | string[];
  proxy?: string;
  noProxy?: string[];
  clientCertificate?: {
    cert: string;
    key: string;
    passphrase?: string;
  };
  headers?: Record<string, string>;
  extraBodyProperties?: Record<string, unknown>;
}

/**
 * Keeps only what is about reaching a host: proxy, CA bundle, the OS store,
 * client certificate, `verifySsl`, timeouts. `headers` and `extraBodyProperties`
 * belong to a model provider and must not reach the Continue API, GitHub, a
 * hook URL or an MCP server's OAuth endpoints. (An MCP server sends its own
 * `requestOptions.headers` itself, in the transport.)
 */
export function transportOptions(
  requestOptions: NetworkRequestOptions | undefined,
): NetworkRequestOptions | undefined {
  if (!requestOptions) return undefined;
  const {
    headers: _headers,
    extraBodyProperties: _extra,
    ...transport
  } = requestOptions;
  return transport;
}

/**
 * `fetch` for the CLI's own requests (Continue API, storage sync, hooks, PR
 * checks, MCP servers). Node's global fetch ignores `HTTPS_PROXY` and the
 * operating system certificate store, so behind a TLS-inspecting proxy those
 * calls fail while model calls work. This sends them through the shared client
 * (`@continuedev/fetch`): `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, the system
 * CA store (default on Windows and macOS), and the options passed in.
 */
export function networkFetch(
  requestOptions?: NetworkRequestOptions,
): typeof fetch {
  const fetchFn = createWebFetch(transportOptions(requestOptions) as never);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchFn(input, init)) as typeof fetch;
}

/** One-shot form of {@link networkFetch}. */
export function cliFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  requestOptions?: NetworkRequestOptions,
): Promise<Response> {
  return networkFetch(requestOptions)(input, init);
}
