import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { setHostResolver } from "../../util/networkAddress";
import { resetWebConfigForTests, resolveWebConfig } from "../../util/webConfig";
import {
  hitsFromResults,
  queryWithSite,
  WEB_SEARCH_TEST_QUERY,
  WebSearchError,
  type WebSearchContext,
  type WebSearchProvider,
} from "./provider";
import {
  availableWebSearchProviders,
  isWebSearchConfigured,
  registerWebSearchProvider,
  runWebSearch,
  selectWebSearch,
  WebSearchNotConfiguredError,
} from "./registry";

/**
 * WB53: the provider layer. Every request is answered by a table here
 * (fixture JSON), through the real guard: nothing leaves the machine.
 */

const guarded = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../util/guardedFetch", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../util/guardedFetch")>();
  return {
    ...real,
    guardedWebRequest: vi.fn(async (url: URL, options: any) => {
      guarded.calls.push(url.toString());
      return real.guardedWebRequest(url, options);
    }),
  };
});

type Sent = {
  url: URL;
  init: { method?: string; headers?: Record<string, string>; body?: string };
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const bytes = new TextEncoder().encode(
    typeof body === "string" ? body : JSON.stringify(body),
  );
  const lower: Record<string, string> = {
    "content-type": "application/json",
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
  };
}

/** A fetch that records what was sent and answers from `respond`. */
function fixtureFetch(respond: (url: URL, sent: Sent) => unknown) {
  const sent: Sent[] = [];
  const fetchFn = vi.fn(async (url: URL | string, init: any) => {
    const s = { url: new URL(String(url)), init: init ?? {} };
    sent.push(s);
    return respond(s.url, s);
  });
  return { sent, fetchFn: fetchFn as never };
}

/** A SearXNG reply, as a real instance gives it (fields trimmed). */
const SEARXNG_FIXTURE = {
  query: "asyncio taskgroup",
  number_of_results: 0,
  results: [
    {
      url: "https://docs.python.org/3/library/asyncio-task.html#task-groups",
      title: "Coroutines and Tasks — Python 3 documentation",
      content: "An asynchronous context manager holding a group of tasks.",
      engine: "duckduckgo",
      publishedDate: "2026-10-07T00:00:00",
      score: 1.5,
    },
    {
      url: "https://peps.python.org/pep-0654/",
      title: "PEP 654 – Exception Groups and except*",
      content: "This document proposes language extensions.",
      engine: "brave",
    },
    {
      url: "https://example.com/third",
      title: "Third",
      content: "third",
    },
  ],
  answers: [],
  suggestions: [],
};

/** The custom POST shape: Claude Desktop's `custom` search server reply. */
const CUSTOM_POST_FIXTURE = {
  results: [
    {
      title: "Release notes 4.2",
      url: "https://intranet.example/notes/4.2",
      snippet: "Breaking: the config loader now refuses inline keys.",
    },
  ],
};

const ctx = (fetchFn: never): WebSearchContext => ({
  fetchFn,
  userAgent: "Continuous-User/2.28",
  limits: { maxBytes: 1 << 20, deadlineMs: 5000 },
});

const resolved = (search: unknown, other?: unknown) =>
  resolveWebConfig({ user: { search }, other }).config;

beforeAll(() => setHostResolver(async () => ["93.184.215.14"]));
afterAll(() => setHostResolver(undefined));
beforeEach(() => {
  guarded.calls.length = 0;
  resetWebConfigForTests("/nonexistent/continuous-test/config.yaml");
});
afterEach(() => resetWebConfigForTests());

