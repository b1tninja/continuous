/**
 * `robots.txt` fetching and a per-authority cache, and the verdict for one
 * URL (RFC 9309§2.3 and §2.4). Pure apart from the fetcher it is handed:
 * time comes in as `now`, so there are no timers, and the network is only
 * reached through `fetcher`. Not wired into any fetch path yet: the docs
 * crawler (WB19) and the model's fetch tool (WB20) call it, through the
 * shared guarded fetch (WB22). See plans/research/web-fetch-deep-dive.md §4.
 */

import {
  decidingRule,
  isValidProductToken,
  pathToMatch,
  selectGroup,
  type GroupSelection,
} from "./match";
import {
  parseRobotsTxt,
  ROBOTS_PARSE_LIMIT_BYTES,
  type ParsedRobots,
} from "./parse";

/**
 * RFC 9309§2.4¶1: "Crawlers SHOULD NOT use the cached version for more than
 * 24 hours, unless the robots.txt file is unreachable."
 */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * RFC 9309§2.3.1.2¶1: "The crawlers SHOULD follow at least five consecutive
 * redirects, even across authorities (for example, hosts in the case of
 * HTTP)."
 */
export const ROBOTS_MAX_REDIRECTS = 5;

/**
 * RFC 9309§2.3.1.4¶2: "If the robots.txt file is undefined for a reasonably
 * long period of time (for example, 30 days), crawlers MAY assume that the
 * robots.txt file is unavailable as defined in Section 2.3.1.3 or continue to
 * use a cached copy."
 */
export const ROBOTS_UNREACHABLE_GIVE_UP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How soon an unreachable file is asked for again. RFC 9309 sets no figure;
 * a server error is usually short, and holding a whole site disallowed for
 * the full 24 hours over one 503 would be the wrong way round. One request
 * per authority per hour while it fails.
 */
export const ROBOTS_UNREACHABLE_RETRY_MS = 60 * 60 * 1000;

/** What the fetcher returns for one request. It must not follow redirects. */
export interface RobotsFetchResult {
  status: number;
  /** The `Location` header of a redirect */
  location?: string | null;
  /**
   * The body of a 2xx response. The fetcher may stop reading at
   * `maxBytes`; anything past it is ignored either way.
   */
  body?: string | Uint8Array;
}

/**
 * One GET with no redirect following. A rejection (DNS failure, refused
 * connection, timeout, a guard refusing the address) means "unreachable".
 */
export type RobotsFetcher = (
  url: string,
  options: { maxBytes: number },
) => Promise<RobotsFetchResult>;

export type RobotsReason =
  /** A rule in the applicable group allowed the path */
  | "allowed-by-rule"
  /** A rule in the applicable group disallowed the path */
  | "disallowed-by-rule"
  /** A group applied but no rule in it matched (RFC 9309§2.2.2¶2) */
  | "no-matching-rule"
  /** No group for the token and no `*` group (RFC 9309§2.2.1¶8) */
  | "no-group"
  /** The URL is the robots.txt file itself (RFC 9309§2.2.2¶2) */
  | "robots-txt"
  /** 4xx: the file is unavailable, any resource may be accessed */
  | "unavailable"
  /** More than five redirects: treated as unavailable (RFC 9309§2.3.1.2¶3) */
  | "too-many-redirects"
  /** 5xx or a network error: complete disallow (RFC 9309§2.3.1.4¶1) */
  | "unreachable"
  /** Unreachable for 30 days with no copy: treated as unavailable */
  | "unreachable-expired";

export interface RobotsVerdict {
  allowed: boolean;
  reason: RobotsReason;
  /** The rule that decided, as written in the file, when one did */
  matchedRule?: { kind: "allow" | "disallow"; pattern: string; line: number };
  /** The product tokens of the groups that applied, or ["*"] */
  group?: string[];
  /** The robots.txt URL of the URL's authority */
  robotsUrl: string;
  /** HTTP status of the last response, when one came */
  status?: number;
  /** When the file the verdict used was fetched (ms since the epoch) */
  fetchedAt: number;
  /** The cache answered; no request was made for this verdict */
  fromCache: boolean;
  /**
   * The file could not be reached this time and an older copy was used
   * (RFC 9309§2.4¶1 allows a copy older than 24 hours while unreachable).
   */
  stale?: boolean;
  /** The applicable group's `Crawl-delay`, in seconds */
  crawlDelaySeconds?: number;
  /** AIPREF `Content-Usage` values that apply: recorded, never acted on */
  contentUsage?: string[];
}

