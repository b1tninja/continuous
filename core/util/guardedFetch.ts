import type { FetchFunction } from "..";

import { readBytesCapped, withDeadline } from "./boundedBody";
import {
  FetchRecorder,
  FetchRefusedError,
  type FetchOrigin,
  type FetchPurpose,
  type FetchRecord,
} from "./fetchRecord";
import { classifyFetchTarget, secretKindsInUrl } from "./fetchUrlSafety";
import { nonPublicReason, normalizeHost, pinnedLookup } from "./networkAddress";

/**
 * The one guard every web path goes through (plans/research/
 * web-fetch-deep-dive.md, sections 5.3, 5.4 and 7.1, rows WB22 and WB23):
 * the fetch tool, `@url`, the favicon lookup, the search backend and the docs
 * crawler. The CLI `Fetch` tool reaches it through the core implementation.
 *
 * Per request:
 * - Redirects are followed by hand (`redirect: "manual"`), at most
 *   `maxRedirects` of them, and a loop is refused.
 * - Every hop's host is resolved once, here, and the connection is pinned to
 *   the checked addresses, so a second DNS answer (rebinding) cannot reach a
 *   different address. A name that resolved to nothing is pinned to nothing:
 *   a direct connection fails rather than asking DNS again.
 * - A hop from a public address to a non-public one (the IANA special-purpose
 *   blocks, see `networkAddress.ts`) is refused, and so is a hop to a
 *   link-local address (the cloud metadata service) on a host other than the
 *   start, whatever the start.
 * - Each redirect `Location` is scanned for credentials, like the start URL
 *   of a model's fetch.
 * - `Authorization`, `Cookie`, `Proxy-Authorization` and any header the
 *   caller names are dropped when a hop changes origin (RFC 9110 section
 *   15.4, step 3).
 *
 * Behind an HTTP proxy the pinned lookup is not used (the proxy resolves the
 * name), but every hop is still resolved and classified here, and a name with
 * no delegated top-level domain that does not resolve locally counts as
 * non-public (`classifyFetchTarget`). What the proxy itself resolves a name to
 * is outside this check; only the proxy's own egress policy closes that.
 */

/**
 * The hop limit. RFC 9110 section 15.4 sets no number; five is what an earlier
 * HTTP specification recommended and what the note keeps.
 */
// TODO(WB27): read `web.limits.maxRedirects` (tighten-only, ceiling 10) once
// the `web:` config section exists.
export const MAX_REDIRECTS = 5;

/** Request headers that never cross to another origin on a redirect. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

type Classify = (
  hostname: string,
) => Promise<{ addresses: string[]; nonPublic: boolean }>;

export interface GuardedFetchOptions {
  /**
   * When the starting host is itself non-public (an internal docs site the user
   * named), a redirect may only stay on that host. Without it, a non-public
   * start may be redirected to any non-public address except a link-local one.
   */
  stayOnStartHost?: boolean;
  /**
   * The start URL came from page content rather than from the user (a
   * favicon link): refuse it when it is non-public.
   */
  refuseNonPublicStart?: boolean;
  /**
   * How a host is classified. Default: `classifyFetchTarget`, an address
   * decides, and a name that resolves to nothing and has no delegated TLD is
   * non-public (it may be an internal host only a proxy can see).
   */
  classify?: Classify;
  /** Redirects to follow before giving up. Default and ceiling: `MAX_REDIRECTS`. */
  maxRedirects?: number;
  /** Extra request headers to drop when a redirect changes origin (an API key header). */
  originHeaders?: string[];
  /**
   * Called with the URL the returned response came from (the start URL when
   * nothing redirected), so a caller can label the content with where it
   * really was read.
   */
  onFinalUrl?: (url: URL) => void;
  /** Called with every response, redirects included. */
  onHop?: (url: URL, status: number) => void;
  /** Called with the start host's classification, before the first request. */
  onStart?: (start: { nonPublic: boolean; addresses: string[] }) => void;
}

type Init = Record<string, unknown> & {
  method?: string;
  headers?: unknown;
  body?: unknown;
};