describe("selection (SP-1, SR-1, SR-2, SR-6)", () => {
  it("is off by default: nothing set means no provider, no tool, no request", async () => {
    const config = resolveWebConfig().config;
    expect(selectWebSearch(config)).toMatchObject({ state: "off" });
    expect(isWebSearchConfigured(config)).toBe(false);
    const { fetchFn, sent } = fixtureFetch(() => json({ results: [] }));
    await expect(
      runWebSearch({ query: "q" }, ctx(fetchFn), selectWebSearch(config)),
    ).rejects.toBeInstanceOf(WebSearchNotConfiguredError);
    expect(sent).toEqual([]);
    expect(guarded.calls).toEqual([]);
  });

  it("with no file and no variable, the process-wide check is off too", () => {
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "");
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_KEY", "");
    try {
      expect(isWebSearchConfigured()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads a url with no provider as searxng (as before WB53)", () => {
    const s = selectWebSearch(resolved({ url: "http://127.0.0.1:8888" }));
    expect(s.state).toBe("ready");
    if (s.state !== "ready") return;
    expect(s.provider.id).toBe("searxng");
    expect(s.provider.destination.href).toBe("http://127.0.0.1:8888/");
    expect(s.maxResults).toBe(5);
  });

  it("is off with provider: off, or web.enabled: false, from any config", () => {
    expect(
      selectWebSearch(resolved({ provider: "off", url: "http://a.example" }))
        .state,
    ).toBe("off");
    expect(
      selectWebSearch(
        resolved({ url: "http://a.example" }, { search: { provider: "off" } }),
      ).state,
    ).toBe("off");
    expect(
      selectWebSearch(
        resolveWebConfig({
          user: { search: { url: "http://a.example" } },
          other: { enabled: false },
        }).config,
      ).state,
    ).toBe("off");
  });

  it("ignores a provider a workspace names, with a notice", () => {
    const { config, notices } = resolveWebConfig({
      other: {
        search: { provider: "custom", url: "https://collector.example" },
      },
    });
    expect(selectWebSearch(config).state).toBe("off");
    expect(notices.some((n) => n.includes("web.search.provider"))).toBe(true);
    expect(notices.some((n) => n.includes("web.search.url"))).toBe(true);
  });

  it("reads an unknown provider as off, and a known one without an adapter as off with a reason", () => {
    const unknown = selectWebSearch(
      resolved({ provider: "bing", url: "http://a.example" }),
    );
    expect(unknown).toMatchObject({ state: "unavailable" });
    expect((unknown as { reason: string }).reason).toMatch(
      /not a known search provider/,
    );
    const later = selectWebSearch(resolved({ provider: "brave" }));
    expect((later as { reason: string }).reason).toMatch(
      /not available in this build yet/,
    );
  });

  it("explains native with no fallback, and uses the fallback when set", () => {
    const only = selectWebSearch(resolved({ provider: "native" }));
    expect(only.state).toBe("native-only");
    expect((only as { reason: string }).reason).toMatch(
      /web\.search\.fallback/,
    );
    const withFallback = selectWebSearch(
      resolved({
        provider: "native",
        fallback: "searxng",
        fallbackUrl: "http://127.0.0.1:8888/search",
      }),
    );
    expect(withFallback).toMatchObject({ state: "ready", via: "fallback" });
  });

  it("refuses an endpoint that is not http(s) or carries a password", () => {
    for (const url of [
      "ftp://x.example/s",
      "nope",
      "https://me:pw@x.example/",
    ]) {
      expect(selectWebSearch(resolved({ url })).state).toBe("unavailable");
    }
  });

  it("builds searxng and custom in this row", () => {
    expect(availableWebSearchProviders().sort()).toEqual(["custom", "searxng"]);
  });
});

describe("the provider interface", () => {
  function mockProvider(): WebSearchProvider & { seen: unknown[] } {
    const seen: unknown[] = [];
    return {
      id: "mock",
      label: "Mock",
      destination: new URL("https://mock.example/"),
      seen,
      async search(query) {
        seen.push(query);
        return {
          provider: "mock",
          host: "mock.example",
          hits: Array.from({ length: query.maxResults }, (_, i) => ({
            title: `t${i}`,
            url: `https://mock.example/${i}`,
            snippet: "",
          })),
          filters: {},
        };
      },
      async test() {
        return { ok: true, count: 1, latencyMs: 0 };
      },
    };
  }

  it("a registered provider answers runWebSearch with the query and filters", async () => {
    const provider = mockProvider();
    const remove = registerWebSearchProvider("custom", () => provider);
    try {
      const sel = selectWebSearch(
        resolved({ provider: "custom", url: "https://x.example" }),
      );
      const out = await runWebSearch(
        { query: "q", freshness: "week", site: "docs.python.org" },
        ctx(vi.fn() as never),
        sel,
      );
      expect(provider.seen).toEqual([
        {
          query: "q",
          freshness: "week",
          site: "docs.python.org",
          maxResults: 5,
        },
      ]);
      expect(out.hits).toHaveLength(5);
    } finally {
      remove();
    }
    expect(availableWebSearchProviders()).toContain("custom");
  });

  it("never asks for more than web.search.maxResults, from either side", async () => {
    const provider = mockProvider();
    const remove = registerWebSearchProvider("searxng", () => provider);
    try {
      const sel = selectWebSearch(
        resolved(
          { url: "https://x.example", maxResults: 8 },
          { search: { maxResults: 3 } },
        ),
      );
      await runWebSearch(
        { query: "q", maxResults: 6 },
        ctx(vi.fn() as never),
        sel,
      );
      await runWebSearch(
        { query: "q", maxResults: 2 },
        ctx(vi.fn() as never),
        sel,
      );
      expect(provider.seen.map((q: any) => q.maxResults)).toEqual([3, 2]);
    } finally {
      remove();
    }
  });

  it("a factory error becomes the reason", () => {
    const remove = registerWebSearchProvider("searxng", () => ({
      error: "broken on purpose",
    }));
    try {
      expect(
        selectWebSearch(resolved({ url: "https://x.example" })),
      ).toMatchObject({
        state: "unavailable",
        reason: "Web search is off: broken on purpose.",
      });
    } finally {
      remove();
    }
  });

  it("puts site: into the query only for a plain host name", () => {
    expect(queryWithSite("q", "docs.python.org")).toEqual({
      q: "q site:docs.python.org",
      site: "query",
    });
    expect(queryWithSite("q", "a b OR site:evil")).toEqual({
      q: "q",
      site: "ignored",
    });
    expect(queryWithSite("q", undefined)).toEqual({ q: "q" });
  });

  it("reads both reply shapes and nothing else", () => {
    expect(hitsFromResults(SEARXNG_FIXTURE, 1)).toEqual([
      {
        title: "Coroutines and Tasks — Python 3 documentation",
        url: "https://docs.python.org/3/library/asyncio-task.html#task-groups",
        snippet: "An asynchronous context manager holding a group of tasks.",
        published: "2026-10-07T00:00:00",
      },
    ]);
    expect(hitsFromResults(CUSTOM_POST_FIXTURE, 5)[0].snippet).toMatch(
      /^Breaking/,
    );
    expect(hitsFromResults({ nope: 1 }, 5)).toEqual([]);
    expect(hitsFromResults({ results: ["x", null] }, 5)).toEqual([]);
  });
});

describe("SearXNG against fixture JSON", () => {
  const select = (search: Record<string, unknown> = {}) =>
    selectWebSearch(
      resolved({ url: "https://search.example/search", ...search }),
    );

  it("sends GET ?q&format=json with the bearer key and the search User-Agent, through the guard", async () => {
    const { fetchFn, sent } = fixtureFetch(() => json(SEARXNG_FIXTURE));
    const out = await runWebSearch(
      { query: "asyncio taskgroup", maxResults: 2 },
      ctx(fetchFn),
      select({ apiKey: "${{ secrets.SEARXNG_SEARCH_KEY }}" }),
    );
    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent;
    expect(url.origin + url.pathname).toBe("https://search.example/search");
    expect([...url.searchParams.entries()]).toEqual([
      ["q", "asyncio taskgroup"],
      ["format", "json"],
    ]);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({
      Accept: "application/json",
      "User-Agent": "Continuous-User/2.28",
      Authorization: "Bearer ${{ secrets.SEARXNG_SEARCH_KEY }}",
    });
    expect(guarded.calls).toEqual([url.toString()]);
    expect(out).toMatchObject({
      provider: "searxng",
      host: "search.example",
      filters: {},
    });
    expect(out.hits.map((h) => h.url)).toEqual([
      "https://docs.python.org/3/library/asyncio-task.html#task-groups",
      "https://peps.python.org/pep-0654/",
    ]);
  });

  it("maps freshness to time_range, site into the query, and safeSearch only when set", async () => {
    const { fetchFn, sent } = fixtureFetch(() => json(SEARXNG_FIXTURE));
    const out = await runWebSearch(
      { query: "TaskGroup", freshness: "month", site: "docs.python.org" },
      ctx(fetchFn),
      select({ safeSearch: "strict" }),
    );
    const params = Object.fromEntries(sent[0].url.searchParams);
    expect(params).toEqual({
      q: "TaskGroup site:docs.python.org",
      format: "json",
      time_range: "month",
      safesearch: "2",
    });
    expect(out.filters).toEqual({ freshness: "filter", site: "query" });
  });

  it("names 403 as JSON not enabled and 401 as a rejected key, and never quotes the body", async () => {
    for (const [status, kind] of [
      [403, "not-enabled"],
      [401, "auth-failed"],
      [429, "rate-limited"],
      [500, "backend-error"],
    ] as const) {
      const { fetchFn } = fixtureFetch(() =>
        json("internal detail 1234", status),
      );
      const err = await runWebSearch(
        { query: "q" },
        ctx(fetchFn),
        select(),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(WebSearchError);
      expect(err).toMatchObject({ kind, status });
      expect(err.message).toBe(`Web search failed (HTTP ${status})`);
      expect(err.message).not.toContain("1234");
    }
  });

  it("refuses a reply that is not JSON", async () => {
    const { fetchFn } = fixtureFetch(() => json("<html>captcha</html>"));
    await expect(
      runWebSearch({ query: "q" }, ctx(fetchFn), select()),
    ).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("goes through the guard: a redirect to the metadata address is refused", async () => {
    const { fetchFn, sent } = fixtureFetch((u) =>
      u.host === "search.example"
        ? json("", 302, { location: "http://169.254.169.254/latest/" })
        : json(SEARXNG_FIXTURE),
    );
    await expect(
      runWebSearch({ query: "q" }, ctx(fetchFn), select({ apiKey: "k" })),
    ).rejects.toThrow(/non-public address/);
    expect(sent.map((s) => s.url.host)).toEqual(["search.example"]);
  });

  it("test() sends the fixed query and reports the count", async () => {
    const { fetchFn, sent } = fixtureFetch(() => json(SEARXNG_FIXTURE));
    const s = select();
    if (s.state !== "ready") throw new Error("not ready");
    const result = await s.provider.test(ctx(fetchFn));
    expect(result).toMatchObject({ ok: true, count: 1 });
    expect(sent[0].url.searchParams.get("q")).toBe(WEB_SEARCH_TEST_QUERY);
    const failing = fixtureFetch(() => json("", 403));
    expect(await s.provider.test(ctx(failing.fetchFn))).toMatchObject({
      ok: false,
      kind: "not-enabled",
      status: 403,
    });
  });
});

describe("custom endpoint against fixture JSON", () => {
  it("GET is the SearXNG shape, without SearXNG's 403 meaning", async () => {
    const { fetchFn, sent } = fixtureFetch(() => json(SEARXNG_FIXTURE));
    const sel = selectWebSearch(
      resolved({ provider: "custom", url: "https://intranet.example/s" }),
    );
    const out = await runWebSearch(
      { query: "q", maxResults: 1 },
      ctx(fetchFn),
      sel,
    );
    expect(out.provider).toBe("custom");
    expect(sent[0].url.searchParams.get("format")).toBe("json");
    expect(out.hits).toHaveLength(1);
    const forbidden = fixtureFetch(() => json("", 403));
    await expect(
      runWebSearch({ query: "q" }, ctx(forbidden.fetchFn), sel),
    ).rejects.toMatchObject({ kind: "auth-failed" });
  });

  it("POST sends {q} as JSON and reads the snippet shape", async () => {
    const { fetchFn, sent } = fixtureFetch(() => json(CUSTOM_POST_FIXTURE));
    const sel = selectWebSearch(
      resolved({
        provider: "custom",
        url: "https://intranet.example/search",
        apiKey: "${{ secrets.CUSTOM_SEARCH_KEY }}",
        custom: { method: "POST" },
      }),
    );
    const out = await runWebSearch(
      { query: "loader", freshness: "day", site: "intranet.example" },
      ctx(fetchFn),
      sel,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].url.href).toBe("https://intranet.example/search");
    expect(sent[0].init.method).toBe("POST");
    expect(JSON.parse(sent[0].init.body!)).toEqual({
      q: "loader site:intranet.example",
    });
    expect(sent[0].init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer ${{ secrets.CUSTOM_SEARCH_KEY }}",
    });
    expect(out.filters).toEqual({ freshness: "ignored", site: "query" });
    expect(out.hits).toEqual([
      {
        title: "Release notes 4.2",
        url: "https://intranet.example/notes/4.2",
        snippet: "Breaking: the config loader now refuses inline keys.",
      },
    ]);
    expect(guarded.calls).toEqual(["https://intranet.example/search"]);
  });

  it("drops the key when the endpoint redirects to another origin", async () => {
    const { fetchFn, sent } = fixtureFetch((u) =>
      u.host === "intranet.example"
        ? json("", 307, { location: "https://other.example/search" })
        : json(CUSTOM_POST_FIXTURE),
    );
    const sel = selectWebSearch(
      resolved({
        provider: "custom",
        url: "https://intranet.example/search",
        apiKey: "k",
        custom: { method: "POST" },
      }),
    );
    await runWebSearch({ query: "q" }, ctx(fetchFn), sel);
    expect(sent[0].init.headers?.Authorization).toBe("Bearer k");
    expect(sent[1].url.host).toBe("other.example");
    expect(sent[1].init.headers?.Authorization).toBeUndefined();
  });
});
