import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  FAVICON_DEADLINE_MS,
  FAVICON_MAX_BYTES,
  getFaviconBase64,
} from "../../util/fetchFavicon";
import { getFetchLog, resetFetchLogForTests } from "../../util/fetchRecord";
import { setHostResolver } from "../../util/networkAddress";
import { resetWebConfigForTests } from "../../util/webConfig";

/**
 * WB23: `@url`, the favicon lookup, `@web` and `@google` get the fetch tool's
 * guard: every redirect hop checked, the global request headers kept off the
 * sites they name, byte caps and deadlines, and no response body in an error.
 * The shared client is replaced by a table of responses: nothing leaves the
 * machine.
 */

type Call = {
  url: string;
  init: { headers?: Record<string, string>; method?: string; body?: unknown };
  requestOptions: Record<string, unknown> | undefined;
};
const calls: Call[] = [];
let respond: (url: URL) => unknown;

vi.mock("@continuedev/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@continuedev/fetch")>()),
  fetchwithRequestOptions: vi.fn(
    async (url: URL | string, init: any, requestOptions: any) => {
      const u = new URL(String(url));
      calls.push({ url: u.toString(), init: init ?? {}, requestOptions });
      return respond(u);
    },
  ),
}));

const response = (
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
) => {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    text: vi.fn(async () => new TextDecoder().decode(bytes)),
    arrayBuffer: vi.fn(async () => bytes.slice().buffer),
  };
};

const GATEWAY_TOKEN = "Bearer gateway-token-for-the-model-endpoint";

/** A config whose top-level request options carry a gateway header. */
const config = {
  requestOptions: {
    headers: { Authorization: GATEWAY_TOKEN, "X-Gateway-Key": "gw-123" },
    proxy: "http://proxy.corp.example:3128",
  },
  modelsByRole: {
    chat: [{ apiBase: "https://gateway.example/v1" }],
  },
} as never;

function extras(fullInput = "") {
  return {
    config,
    fullInput,
    fetch: vi.fn(() => {
      throw new Error("extras.fetch carries the global headers: not used");
    }),
  } as never;
}

function expectNoGlobalHeaders() {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.requestOptions?.headers, call.url).toBeUndefined();
    const sent = JSON.stringify(call.init.headers ?? {});
    expect(sent).not.toContain("gateway-token");
    expect(sent).not.toContain("gw-123");
    expect(sent.toLowerCase()).not.toContain("cookie");
    // transport settings are kept
    expect(call.requestOptions?.proxy).toBe("http://proxy.corp.example:3128");
  }
}

beforeAll(() => setHostResolver(async () => ["93.184.215.14"]));
afterAll(() => {
  setHostResolver(undefined);
  resetWebConfigForTests();
});
beforeEach(() => {
  calls.length = 0;
  resetFetchLogForTests();
  // Never the developer's own config.yaml: the search provider comes from the environment here
  resetWebConfigForTests("/nonexistent/continuous-test/config.yaml");
});

describe("@url", () => {
  it("sends no global request header or cookie to the site the person names, favicon included", async () => {
    respond = (u) => {
      if (u.pathname === "/favicon.png") {
        return response(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          "content-type": "image/png",
        });
      }
      if (u.pathname === "/" && u.host === "site.example") {
        return response(
          200,
          '<html><head><link rel="icon" href="/favicon.png"></head></html>',
          { "content-type": "text/html", "set-cookie": "sid=abc" },
        );
      }
      if (u.pathname === "/page") {
        return response(302, "", {
          location: "https://site.example/page2",
          "set-cookie": "sid=abc",
        });
      }
      return response(200, "<html><body><p>Hello</p></body></html>", {
        "content-type": "text/html",
      });
    };
    const { default: URLContextProvider } =
      await import("./URLContextProvider");
    const items = await new URLContextProvider({}).getContextItems(
      "https://site.example/page",
      extras(),
    );
    expect(items[0].content).toContain("Hello");
    expect(items[0].icon).toMatch(/^data:image\/png;base64,/);
    expectNoGlobalHeaders();
    expect(calls.map((c) => c.url)).toEqual([
      "https://site.example/",
      "https://site.example/favicon.png",
      "https://site.example/page",
      "https://site.example/page2",
    ]);
  });

  it("refuses a public URL that redirects to the metadata address (169.254.169.254)", async () => {
    respond = (u) =>
      u.host === "site.example" && u.pathname === "/go"
        ? response(302, "", {
            location: "http://169.254.169.254/latest/meta-data/iam/",
          })
        : response(404, "");
    const { default: URLContextProvider } =
      await import("./URLContextProvider");
    await expect(
      new URLContextProvider({}).getContextItems(
        "https://site.example/go",
        extras(),
      ),
    ).rejects.toThrow(/non-public address \(169\.254\.169\.254/);
    expect(calls.some((c) => c.url.includes("169.254"))).toBe(false);
    const refused = getFetchLog()
      .list()
      .find((r) => r.purpose === "url");
    expect(refused?.outcome).toBe("refused");
  });

  it("an error says the status, not the error page", async () => {
    respond = (u) =>
      u.pathname === "/broken"
        ? response(500, "stack trace with internal hostnames", {
            "content-type": "text/html",
          })
        : response(404, "");
    const { default: URLContextProvider } =
      await import("./URLContextProvider");
    const err = await new URLContextProvider({})
      .getContextItems("https://site.example/broken", extras())
      .catch((e: Error) => e);
    expect((err as Error).message).toBe("HTTP 500 Error");
    expect((err as Error).message).not.toContain("stack trace");
  });

  it("starts the item with the provenance line", async () => {
    respond = (u) =>
      u.pathname === "/doc"
        ? response(200, "plain words", { "content-type": "text/plain" })
        : response(404, "");
    const { default: URLContextProvider } =
      await import("./URLContextProvider");
    const [item] = await new URLContextProvider({}).getContextItems(
      "https://site.example/doc",
      extras(),
    );
    expect(item.content).toMatch(
      /^\[fetched https:\/\/site\.example\/doc · 200 text\/plain · 11 B · .* · sha256:[0-9a-f]{12} · robots: not checked · rule: builtin:public\]\n\nplain words$/,
    );
  });
});

