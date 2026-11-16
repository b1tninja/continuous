import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { setHostResolver } from "../../util/networkAddress";
import { contextProviderClassFromName } from ".";
import {
  fetchSearchResults,
  getWebSearchBackend,
  isWebSearchConfigured,
} from "./webSearchBackend";

beforeAll(() => setHostResolver(async () => ["93.184.215.14"]));
afterAll(() => setHostResolver(undefined));

test("no backend unless the URL is set to http(s)", () => {
  expect(getWebSearchBackend({})).toBeUndefined();
  expect(
    getWebSearchBackend({ CONTINUOUS_WEB_SEARCH_URL: " " }),
  ).toBeUndefined();
  expect(
    getWebSearchBackend({ CONTINUOUS_WEB_SEARCH_URL: "ftp://x.example/s" }),
  ).toBeUndefined();
  expect(isWebSearchConfigured({ CONTINUOUS_WEB_SEARCH_URL: "nope" })).toBe(
    false,
  );
});

test("@web is hidden by default", () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "");
  expect(contextProviderClassFromName("web")).toBeUndefined();
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://s.example.org/search");
  expect(contextProviderClassFromName("web")).toBeDefined();
  vi.unstubAllEnvs();
});

test("queries only the configured endpoint, key as bearer, no identifying headers", async () => {
  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    text: async () =>
      JSON.stringify({
        results: [
          { title: "A", url: "https://a.example/", content: "aa" },
          { title: "B", url: "https://b.example/", content: "bb" },
        ],
      }),
  }));
  const backend = getWebSearchBackend({
    CONTINUOUS_WEB_SEARCH_URL: "https://s.example.org/search",
    CONTINUOUS_WEB_SEARCH_KEY: "k",
  });
  const items = await fetchSearchResults("hello", 1, fetchFn as any, backend);
  expect(items).toEqual([
    { name: "A", description: "https://a.example/", content: "aa" },
  ]);
  const [url, init] = fetchFn.mock.calls[0] as any;
  expect(url.origin).toBe("https://s.example.org");
  expect(url.searchParams.get("q")).toBe("hello");
  expect(Object.keys(init.headers).sort()).toEqual([
    "Accept",
    "Authorization",
    "User-Agent",
  ]);
  expect(init.headers["User-Agent"]).toMatch(/^Continuous-User\/\d+\.\d+$/);
});

test("throws when not configured and on HTTP errors", async () => {
  await expect(
    fetchSearchResults("q", 1, vi.fn() as any, undefined),
  ).rejects.toThrow(/not configured/);
  const backend = getWebSearchBackend({
    CONTINUOUS_WEB_SEARCH_URL: "https://s.example.org/search",
  });
  const bad = vi.fn(async () => ({
    ok: false,
    status: 500,
    headers: new Map(),
    text: async () => "boom: internal detail",
  }));
  const err = await fetchSearchResults("q", 1, bad as any, backend).catch(
    (e: Error) => e,
  );
  expect((err as Error).message).toMatch(/HTTP 500/);
  // the response body is never quoted
  expect((err as Error).message).not.toContain("boom");
});