type Outcome =
  | { kind: "parsed"; robots: ParsedRobots; status: number }
  | { kind: "unavailable"; status?: number; tooManyRedirects?: boolean }
  | { kind: "unreachable"; status?: number };

interface Entry {
  /** The last outcome that was not "unreachable", with when it was fetched */
  good?: { outcome: Outcome; fetchedAt: number };
  /** Set while the file is unreachable: when that started and was last tried */
  unreachable?: { since: number; lastTried: number; status?: number };
}

export interface RobotsCacheOptions {
  ttlMs?: number;
  unreachableRetryMs?: number;
  /** null: never stop treating an unreachable file as a disallow */
  unreachableGiveUpMs?: number | null;
  maxBytes?: number;
  maxRedirects?: number;
  /** Authorities kept; the oldest is dropped past this */
  maxEntries?: number;
}

/**
 * The authority a URL's robots.txt belongs to, and that file's URL.
 * RFC 9309§2.3¶3: the URI is "scheme:[//authority]/robots.txt". Userinfo is
 * not part of what is fetched.
 */
export function robotsTxtUrl(url: URL): { authority: string; href: string } {
  const authority = `${url.protocol}//${url.host}`.toLowerCase();
  return { authority, href: `${authority}/robots.txt` };
}

async function fetchOutcome(
  href: string,
  fetcher: RobotsFetcher,
  maxBytes: number,
  maxRedirects: number,
): Promise<Outcome> {
  let target = href;
  for (let hop = 0; ; hop++) {
    let res: RobotsFetchResult;
    try {
      res = await fetcher(target, { maxBytes });
    } catch {
      // RFC 9309§2.3.1.4¶1: "If the robots.txt file is unreachable due to
      // server or network errors, this means the robots.txt file is
      // undefined and the crawler MUST assume complete disallow."
      return { kind: "unreachable" };
    }
    const { status } = res;
    if (status >= 200 && status < 300) {
      // RFC 9309§2.3.1.1¶1: "If the crawler successfully downloads the
      // robots.txt file, the crawler MUST follow the parseable rules."
      return {
        kind: "parsed",
        robots: parseRobotsTxt(res.body ?? "", maxBytes),
        status,
      };
    }
    if (status >= 300 && status < 400 && res.location) {
      // RFC 9309§2.3.1.2¶3: "If there are more than five consecutive
      // redirects, crawlers MAY assume that the robots.txt file is
      // unavailable."
      if (hop >= maxRedirects) {
        return { kind: "unavailable", status, tooManyRedirects: true };
      }
      let next: URL;
      try {
        next = new URL(res.location, target);
      } catch {
        return { kind: "unreachable", status };
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        return { kind: "unreachable", status };
      }
      // RFC 9309§2.3.1.2¶2: "If a robots.txt file is reached within five
      // consecutive redirects, the robots.txt file MUST be fetched, parsed,
      // and its rules followed in the context of the initial authority."
      // The caller caches the result under the initial authority.
      target = next.href;
      continue;
    }
    // 429 is the server refusing service for now, not saying the file is
    // absent, so it is read as a server error (unreachable), as Google
    // does. RFC 9309§2.3.1.3¶1 gives 4xx only "for example".
    if (status >= 400 && status < 500 && status !== 429) {
      // RFC 9309§2.3.1.3¶2: "If a server status code indicates that the
      // robots.txt file is unavailable to the crawler, then the crawler MAY
      // access any resources on the server."
      return { kind: "unavailable", status };
    }
    // 5xx (RFC 9309§2.3.1.4¶1: "server errors are identified by status
    // codes in the 500-599 range"), 429, a redirect with no Location, and
    // anything else: undefined, so complete disallow.
    return { kind: "unreachable", status };
  }
}

function verdictFromRobots(
  robots: ParsedRobots,
  url: URL,
  productToken: string,
  base: Omit<RobotsVerdict, "allowed" | "reason">,
): RobotsVerdict {
  const selection: GroupSelection | undefined = selectGroup(
    robots,
    productToken,
  );
  const contentUsage = [
    ...robots.contentUsage,
    ...(selection?.contentUsage ?? []),
  ];
  const extras = {
    ...base,
    ...(contentUsage.length ? { contentUsage } : {}),
  };
  if (!selection) return { ...extras, allowed: true, reason: "no-group" };
  const withGroup = {
    ...extras,
    group: selection.matchedBy,
    ...(selection.crawlDelaySeconds === undefined
      ? {}
      : { crawlDelaySeconds: selection.crawlDelaySeconds }),
  };
  const rule = decidingRule(selection.rules, pathToMatch(url));
  if (!rule) return { ...withGroup, allowed: true, reason: "no-matching-rule" };
  return {
    ...withGroup,
    allowed: rule.kind === "allow",
    reason: rule.kind === "allow" ? "allowed-by-rule" : "disallowed-by-rule",
    matchedRule: { kind: rule.kind, pattern: rule.raw, line: rule.line },
  };
}

