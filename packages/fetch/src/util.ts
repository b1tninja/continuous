import { RequestOptions } from "@continuedev/config-types";
import { BlockList, isIP } from "node:net";

/**
 * Proxy selection from the environment: the variable named for the URL's
 * scheme and nothing else. `HTTPS_PROXY` serves https:, `HTTP_PROXY` serves
 * http:. An https: request does NOT fall back to `HTTP_PROXY`: the two
 * variables name different proxies in practice, and sending TLS tunnels to the
 * plain-HTTP proxy was an accident of an earlier version. When only
 * `HTTP_PROXY` is set, one warning says so.
 *
 * Differences, verified 2026-11-11 from the sources:
 * - Node (built-in proxy support, `NODE_USE_ENV_PROXY`) reads `HTTP_PROXY` or
 *   `http_proxy` for http:, `HTTPS_PROXY` or `https_proxy` for https:, and the
 *   lower-case spelling wins when both are set; no cross-scheme fallback.
 *   https://nodejs.org/api/http.html#built-in-proxy-support
 * - curl reads `http_proxy` (lower case only), `HTTPS_PROXY`/`https_proxy`,
 *   `ALL_PROXY`; the lower-case form wins. No https -> http fallback. We do not
 *   read `ALL_PROXY`.
 *   https://curl.se/docs/manpage.html (ENVIRONMENT)
 * We follow Node on case: lower case first. `NO_PROXY` is handled below.
 */
export function getProxyFromEnv(protocol: string): string | undefined {
  if (protocol === "https:") {
    const https = process.env.https_proxy || process.env.HTTPS_PROXY;
    if (!https) warnHttpsWithoutHttpsProxy();
    return https || undefined;
  }
  if (protocol === "http:") {
    return process.env.http_proxy || process.env.HTTP_PROXY || undefined;
  }
  return undefined;
}

let warnedHttpFallback = false;

function warnHttpsWithoutHttpsProxy() {
  if (warnedHttpFallback) return;
  if (!(process.env.http_proxy || process.env.HTTP_PROXY)) return;
  warnedHttpFallback = true;
  console.warn(
    "HTTP_PROXY is set but HTTPS_PROXY is not: https requests go direct. Set HTTPS_PROXY (or requestOptions.proxy) to proxy them.",
  );
}

/** Test hook: forget that the HTTP_PROXY warning was shown. */
export function resetProxyWarning(): void {
  warnedHttpFallback = false;
}

// Note that request options proxy (per model) takes precedence over environment variables
export function getProxy(
  protocol: string,
  requestOptions?: RequestOptions,
): string | undefined {
  if (requestOptions?.proxy) {
    return requestOptions.proxy;
  }
  return getProxyFromEnv(protocol);
}

export function getEnvNoProxyPatterns(): string[] {
  const envValue = process.env.no_proxy || process.env.NO_PROXY;
  if (envValue && typeof envValue === "string") {
    return envValue
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((i) => !!i);
  } else {
    return [];
  }
}

export function getReqOptionsNoProxyPatterns(
  options: RequestOptions | undefined,
): string[] {
  return (
    options?.noProxy?.map((i) => i.trim().toLowerCase()).filter((i) => !!i) ??
    []
  );
}

/** Split `host:port` without treating an IPv6 address or a CIDR prefix as a port. */
function splitHostPort(value: string): [string, string | undefined] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end !== -1) {
      const host = value.slice(1, end);
      const rest = value.slice(end + 1);
      return [host, rest.startsWith(":") ? rest.slice(1) : undefined];
    }
  }
  if (value.includes("/")) return [value, undefined];
  const colon = value.lastIndexOf(":");
  if (colon === -1 || value.indexOf(":") !== colon) return [value, undefined];
  return [value.slice(0, colon), value.slice(colon + 1)];
}

function cidrMatches(hostname: string, pattern: string): boolean {
  const slash = pattern.lastIndexOf("/");
  if (slash <= 0) return false;
  const network = pattern.slice(0, slash);
  const bits = Number(pattern.slice(slash + 1));
  const family = isIP(network);
  if (!family || !Number.isInteger(bits) || isIP(hostname) !== family) {
    return false;
  }
  const block = new BlockList();
  try {
    block.addSubnet(network, bits, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
  return block.check(hostname, family === 4 ? "ipv4" : "ipv6");
}

export function patternMatchesHostname(hostname: string, pattern: string) {
  const [hostnameWithoutPort, hostnamePort] = splitHostPort(
    hostname.toLowerCase(),
  );
  const [patternWithoutPort, patternPort] = splitHostPort(
    pattern.toLowerCase(),
  );

  // If pattern specifies a port but hostname doesn't match it, no match
  if (patternPort && (!hostnamePort || hostnamePort !== patternPort)) {
    return false;
  }

  if (patternWithoutPort === "*") return true;

  if (cidrMatches(hostnameWithoutPort, patternWithoutPort)) return true;

  // *.example.com matches a subdomain, not the apex.
  if (patternWithoutPort.startsWith("*.")) {
    const suffix = patternWithoutPort.slice(1);
    return (
      hostnameWithoutPort.length > suffix.length &&
      hostnameWithoutPort.endsWith(suffix)
    );
  }

  // A bare domain and a leading-dot domain are the same suffix match, and the
  // boundary is a dot: `.corp.example.com` does not match `evilcorp.example.com`.
  const domain = patternWithoutPort.replace(/^\.+/, "");
  if (!domain || domain.includes("*")) return false;
  return (
    hostnameWithoutPort === domain || hostnameWithoutPort.endsWith("." + domain)
  );
}

/**
 * Checks if a hostname should bypass proxy based on NO_PROXY environment variable
 * @param hostname The hostname to check
 * @returns True if the hostname should bypass proxy
 */
export function shouldBypassProxy(
  hostname: string,
  requestOptions: RequestOptions | undefined,
): boolean {
  const ignores = [
    ...getEnvNoProxyPatterns(),
    ...getReqOptionsNoProxyPatterns(requestOptions),
  ];
  const hostLowerCase = hostname.toLowerCase();
  return ignores.some((ignore) =>
    patternMatchesHostname(hostLowerCase, ignore),
  );
}