/** Headers of any shape (plain object, entries, a Headers-like object) as a plain object. */
function plainHeaders(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source) return out;
  if (Array.isArray(source)) {
    for (const [key, value] of source) out[String(key)] = String(value);
    return out;
  }
  const s = source as {
    forEach?: (fn: (value: string, key: string) => void) => void;
  };
  if (typeof s.forEach === "function") {
    s.forEach((value, key) => {
      out[key] = value;
    });
  } else if (typeof source === "object") {
    for (const [key, value] of Object.entries(source)) {
      out[key] = String(value);
    }
  }
  return out;
}

function withoutHeaders(
  headers: Record<string, string>,
  names: string[],
): Record<string, string> {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())),
  );
}

/** Let a response's connection go without reading its body. */
function discard(resp: { body?: unknown }): void {
  const body = resp.body as
    { cancel?: () => Promise<void>; resume?: () => void } | null | undefined;
  try {
    if (typeof body?.cancel === "function") {
      body.cancel().catch(() => undefined);
    } else {
      body?.resume?.();
    }
  } catch {
    // nothing to release
  }
}

const isLinkLocal = (address: string) =>
  /link.local/i.test(nonPublicReason(address) ?? "");

/** The request a redirect leads to: method and body per RFC 9110 section 15.4. */
function nextInit(init: Init, status: number): Init {
  const method = String(init.method ?? "GET").toUpperCase();
  const toGet =
    (status === 303 && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  if (!toGet) return init;
  const { body: _body, ...rest } = init;
  return {
    ...rest,
    method: "GET",
    headers: withoutHeaders(init.headers as Record<string, string>, [
      "content-type",
      "content-length",
      "content-encoding",
      "content-language",
      "content-location",
    ]),
  };
}

/** Throws when a redirect target must not be requested. */
function checkLocation(next: URL, visited: Set<string>): void {
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new FetchRefusedError(
      `Refused to follow a redirect to ${next.protocol} URL`,
    );
  }
  if (next.username || next.password) {
    throw new FetchRefusedError(
      `Refused to follow a redirect to a URL with a user name or password in it (${next.host})`,
    );
  }
  const kinds = secretKindsInUrl(next);
  if (kinds.length) {
    throw new FetchRefusedError(
      `Refused to follow a redirect to a URL that contains what looks like a credential (${kinds.join(", ")})`,
    );
  }
  if (visited.has(next.href)) {
    throw new FetchRefusedError(
      `Refused: a redirect loop (${next.host} sent the request back to a URL already visited)`,
    );
  }
}

/**
 * Follow redirects one at a time, resolving every hop once and pinning the
 * connection to those addresses, and refuse a hop that leads from a public
 * address to a non-public one (loopback, private network, the cloud metadata
 * address 169.254.169.254, any non-globally-reachable special-purpose block).
 * A start URL that is itself non-public is the caller's decision.
 */
export async function fetchWithGuardedRedirects(
  start: URL,
  fetchFn: FetchFunction,
  options: GuardedFetchOptions = {},
  init: Record<string, unknown> = {},
): Promise<any> {
  const classify = options.classify ?? classifyFetchTarget;
  const limit = Math.min(
    MAX_REDIRECTS,
    Math.max(0, options.maxRedirects ?? MAX_REDIRECTS),
  );
  let current = start;
  let checked = await classify(current.hostname);
  const startsNonPublic = checked.nonPublic;
  options.onStart?.(checked);
  if (startsNonPublic && options.refuseNonPublicStart) {
    throw new FetchRefusedError(
      `Refused to fetch a non-public address (${start.host})`,
    );
  }
  let request: Init = { ...init, headers: plainHeaders(init.headers) };
  const visited = new Set<string>([start.href]);
  for (let hop = 0; ; hop++) {
    const resp = await fetchFn(current, {
      ...request,
      redirect: "manual",
      // Pinned even when empty: a direct connection then fails instead of
      // resolving again. A proxy agent ignores it and resolves itself.
      lookup: pinnedLookup(checked.addresses),
    } as never);
    const status: number = resp.status;
    options.onHop?.(current, status);
    const location: string | null | undefined = resp.headers?.get?.("location");
    if (status < 300 || status >= 400 || !location) {
      options.onFinalUrl?.(current);
      return resp;
    }
    discard(resp);
    if (hop >= limit) {
      throw new FetchRefusedError(
        `Too many redirects fetching ${start} (more than ${limit})`,
      );
    }

    const next = new URL(location, current);
    checkLocation(next, visited);
    visited.add(next.href);

    checked = await classify(next.hostname);
    const leavesStartHost =
      normalizeHost(next.hostname) !== normalizeHost(start.hostname);
    const linkLocal = checked.addresses.some(isLinkLocal);
    if (
      checked.nonPublic &&
      (!startsNonPublic ||
        (options.stayOnStartHost && leavesStartHost) ||
        (linkLocal && leavesStartHost))
    ) {
      const why = checked.addresses.map(nonPublicReason).find(Boolean);
      throw new FetchRefusedError(
        `Refused to follow a redirect from ${start.host} to a non-public address (${next.host}${why ? `: ${why}` : ""})`,
      );
    }
    if (next.origin !== current.origin) {
      request = {
        ...request,
        headers: withoutHeaders(request.headers as Record<string, string>, [
          ...CREDENTIAL_HEADERS,
          ...(options.originHeaders ?? []),
        ]),
      };
    }
    request = nextInit(request, status);
    current = next;
  }
}