/**
 * A cache of robots.txt files by authority, shared by every caller: the file
 * is fetched once per authority, and the verdict is worked out per product
 * token (plans/research/web-fetch-deep-dive.md RB-7).
 */
export class RobotsCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Outcome>>();
  private readonly ttlMs: number;
  private readonly unreachableRetryMs: number;
  private readonly unreachableGiveUpMs: number | null;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly maxEntries: number;

  constructor(options: RobotsCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? ROBOTS_CACHE_TTL_MS;
    this.unreachableRetryMs =
      options.unreachableRetryMs ?? ROBOTS_UNREACHABLE_RETRY_MS;
    this.unreachableGiveUpMs =
      options.unreachableGiveUpMs === undefined
        ? ROBOTS_UNREACHABLE_GIVE_UP_MS
        : options.unreachableGiveUpMs;
    // RFC 9309§2.5¶1: the limit "MUST be at least 500 kibibytes"
    this.maxBytes = Math.max(
      options.maxBytes ?? ROBOTS_PARSE_LIMIT_BYTES,
      500 * 1024,
    );
    this.maxRedirects = options.maxRedirects ?? ROBOTS_MAX_REDIRECTS;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  async verdict(
    rawUrl: string | URL,
    productToken: string,
    fetcher: RobotsFetcher,
    now: number = Date.now(),
  ): Promise<RobotsVerdict> {
    if (!isValidProductToken(productToken)) {
      throw new TypeError(
        `Not a robots.txt product token (letters, "_" and "-" only): ${productToken}`,
      );
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`robots.txt applies to http and https URLs only`);
    }
    const { authority, href } = robotsTxtUrl(url);

    // RFC 9309§2.2.2¶2: "The /robots.txt URI is implicitly allowed."
    if (url.pathname === "/robots.txt") {
      return {
        allowed: true,
        reason: "robots-txt",
        robotsUrl: href,
        fetchedAt: now,
        fromCache: true,
      };
    }

    let entry = this.entries.get(authority);
    let fromCache = true;
    if (this.needsFetch(entry, now)) {
      fromCache = false;
      const outcome = await this.fetchOnce(authority, href, fetcher);
      entry = this.record(authority, outcome, now);
    }
    return this.verdictFrom(entry!, url, productToken, href, now, fromCache);
  }

  private needsFetch(entry: Entry | undefined, now: number): boolean {
    if (!entry) return true;
    if (entry.unreachable) {
      return now - entry.unreachable.lastTried >= this.unreachableRetryMs;
    }
    return !entry.good || now - entry.good.fetchedAt >= this.ttlMs;
  }

  /** One request per authority at a time; concurrent callers share it. */
  private fetchOnce(
    authority: string,
    href: string,
    fetcher: RobotsFetcher,
  ): Promise<Outcome> {
    const running = this.inFlight.get(authority);
    if (running) return running;
    const promise = fetchOutcome(
      href,
      fetcher,
      this.maxBytes,
      this.maxRedirects,
    ).finally(() => this.inFlight.delete(authority));
    this.inFlight.set(authority, promise);
    return promise;
  }

  private record(authority: string, outcome: Outcome, now: number): Entry {
    const previous = this.entries.get(authority);
    const entry: Entry =
      outcome.kind === "unreachable"
        ? {
            ...(previous?.good ? { good: previous.good } : {}),
            unreachable: {
              since: previous?.unreachable?.since ?? now,
              lastTried: now,
              ...(outcome.status === undefined
                ? {}
                : { status: outcome.status }),
            },
          }
        : { good: { outcome, fetchedAt: now } };
    // Re-insert so the Map's order is least recently fetched first
    this.entries.delete(authority);
    this.entries.set(authority, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry;
  }

  private verdictFrom(
    entry: Entry,
    url: URL,
    productToken: string,
    robotsUrl: string,
    now: number,
    fromCache: boolean,
  ): RobotsVerdict {
    if (entry.unreachable) {
      // RFC 9309§2.4¶1 lets an older copy stand while the file is
      // unreachable, and §2.3.1.4¶2 lets the crawler "continue to use a
      // cached copy". With one, it is used and marked stale.
      if (entry.good) {
        return {
          ...this.fromOutcome(
            entry.good.outcome,
            url,
            productToken,
            robotsUrl,
            entry.good.fetchedAt,
            fromCache,
          ),
          stale: true,
        };
      }
      const status =
        entry.unreachable.status === undefined
          ? {}
          : { status: entry.unreachable.status };
      if (
        this.unreachableGiveUpMs !== null &&
        now - entry.unreachable.since >= this.unreachableGiveUpMs
      ) {
        // RFC 9309§2.3.1.4¶2: after a long time the crawler "MAY assume
        // that the robots.txt file is unavailable"
        return {
          allowed: true,
          reason: "unreachable-expired",
          robotsUrl,
          ...status,
          fetchedAt: entry.unreachable.lastTried,
          fromCache,
        };
      }
      return {
        allowed: false,
        reason: "unreachable",
        robotsUrl,
        ...status,
        fetchedAt: entry.unreachable.lastTried,
        fromCache,
      };
    }
    return this.fromOutcome(
      entry.good!.outcome,
      url,
      productToken,
      robotsUrl,
      entry.good!.fetchedAt,
      fromCache,
    );
  }

  private fromOutcome(
    outcome: Outcome,
    url: URL,
    productToken: string,
    robotsUrl: string,
    fetchedAt: number,
    fromCache: boolean,
  ): RobotsVerdict {
    const status =
      outcome.status === undefined ? {} : { status: outcome.status };
    const base = { robotsUrl, ...status, fetchedAt, fromCache };
    if (outcome.kind === "parsed") {
      return verdictFromRobots(outcome.robots, url, productToken, base);
    }
    // "unreachable" never reaches here: it is not kept as a good outcome
    return {
      ...base,
      allowed: true,
      reason:
        outcome.kind === "unavailable" && outcome.tooManyRedirects
          ? "too-many-redirects"
          : "unavailable",
    };
  }
}

