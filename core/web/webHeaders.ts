import type { WebHostOverride, WebUserAgent } from "@continuedev/config-yaml";

import type { FetchPurpose } from "../util/fetchRecord";
import { normalizeHost } from "../util/networkAddress";
import { getWebConfig, type ResolvedWebConfig } from "../util/webConfig";

import { userAgentFor, type UserAgentPurpose } from "./userAgent";

/**
 * The request headers every web path sends to a site (WB17, decisions UA-1 to
 * UA-9 of plans/research/web-fetch-deep-dive.md, section 3.4):
 *
 * - `User-Agent` from `web.userAgent`, or from the `web.hosts` entry that
 *   matches the host. `Continuous-User/<major.minor> (+<info URL>)` by
 *   default, `Continuous-Crawler/...` for the docs crawler, the product token
 *   alone for the search backend. Never the OS, the editor, a patch version or
 *   an id. With `custom: ""` the header is sent empty, so the HTTP client
 *   cannot put its own (`node-fetch`) in its place.
 * - `Accept` preferring Markdown for a page read for the person (the fetch
 *   tools, `@url`), HTML first for the crawler, which reads links from it.
 * - `Accept-Language` only when `web.acceptLanguage` is set, and only for
 *   pages: it discloses the person's locale.
 * - The `web.hosts[<pattern>].headers` of the matching entry, to that host
 *   only. Computed again at every redirect hop, so they never follow the
 *   request to a host the pattern does not match.
 * - No `From` (the crawler's comes with WB19, when `web.crawler.contact` is
 *   set), no `Referer`, no cookies, no client hints.
 *
 * Every value comes from the person's own config.yaml: `getWebConfig()` drops
 * these keys from any other source.
 */

/** `Accept` for a page read for the person: Markdown first, as UA-9 decides. */
export const PAGE_ACCEPT =
  "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1";

/** `Accept` for the docs crawler, which parses HTML for its links. */
export const CRAWLER_ACCEPT =
  "text/html, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";

/**
 * Header names a `web.hosts` entry cannot set: the User-Agent has its own key,
 * and the others belong to the HTTP client or to a page's session.
 */
const HOST_HEADER_DENY = new Set([
  "user-agent",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "cookie",
  "referer",
]);

let agentVersion: string | undefined;

/**
 * The release the User-Agent names, set once at startup: the extension's
 * version (core, from the IDE info) or the CLI's. Before it is set the
 * header says `0.0`.
 */
export function setWebAgentVersion(version: string | undefined): void {
  agentVersion = version;
}

export function getWebAgentVersion(): string | undefined {
  return agentVersion;
}

/**
 * Whether `host` matches a `web.hosts` pattern, in `host:` rule syntax:
 * `example.com` is that host only, `*.example.com` is any name under it and
 * not `example.com` itself, compared on whole labels, case and a trailing dot
 * ignored. A bare `*` matches nothing (it is allowed only in a deny rule).
 */
export function hostPatternMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern.replace(/^host:/i, ""));
  const h = normalizeHost(host);
  if (!p || !h || p === "*") return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1);
    return suffix.length > 1 && h.length > suffix.length && h.endsWith(suffix);
  }
  return !p.includes("*") && p === h;
}

/**
 * The `web.hosts` entry for a host: an exact pattern wins over a wildcard,
 * and among wildcards the longest one.
 */
export function hostOverrideFor(
  hosts: Readonly<Record<string, WebHostOverride>>,
  host: string,
): WebHostOverride | undefined {
  let best: { rank: number; override: WebHostOverride } | undefined;
  for (const [pattern, override] of Object.entries(hosts)) {
    if (!hostPatternMatches(pattern, host)) continue;
    const rank = pattern.includes("*") ? pattern.length : Infinity;
    if (!best || rank > best.rank) best = { rank, override };
  }
  return best?.override;
}

function userAgentPurpose(purpose: FetchPurpose): UserAgentPurpose {
  if (purpose === "crawler") return "crawler";
  if (purpose === "search") return "search";
  return "user";
}

/** The User-Agent setting in force for a host: its `web.hosts` entry, else `web.userAgent`. */
export function userAgentSettingFor(
  url: URL,
  config: Pick<ResolvedWebConfig, "userAgent" | "hosts">,
): WebUserAgent {
  return (
    hostOverrideFor(config.hosts, url.hostname)?.userAgent ?? config.userAgent
  );
}

/** The User-Agent header value for a request to `url`. */
export function webUserAgent(
  purpose: FetchPurpose,
  url: URL,
  config: Pick<ResolvedWebConfig, "userAgent" | "hosts"> = getWebConfig(),
  version: string | undefined = agentVersion,
): string {
  return userAgentFor(userAgentSettingFor(url, config), {
    purpose: userAgentPurpose(purpose),
    version,
  });
}

/**
 * The headers this policy adds to a request to `url`. The caller's own
 * headers (a search backend's `Accept`, its key) are merged over them by the
 * guard; the User-Agent is always this one.
 */
export function webRequestHeaders(
  purpose: FetchPurpose,
  url: URL,
  config: Pick<
    ResolvedWebConfig,
    "userAgent" | "hosts" | "acceptLanguage"
  > = getWebConfig(),
  version: string | undefined = agentVersion,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const override = hostOverrideFor(config.hosts, url.hostname);
  for (const [name, value] of Object.entries(override?.headers ?? {})) {
    if (!HOST_HEADER_DENY.has(name.toLowerCase())) headers[name] = value;
  }
  const page = purpose === "tool" || purpose === "url" || purpose === "panel";
  if (page) headers["Accept"] = PAGE_ACCEPT;
  if (purpose === "crawler") headers["Accept"] = CRAWLER_ACCEPT;
  if ((page || purpose === "crawler") && config.acceptLanguage) {
    headers["Accept-Language"] = config.acceptLanguage;
  }
  headers["User-Agent"] = userAgentFor(
    override?.userAgent ?? config.userAgent,
    {
      purpose: userAgentPurpose(purpose),
      version,
    },
  );
  return headers;
}

/**
 * The policy's headers with the caller's on top, names compared without
 * case. The policy's User-Agent always stands: no caller picks its own.
 */
export function mergeHeaders(
  policy: Record<string, string>,
  caller: Record<string, string>,
): Record<string, string> {
  const isUa = (name: string) => name.toLowerCase() === "user-agent";
  const callerNames = new Set(Object.keys(caller).map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(policy)) {
    if (isUa(k) || !callerNames.has(k.toLowerCase())) out[k] = v;
  }
  for (const [k, v] of Object.entries(caller)) {
    if (!isUa(k)) out[k] = v;
  }
  return out;
}