describe("@web (the search backend)", () => {
  it("sends the endpoint's own key and no global header", async () => {
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://search.example/search");
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_KEY", "search-key");
    respond = () =>
      response(200, JSON.stringify({ results: [{ title: "T", url: "u" }] }), {
        "content-type": "application/json",
      });
    try {
      const { default: WebContextProvider } =
        await import("./WebContextProvider");
      const items = await new WebContextProvider({}).getContextItems(
        "",
        extras("what is x"),
      );
      expect(items[0].name).toBe("T");
      expectNoGlobalHeaders();
      expect(calls[0].init.headers).toEqual({
        Accept: "application/json",
        "User-Agent": "Continuous-User/0.0",
        Authorization: "Bearer search-key",
      });
      expect(getFetchLog().list()[0].purpose).toBe("search");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("drops the endpoint's key when the endpoint redirects elsewhere", async () => {
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://search.example/search");
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_KEY", "search-key");
    respond = (u) =>
      u.host === "search.example"
        ? response(302, "", { location: "https://other.example/s" })
        : response(200, JSON.stringify({ results: [] }), {
            "content-type": "application/json",
          });
    try {
      const { default: WebContextProvider } =
        await import("./WebContextProvider");
      await new WebContextProvider({}).getContextItems("", extras("q"));
      expect(calls[1].url).toBe("https://other.example/s");
      expect(calls[1].init.headers).toEqual({
        Accept: "application/json",
        "User-Agent": "Continuous-User/0.0",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("caps the response and refuses one larger than the cap", async () => {
    vi.stubEnv("CONTINUOUS_WEB_SEARCH_URL", "https://search.example/search");
    respond = () =>
      response(200, `{"results":[${'{"title":"x"},'.repeat(400_000)}]}`, {
        "content-type": "application/json",
      });
    try {
      const { fetchSearchResults } = await import("./webSearchBackend");
      const { modelToolFetch } = await import("../../util/modelToolFetch");
      await expect(
        fetchSearchResults("q", 5, modelToolFetch(config)),
      ).rejects.toThrow(/larger than \d+ bytes/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("@google", () => {
  it("sends the key header and no global header, and never quotes the body", async () => {
    respond = () => response(200, "not json at all: internal detail");
    const { default: GoogleContextProvider } =
      await import("./GoogleContextProvider");
    const provider = new GoogleContextProvider({ serperApiKey: "serper-k" });
    const err = await provider
      .getContextItems("q", extras())
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(
      "Failed to parse Google search results",
    );
    expectNoGlobalHeaders();
    expect(calls[0].init.headers?.["X-API-KEY"]).toBe("serper-k");
    expect(calls[0].init.method).toBe("POST");
  });

  it("says only the status on an HTTP error", async () => {
    respond = () => response(403, "quota exceeded for account 1234");
    const { default: GoogleContextProvider } =
      await import("./GoogleContextProvider");
    const err = await new GoogleContextProvider({ serperApiKey: "k" })
      .getContextItems("q", extras())
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 403/);
    expect((err as Error).message).not.toContain("1234");
  });
});

describe("favicon", () => {
  it("has its own small limits", () => {
    expect(FAVICON_MAX_BYTES).toBe(256 * 1024);
    expect(FAVICON_DEADLINE_MS).toBe(5000);
  });

  it.each([
    ["image/svg+xml", "<svg onload='x()'/>"],
    ["text/html", "<html></html>"],
    ["application/octet-stream", "MZ"],
  ])("refuses an icon served as %s", async (type, body) => {
    respond = () => response(200, body, { "content-type": type });
    expect(
      await getFaviconBase64(
        "https://site.example/i",
        undefined,
        "site.example",
      ),
    ).toBeUndefined();
  });

  it("refuses an untyped icon whose bytes are not an image (an SVG)", async () => {
    respond = () => response(200, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(
      await getFaviconBase64(
        "https://site.example/i",
        undefined,
        "site.example",
      ),
    ).toBeUndefined();
  });

  it("refuses an icon larger than the cap", async () => {
    const big = new Uint8Array(FAVICON_MAX_BYTES + 10);
    big.set([0x89, 0x50, 0x4e, 0x47]);
    respond = () => response(200, big, { "content-type": "image/png" });
    expect(
      await getFaviconBase64(
        "https://site.example/i",
        undefined,
        "site.example",
      ),
    ).toBeUndefined();
  });

  it("puts the checked type, not the server's text, in the data URI", async () => {
    respond = () =>
      response(200, new Uint8Array([0, 0, 1, 0]), {
        "content-type": 'image/x-icon; foo="<script>"',
      });
    expect(
      await getFaviconBase64(
        "https://site.example/i",
        undefined,
        "site.example",
      ),
    ).toBe("data:image/x-icon;base64,AAABAA==");
  });

  it("refuses an icon on a non-public host the page did not come from", async () => {
    setHostResolver(async (h) =>
      h === "nas.corp.example" ? ["10.0.0.4"] : ["93.184.215.14"],
    );
    respond = () => response(200, new Uint8Array([0, 0, 1, 0]));
    try {
      expect(
        await getFaviconBase64(
          "https://nas.corp.example/i.ico",
          undefined,
          "site.example",
        ),
      ).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      setHostResolver(async () => ["93.184.215.14"]);
    }
  });
});