export interface WebRequestOptions {
  purpose: FetchPurpose;
  origin: FetchOrigin;
  /**
   * The fetch to use. Callers pass one that sends no global request headers
   * to a host the model, the person or a page chose (`modelToolFetch`,
   * `networkFetchWith`).
   */
  fetchFn: FetchFunction;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
  maxBytes: number;
  deadlineMs: number;
  guard?: Omit<GuardedFetchOptions, "onFinalUrl" | "onHop" | "onStart">;
  /**
   * Called with a successful response before its body is read; throw to
   * refuse it (a content type the caller does not read).
   */
  accept?: (resp: {
    status: number;
    headers: { get(name: string): string | null };
  }) => void;
  /** The tool call that made the request, for the record and the audit line */
  callId?: string;
}

export interface WebResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(name: string): string | null };
  contentType: string | null;
  /** The body, cut at `maxBytes`; empty for a status of 400 or more */
  data: Uint8Array;
  truncated: boolean;
  finalUrl: URL;
  record: FetchRecord;
}

/** The rule the built-in guard applied, for the record. */
// TODO(WB21): replace with the `host:`/`net:` rule that decided once
// `checkWebDestination` exists.
function builtinRule(origin: FetchOrigin, startsNonPublic: boolean): string {
  return startsNonPublic
    ? `builtin:non-public-start(${origin})`
    : "builtin:public";
}

/**
 * A guarded request with a byte cap and a total deadline, recorded: one call
 * for every web path. The body of a response with a status of 400 or more is
 * not read, so no error message can carry it.
 */
export async function guardedWebRequest(
  url: URL,
  options: WebRequestOptions,
): Promise<WebResponse> {
  const recorder = new FetchRecorder({
    purpose: options.purpose,
    origin: options.origin,
    startUrl: url,
    callId: options.callId,
  });
  try {
    const out = await withDeadline(options.deadlineMs, async (signal) => {
      let finalUrl = url;
      const resp = await fetchWithGuardedRedirects(
        url,
        options.fetchFn,
        {
          ...options.guard,
          onStart: (s) => {
            recorder.rule = builtinRule(options.origin, s.nonPublic);
          },
          onHop: (u, status) => recorder.hop(u, status),
          onFinalUrl: (u) => {
            finalUrl = u;
          },
        },
        { ...options.init, signal },
      );
      const headers = {
        get: (name: string): string | null => resp.headers?.get?.(name) ?? null,
      };
      const contentType = headers.get("content-type");
      const status: number = resp.status;
      recorder.response(status, contentType);
      const ok = status >= 200 && status < 300;
      let body: { data: Uint8Array; truncated: boolean } = {
        data: new Uint8Array(0),
        truncated: false,
      };
      if (status < 400) {
        if (ok) options.accept?.({ status, headers });
        body = await readBytesCapped(resp, {
          maxBytes: options.maxBytes,
          signal,
          deadlineMs: options.deadlineMs,
        });
      } else {
        discard(resp);
      }
      return {
        status,
        statusText: String(resp.statusText ?? ""),
        ok,
        headers,
        contentType,
        ...body,
        finalUrl,
      };
    });
    const record = recorder.finish({
      data: out.data,
      truncated: out.truncated,
    });
    return { ...out, record };
  } catch (e) {
    recorder.fail(e);
    throw e;
  }
}
