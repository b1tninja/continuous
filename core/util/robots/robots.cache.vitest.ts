/**
 * Fetching robots.txt (RFC 9309§2.3): status classes, redirects, the cache
 * (§2.4) and the parse limit (§2.5). No network: every fetcher is a stub.
 */
import { describe, expect, it, vi } from "vitest";

import {
  parseRobotsTxt,
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_PARSE_LIMIT_BYTES,
  ROBOTS_UNREACHABLE_GIVE_UP_MS,
  ROBOTS_UNREACHABLE_RETRY_MS,
  RobotsCache,
  robotsFetcherFromFetch,
  robotsVerdict,
  sharedRobotsCache,
  type RobotsFetcher,
  type RobotsFetchResult,
} from "./index";

const T0 = Date.UTC(2026, 10, 15, 12);
const HOUR = 60 * 60 * 1000;

/** A fetcher that answers from a table of URL -> response (or error). */
function stub(
  table: Record<string, RobotsFetchResult | Error>,
): RobotsFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const answer = table[url];
    if (answer === undefined) throw new Error(`no stub for ${url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as RobotsFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const ROBOTS = "https://example.com/robots.txt";
const ok = (body: string): RobotsFetchResult => ({ status: 200, body });
const DISALLOW_PRIVATE = ok("User-agent: *\nDisallow: /private\n");

describe("access results (RFC 9309§2.3.1)", () => {
  it.each([
    // [status, allowed, reason]
    [200, false, "disallowed-by-rule"],
    // §2.3.1.3: 4xx is "unavailable", any resource may be accessed
    [400, true, "unavailable"],
    [401, true, "unavailable"],
    [403, true, "unavailable"],
    [404, true, "unavailable"],
    [410, true, "unavailable"],
    // 429 is a server refusing service for now: read as unreachable
    [429, false, "unreachable"],
    // §2.3.1.4: 5xx is "unreachable", complete disallow
    [500, false, "unreachable"],
    [502, false, "unreachable"],
    [503, false, "unreachable"],
    [599, false, "unreachable"],
    // A redirect with no Location, and a status outside the classes
    [301, false, "unreachable"],
    [100, false, "unreachable"],
  ])("status %i -> allowed %s (%s)", async (status, allowed, reason) => {
    const fetcher = stub({
      [ROBOTS]:
        status === 200 ? DISALLOW_PRIVATE : { status, body: "Disallow: /" },
    });
    const verdict = await new RobotsCache().verdict(
      "https://example.com/private/page",
      "Continuous-Crawler",
      fetcher,
      T0,
    );
    expect(verdict).toMatchObject({ allowed, reason, status });
  });

  it("a network error is unreachable: complete disallow (§2.3.1.4¶1)", async () => {
    const verdict = await new RobotsCache().verdict(
      "https://example.com/public",
      "bot",
      stub({ [ROBOTS]: new Error("ECONNREFUSED") }),
      T0,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: "unreachable" });
    expect(verdict.status).toBeUndefined();
  });

  it("reports the matched rule and the group", async () => {
    const verdict = await new RobotsCache().verdict(
      "https://example.com/private/x",
      "bot",
      stub({ [ROBOTS]: DISALLOW_PRIVATE }),
      T0,
    );
    expect(verdict).toEqual({
      allowed: false,
      reason: "disallowed-by-rule",
      matchedRule: { kind: "disallow", pattern: "/private", line: 2 },
      group: ["*"],
      robotsUrl: ROBOTS,
      status: 200,
      fetchedAt: T0,
      fromCache: false,
    });
  });

  it("never fetches for /robots.txt itself, which is implicitly allowed (§2.2.2¶2)", async () => {
    const fetcher = stub({});
    const verdict = await new RobotsCache().verdict(ROBOTS, "bot", fetcher, T0);
    expect(verdict).toMatchObject({ allowed: true, reason: "robots-txt" });
    expect(fetcher.calls).toEqual([]);
  });

  it("asks the authority of the URL, without userinfo, path or query (§2.3¶3)", async () => {
    const fetcher = stub({ "http://example.com:8080/robots.txt": ok("") });
    await new RobotsCache().verdict(
      "http://user:pw@EXAMPLE.com:8080/a/b?c=d#e",
      "bot",
      fetcher,
      T0,
    );
    expect(fetcher.calls).toEqual(["http://example.com:8080/robots.txt"]);
  });

  it("refuses a product token outside the RFC's characters (§2.2.1¶1)", async () => {
    await expect(
      new RobotsCache().verdict(
        "https://example.com/",
        "Bot/1.0",
        stub({}),
        T0,
      ),
    ).rejects.toThrow(/product token/);
  });

  it("refuses a URL that is not http or https", async () => {
    await expect(
      new RobotsCache().verdict("ftp://example.com/x", "bot", stub({}), T0),
    ).rejects.toThrow(/http and https/);
  });
});

describe("redirects (RFC 9309§2.3.1.2)", () => {
  const chain = (n: number, finalAnswer: RobotsFetchResult) => {
    const table: Record<string, RobotsFetchResult> = {};
    let url = ROBOTS;
    for (let i = 1; i <= n; i++) {
      const next = `https://cdn${i}.example.net/robots.txt`;
      table[url] = { status: i % 2 ? 301 : 302, location: next };
      url = next;
    }
    table[url] = finalAnswer;
    return stub(table);
  };

  it("follows five redirects across authorities and applies the file to the initial authority", async () => {
    const fetcher = chain(5, DISALLOW_PRIVATE);
    const cache = new RobotsCache();
    const verdict = await cache.verdict(
      "https://example.com/private",
      "bot",
      fetcher,
      T0,
    );
    expect(fetcher.calls).toHaveLength(6);
    expect(verdict).toMatchObject({
      allowed: false,
      reason: "disallowed-by-rule",
      robotsUrl: ROBOTS,
    });
    // Cached under example.com, not under the last hop
    await cache.verdict("https://example.com/other", "bot", fetcher, T0 + 1);
    expect(fetcher.calls).toHaveLength(6);
    expect(cache.size).toBe(1);
  });

  it("treats more than five redirects as unavailable (§2.3.1.2¶3)", async () => {
    const fetcher = chain(6, DISALLOW_PRIVATE);
    const verdict = await new RobotsCache().verdict(
      "https://example.com/private",
      "bot",
      fetcher,
      T0,
    );
    expect(fetcher.calls).toHaveLength(6);
    expect(verdict).toMatchObject({
      allowed: true,
      reason: "too-many-redirects",
    });
  });

  it("resolves a relative Location against the current URL", async () => {
    const fetcher = stub({
      [ROBOTS]: { status: 308, location: "/robots-en.txt" },
      "https://example.com/robots-en.txt": DISALLOW_PRIVATE,
    });
    const verdict = await new RobotsCache().verdict(
      "https://example.com/private",
      "bot",
      fetcher,
      T0,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("does not follow a redirect to another scheme", async () => {
    const fetcher = stub({
      [ROBOTS]: { status: 302, location: "file:///etc/passwd" },
    });
    const verdict = await new RobotsCache().verdict(
      "https://example.com/x",
      "bot",
      fetcher,
      T0,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: "unreachable" });
    expect(fetcher.calls).toEqual([ROBOTS]);
  });

  it("a redirect to a 404 is unavailable", async () => {
    const fetcher = stub({
      [ROBOTS]: { status: 301, location: "https://www.example.com/robots.txt" },
      "https://www.example.com/robots.txt": { status: 404 },
    });
    const verdict = await new RobotsCache().verdict(
      "https://example.com/x",
      "bot",
      fetcher,
      T0,
    );
    expect(verdict).toMatchObject({ allowed: true, reason: "unavailable" });
  });
});