/** The cache the crawler and the fetch tool share in one process. */
export const sharedRobotsCache = new RobotsCache();

/**
 * Whether `productToken` may fetch `url` by the site's robots.txt.
 *
 * `fetcher` makes the robots.txt requests (one GET, no redirect following:
 * this function follows up to five). `now` is the time to judge the cache
 * by. The verdict says why (`reason`), which rule decided (`matchedRule`),
 * and records the group's `Crawl-delay` and any AIPREF `Content-Usage`
 * without acting on them.
 *
 * An unreachable file is a disallow here, as RFC 9309§2.3.1.4 asks of a
 * crawler. The fetch tool reads `reason: "unreachable"` and proceeds with a
 * label instead (RB-6); that is the caller's decision, not this module's.
 */
export function robotsVerdict(
  url: string | URL,
  productToken: string,
  fetcher: RobotsFetcher,
  now: number = Date.now(),
  cache: RobotsCache = sharedRobotsCache,
): Promise<RobotsVerdict> {
  return cache.verdict(url, productToken, fetcher, now);
}

/** A fetch-like function: enough of `fetch` for `robotsFetcherFromFetch`. */
export type FetchLike = (
  url: string,
  init: { method: "GET"; redirect: "manual"; headers?: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body?: unknown;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * A `RobotsFetcher` over a fetch-like function, reading at most `maxBytes`
 * of the body when the body is a web stream. For WB19/WB20, which pass the
 * shared guarded fetch here once WB22 lands.
 */
export function robotsFetcherFromFetch(fetchFn: FetchLike): RobotsFetcher {
  return async (url, { maxBytes }) => {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/plain" },
    });
    const location = res.headers.get("location");
    if (res.status < 200 || res.status >= 300) {
      return { status: res.status, location };
    }
    // One byte past the limit, so the parser can tell the file was cut
    return {
      status: res.status,
      location,
      body: await readCapped(res, maxBytes + 1),
    };
  };
}

async function readCapped(
  res: { body?: unknown; arrayBuffer(): Promise<ArrayBuffer> },
  maxBytes: number,
): Promise<Uint8Array> {
  const body = res.body as
    { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | undefined;
  if (!body?.getReader) {
    return new Uint8Array(await res.arrayBuffer()).subarray(0, maxBytes);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, out.length - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= out.length) break;
  }
  return out;
}
