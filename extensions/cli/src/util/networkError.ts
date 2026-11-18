/**
 * Turn the generic "request failed" error from a first run with no network
 * into a message a person can act on. Only the host name is ever shown, never
 * a URL, so a credential in a URL or a query string cannot reach the output.
 */

export type NetworkFailureReason =
  "dns" | "connect" | "timeout" | "tls" | "unknown";

export interface NetworkFailure {
  /** Stable, machine-readable error code */
  code: "network_unreachable";
  reason: NetworkFailureReason;
  host?: string;
  message: string;
}

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA"]);
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EPIPE",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const TLS_CODE =
  /^(UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|CERT_|ERR_TLS|ERR_SSL|HOSTNAME_MISMATCH|ERR_CERT)/;
const GENERIC = /fetch failed|The request failed and the interceptors/i;
const MAX_DEPTH = 6;

interface Found {
  reason: NetworkFailureReason;
  host?: string;
}

function* chain(error: unknown): Generator<Record<string, unknown>> {
  let current: unknown = error;
  for (
    let i = 0;
    i < MAX_DEPTH && current && typeof current === "object";
    i++
  ) {
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  // A bare host name or address only: no scheme, path, port or credentials
  return /^[A-Za-z0-9.\-:[\]]+$/.test(value) ? value : undefined;
}

/** The failure behind an error, or undefined when it is not a network failure */
export function classifyNetworkError(error: unknown): Found | undefined {
  let reason: NetworkFailureReason | undefined;
  let host: string | undefined;
  let generic = false;
  for (const e of chain(error)) {
    const code = typeof e.code === "string" ? e.code : undefined;
    host ??= hostOf(e.hostname) ?? hostOf(e.host) ?? hostOf(e.address);
    if (code) {
      if (DNS_CODES.has(code)) reason ??= "dns";
      else if (TIMEOUT_CODES.has(code)) reason ??= "timeout";
      else if (CONNECT_CODES.has(code)) reason ??= "connect";
      else if (TLS_CODE.test(code)) reason ??= "tls";
    }
    if (e.name === "FetchError" || GENERIC.test(String(e.message ?? ""))) {
      generic = true;
    }
  }
  if (reason) return { reason, host };
  return generic ? { reason: "unknown", host } : undefined;
}

const WHY: Record<NetworkFailureReason, string> = {
  dns: "the name could not be resolved (no network or DNS)",
  connect:
    "the connection was refused or dropped (network down or a proxy in the way)",
  timeout: "the connection timed out (network down or a proxy in the way)",
  tls: "the TLS certificate was not trusted (a proxy that re-signs traffic needs its CA trusted)",
  unknown: "the request failed (network down, DNS, proxy or TLS)",
};

/** The failure as a message and fields, or undefined for any other error */
export function describeNetworkFailure(
  error: unknown,
): NetworkFailure | undefined {
  const found = classifyNetworkError(error);
  if (!found) return undefined;
  const where = found.host
    ? `Cannot reach ${found.host}`
    : "Cannot reach the server";
  return {
    code: "network_unreachable",
    reason: found.reason,
    ...(found.host ? { host: found.host } : {}),
    message:
      `${where}: ${WHY[found.reason]}. ` +
      "If no configuration is set up, put a config.yaml in the Continuous folder (~/.continuous) or pass --config <file> " +
      "to run with no network, and check HTTPS_PROXY and NO_PROXY if you are behind a proxy.",
  };
}