describe("the cache (RFC 9309§2.4)", () => {
  it("reuses the file for 24 hours and fetches again after", async () => {
    const fetcher = stub({ [ROBOTS]: DISALLOW_PRIVATE });
    const cache = new RobotsCache();
    const url = "https://example.com/private";
    expect((await cache.verdict(url, "bot", fetcher, T0)).fromCache).toBe(
      false,
    );
    const later = await cache.verdict(
      url,
      "bot",
      fetcher,
      T0 + ROBOTS_CACHE_TTL_MS - 1,
    );
    expect(later).toMatchObject({ fromCache: true, fetchedAt: T0 });
    expect(fetcher.calls).toHaveLength(1);
    const dayLater = await cache.verdict(
      url,
      "bot",
      fetcher,
      T0 + ROBOTS_CACHE_TTL_MS,
    );
    expect(dayLater).toMatchObject({
      fromCache: false,
      fetchedAt: T0 + ROBOTS_CACHE_TTL_MS,
    });
    expect(fetcher.calls).toHaveLength(2);
  });

  it("caches a 4xx for 24 hours too", async () => {
    const fetcher = stub({ [ROBOTS]: { status: 404 } });
    const cache = new RobotsCache();
    await cache.verdict("https://example.com/a", "bot", fetcher, T0);
    await cache.verdict(
      "https://example.com/b",
      "bot",
      fetcher,
      T0 + 23 * HOUR,
    );
    expect(fetcher.calls).toHaveLength(1);
  });

  it("keeps one file per authority and judges each product token against it", async () => {
    const fetcher = stub({
      [ROBOTS]: ok(
        "User-agent: Continuous-Crawler\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
      ),
    });
    const cache = new RobotsCache();
    const url = "https://example.com/docs";
    const crawler = await cache.verdict(url, "Continuous-Crawler", fetcher, T0);
    const user = await cache.verdict(url, "Continuous-User", fetcher, T0);
    expect(crawler).toMatchObject({
      allowed: false,
      group: ["continuous-crawler"],
    });
    expect(user).toMatchObject({ allowed: true, group: ["*"] });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("separates authorities by scheme, host and port", async () => {
    const fetcher = stub({
      [ROBOTS]: ok(""),
      "http://example.com/robots.txt": ok(""),
      "https://example.com:8443/robots.txt": ok(""),
      "https://www.example.com/robots.txt": ok(""),
    });
    const cache = new RobotsCache();
    for (const url of [
      "https://example.com/",
      "https://example.com:443/x",
      "http://example.com/",
      "https://example.com:8443/",
      "https://www.example.com/",
    ]) {
      await cache.verdict(url, "bot", fetcher, T0);
    }
    expect(fetcher.calls).toHaveLength(4);
  });

  it("shares one request between concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await gate;
      return DISALLOW_PRIVATE;
    });
    const cache = new RobotsCache();
    const pending = [1, 2, 3].map((i) =>
      cache.verdict(`https://example.com/private/${i}`, "bot", fetcher, T0),
    );
    release();
    const verdicts = await Promise.all(pending);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(verdicts.every((v) => !v.allowed)).toBe(true);
  });

  it("drops the oldest authority past its size", async () => {
    const cache = new RobotsCache({ maxEntries: 2 });
    const fetcher: RobotsFetcher = async () => ok("");
    for (const host of ["a", "b", "c"]) {
      await cache.verdict(`https://${host}.example/`, "bot", fetcher, T0);
    }
    expect(cache.size).toBe(2);
  });

  it("the shared cache serves robotsVerdict", async () => {
    sharedRobotsCache.clear();
    const fetcher = stub({
      "https://shared.example/robots.txt": DISALLOW_PRIVATE,
    });
    await robotsVerdict("https://shared.example/private", "bot", fetcher, T0);
    const second = await robotsVerdict(
      "https://shared.example/public",
      "other",
      fetcher,
      T0 + 1,
    );
    expect(second).toMatchObject({ allowed: true, fromCache: true });
    expect(fetcher.calls).toHaveLength(1);
    sharedRobotsCache.clear();
  });
});

