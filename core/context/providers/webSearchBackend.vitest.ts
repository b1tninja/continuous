import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";

import { getConfigDependentToolDefinitions } from "../../tools";
import { selectWebSearch } from "../../tools/webSearch/registry";
import { setHostResolver } from "../../util/networkAddress";
import { resetWebConfigForTests, resolveWebConfig } from "../../util/webConfig";
import { contextProviderClassFromName } from ".";
import {
  fetchSearchResults,
  isWebSearchConfigured,
  webSearchUnavailableReason,
} from "./webSearchBackend";

beforeAll(() => setHostResolver(async () => ["93.184.215.14"]));
afterAll(() => setHostResolver(undefined));
beforeEach(() =>
  resetWebConfigForTests("/nonexistent/continuous-test/config.yaml"),
);
afterEach(() => {
  vi.unstubAllEnvs();
  resetWebConfigForTests();
});

function reply(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    text: async () => JSON.stringify(body),
  }));
}

const RESULTS = {
  results: [
    { title: "A", url: "https://a.example/", content: "aa" },
    { title: "B", url: "https://b.example/", content: "bb" },
  ],
};

test("no backend unless the URL is set to http(s)", () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "");
  expect(isWebSearchConfigured()).toBe(false);
  for (const env of [
    { CONTINUOUS_WEB_SEARCH_URL: " " },
    { CONTINUOUS_WEB_SEARCH_URL: "ftp://x.example/s" },
    { CONTINUOUS_WEB_SEARCH_URL: "nope" },
  ]) {
    expect(isWebSearchConfigured(resolveWebConfig({ env }).config)).toBe(false);
  }
});

test("@web and search_web are hidden by default, and offered once a provider is set", async () => {
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "");
  const params = {
    rules: [],
    modelName: "gpt-4",
    enableExperimentalTools: false,
    isRemote: true,
    ide: {} as never,
  };
  expect(contextProviderClassFromName("web")).toBeUndefined();
  const names = async () =>
    (await getConfigDependentToolDefinitions(params)).map(
      (t) => t.function.name,
    );
  expect(await names()).not.toContain("search_web");
  vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://s.example.org/search");
  expect(contextProviderClassFromName("web")).toBeDefined();
  expect(await names()).toContain("search_web");
});

test("explains why @web is not offered", () => {
  expect(
    webSearchUnavailableReason(selectWebSearch(resolveWebConfig().config)),
  ).toMatch(/until you pick a provider/);
  expect(
    webSearchUnavailableReason(
      selectWebSearch(
        resolveWebConfig({ user: { search: { provider: "native" } } }).config,
      ),
    ),
  ).toMatch(/model's own search/);
});

test("queries only the configured endpoint, key as bearer, no identifying headers", async () => {
  const fetchFn = reply(RESULTS);
  const selection = selectWebSearch(
    resolveWebConfig({
      env: {
        CONTINUOUS_WEB_SEARCH_URL: "https://s.example.org/search",
        CONTINUOUS_WEB_SEARCH_KEY: "k",
      },
    }).config,
  );
  const items = await fetchSearchResults("hello", 1, fetchFn as any, {
    selection,
    version: "2.28.4",
  });
  expect(items).toEqual([
    { name: "A", description: "https://a.example/", content: "aa" },
  ]);
  const [url, init] = fetchFn.mock.calls[0] as any;
  expect(url.origin).toBe("https://s.example.org");
  expect(url.searchParams.get("q")).toBe("hello");
  expect(init.headers).toEqual({
    Accept: "application/json",
    "User-Agent": "Continuous-User/2.28",
    Authorization: "Bearer k",
  });
});

test("the old variables and web.search.url give identical requests", async () => {
  const run = async (inputs: Parameters<typeof resolveWebConfig>[0]) => {
    const fetchFn = reply(RESULTS);
    await fetchSearchResults("same query", undefined, fetchFn as any, {
      selection: selectWebSearch(resolveWebConfig(inputs).config),
    });
    const [url, init] = fetchFn.mock.calls[0] as any;
    return { url: String(url), method: init.method, headers: init.headers };
  };
  const fromEnv = await run({
    env: {
      CONTINUOUS_WEB_SEARCH_URL: "http://127.0.0.1:8888/search",
      CONTINUOUS_WEB_SEARCH_KEY: "k",
    },
  });
  const fromConfig = await run({
    user: { search: { url: "http://127.0.0.1:8888/search", apiKey: "k" } },
  });
  const fromProvider = await run({
    user: {
      search: {
        provider: "searxng",
        url: "http://127.0.0.1:8888/search",
        apiKey: "k",
      },
    },
  });
  expect(fromConfig).toEqual(fromEnv);
  expect(fromProvider).toEqual(fromEnv);
});

test("throws when not configured and on HTTP errors", async () => {
  const unused = vi.fn();
  await expect(
    fetchSearchResults("q", 1, unused as any, {
      selection: selectWebSearch(resolveWebConfig().config),
    }),
  ).rejects.toThrow(/off until you pick a provider/);
  expect(unused).not.toHaveBeenCalled();
  const bad = vi.fn(async () => ({
    ok: false,
    status: 500,
    headers: new Map(),
    text: async () => "boom: internal detail",
  }));
  const err = await fetchSearchResults("q", 1, bad as any, {
    selection: selectWebSearch(
      resolveWebConfig({
        user: { search: { url: "https://s.example.org/search" } },
      }).config,
    ),
  }).catch((e: Error) => e);
  expect((err as Error).message).toMatch(/HTTP 500/);
  // the response body is never quoted
  expect((err as Error).message).not.toContain("boom");
});