describe("prolonged unreachability (RFC 9309§2.3.1.4¶2, §2.4¶1)", () => {
  it("retries an unreachable file after an hour, not before", async () => {
    const fetcher = stub({ [ROBOTS]: { status: 503 } });
    const cache = new RobotsCache();
    const url = "https://example.com/x";
    await cache.verdict(url, "bot", fetcher, T0);
    const soon = await cache.verdict(url, "bot", fetcher, T0 + HOUR - 1);
    expect(soon).toMatchObject({ allowed: false, fromCache: true });
    expect(fetcher.calls).toHaveLength(1);
    await cache.verdict(url, "bot", fetcher, T0 + HOUR);
    expect(fetcher.calls).toHaveLength(2);
    expect(ROBOTS_UNREACHABLE_RETRY_MS).toBe(HOUR);
  });

  it("keeps using an older copy while the file is unreachable, marked stale", async () => {
    const answers: (RobotsFetchResult | Error)[] = [
      DISALLOW_PRIVATE,
      { status: 500 },
      new Error("ETIMEDOUT"),
    ];
    const fetcher: RobotsFetcher = async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    };
    const cache = new RobotsCache();
    await cache.verdict("https://example.com/private", "bot", fetcher, T0);
    const t1 = T0 + ROBOTS_CACHE_TTL_MS + 1;
    const stale = await cache.verdict(
      "https://example.com/private",
      "bot",
      fetcher,
      t1,
    );
    expect(stale).toMatchObject({
      allowed: false,
      reason: "disallowed-by-rule",
      stale: true,
      fetchedAt: T0,
    });
    const publicPage = await cache.verdict(
      "https://example.com/public",
      "bot",
      fetcher,
      t1 + HOUR,
    );
    expect(publicPage).toMatchObject({ allowed: true, stale: true });
  });

  it("recovers when the file comes back", async () => {
    const answers: RobotsFetchResult[] = [{ status: 503 }, ok("")];
    const fetcher: RobotsFetcher = async () => answers.shift()!;
    const cache = new RobotsCache();
    await cache.verdict("https://example.com/x", "bot", fetcher, T0);
    const back = await cache.verdict(
      "https://example.com/x",
      "bot",
      fetcher,
      T0 + HOUR,
    );
    expect(back).toMatchObject({ allowed: true, reason: "no-group" });
    expect(back.stale).toBeUndefined();
  });

  it("treats a file unreachable for 30 days with no copy as unavailable", async () => {
    const fetcher = stub({ [ROBOTS]: { status: 503 } });
    const cache = new RobotsCache();
    const url = "https://example.com/x";
    await cache.verdict(url, "bot", fetcher, T0);
    const day29 = await cache.verdict(url, "bot", fetcher, T0 + 29 * 24 * HOUR);
    expect(day29).toMatchObject({ allowed: false, reason: "unreachable" });
    const day30 = await cache.verdict(
      url,
      "bot",
      fetcher,
      T0 + ROBOTS_UNREACHABLE_GIVE_UP_MS,
    );
    expect(day30).toMatchObject({
      allowed: true,
      reason: "unreachable-expired",
      status: 503,
    });
  });

  it("can be told never to give up", async () => {
    const fetcher = stub({ [ROBOTS]: new Error("ENOTFOUND") });
    const cache = new RobotsCache({ unreachableGiveUpMs: null });
    await cache.verdict("https://example.com/x", "bot", fetcher, T0);
    const later = await cache.verdict(
      "https://example.com/x",
      "bot",
      fetcher,
      T0 + 365 * 24 * HOUR,
    );
    expect(later.allowed).toBe(false);
  });
});

describe("size limit (RFC 9309§2.5)", () => {
  const padding = (bytes: number) => `# ${"x".repeat(bytes - 3)}\n`;

  it("reads at least 500 KiB: a rule just inside 512 KiB is honoured", () => {
    const head = "User-agent: *\n";
    const rule = "Disallow: /late\n";
    const file =
      head +
      padding(ROBOTS_PARSE_LIMIT_BYTES - head.length - rule.length) +
      rule;
    expect(new TextEncoder().encode(file).length).toBe(
      ROBOTS_PARSE_LIMIT_BYTES,
    );
    const robots = parseRobotsTxt(file);
    expect(robots.truncated).toBe(false);
    expect(robots.groups[0].rules.map((r) => r.raw)).toEqual(["/late"]);
  });

  it("ignores what lies past the limit, and never a rule cut in half", () => {
    const head = "User-agent: *\n";
    const file =
      head +
      padding(ROBOTS_PARSE_LIMIT_BYTES - head.length - 5) +
      "Disallow: /private-area\nDisallow: /after\n";
    const robots = parseRobotsTxt(file);
    expect(robots.truncated).toBe(true);
    expect(robots.bytesParsed).toBeLessThanOrEqual(ROBOTS_PARSE_LIMIT_BYTES);
    expect(robots.groups[0].rules).toEqual([]);
  });

  it("does not let a caller set the limit below 500 KiB", async () => {
    const seen: number[] = [];
    const cache = new RobotsCache({ maxBytes: 10 });
    await cache.verdict(
      "https://example.com/",
      "bot",
      async (_url, { maxBytes }) => {
        seen.push(maxBytes);
        return ok("");
      },
      T0,
    );
    expect(seen).toEqual([500 * 1024]);
  });

  it("robotsFetcherFromFetch stops reading a stream past the limit", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x23); // "#"
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const fetchFn = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      body: stream,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    const fetcher = robotsFetcherFromFetch(fetchFn);
    const res = await fetcher(ROBOTS, { maxBytes: ROBOTS_PARSE_LIMIT_BYTES });
    expect(fetchFn).toHaveBeenCalledWith(ROBOTS, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/plain" },
    });
    expect((res.body as Uint8Array).length).toBe(ROBOTS_PARSE_LIMIT_BYTES + 1);
    expect(pulled).toBeLessThan(ROBOTS_PARSE_LIMIT_BYTES + 3 * chunk.length);
  });

  it("robotsFetcherFromFetch passes a redirect's Location back without reading the body", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fetcher = robotsFetcherFromFetch(async () => ({
      status: 301,
      headers: {
        get: (n: string) =>
          n === "location" ? "https://b.example/robots.txt" : null,
      },
      arrayBuffer,
    }));
    expect(await fetcher(ROBOTS, { maxBytes: 1 })).toEqual({
      status: 301,
      location: "https://b.example/robots.txt",
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("recorded, not acted on", () => {
  it("returns Crawl-delay and Content-Usage with the verdict", async () => {
    const fetcher = stub({
      [ROBOTS]: ok(
        "Content-Usage: train-ai=n\nUser-agent: *\nCrawl-delay: 3\nContent-Usage: ai-use=n\n",
      ),
    });
    const verdict = await new RobotsCache().verdict(
      "https://example.com/page",
      "Continuous-User",
      fetcher,
      T0,
    );
    expect(verdict).toMatchObject({
      allowed: true,
      reason: "no-matching-rule",
      crawlDelaySeconds: 3,
      contentUsage: ["train-ai=n", "ai-use=n"],
    });
  });
});
