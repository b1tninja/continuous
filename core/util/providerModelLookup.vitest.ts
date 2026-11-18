import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MODELS_VERSION,
  closeModelMatches,
  describeModelFacts,
  describeModelLookup,
  type LookupFetch,
  lookupProviderModel,
  parseAnthropicModel,
  toModelCheck,
} from "./providerModelLookup.js";

const KEY = "sk-test-SECRET-VALUE";

const OPUS = {
  id: "claude-opus-5-5",
  display_name: "Claude Opus 5.5",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  lifecycle: "active",
  deprecated_at: null,
  retires_at: null,
  capabilities: {
    image_input: { supported: true },
    pdf_input: { supported: true },
    thinking: {
      supported: true,
      types: {
        adaptive: { supported: true },
        enabled: { supported: false },
      },
    },
  },
};

interface Seen {
  url: string;
  headers: Record<string, string>;
}

type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | "network"
  | "hang";

function fake(route: (url: string, seen: Seen) => Reply, seen: Seen[] = []) {
  const fn: LookupFetch = (url, init) => {
    const s = { url, headers: init.headers };
    seen.push(s);
    const r = route(url, s);
    if (r === "network") {
      return Promise.reject(new Error(`connect ECONNREFUSED (key ${KEY})`));
    }
    if (r === "hang") {
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        }),
      );
    }
    return Promise.resolve({
      ok: r.status < 400,
      status: r.status,
      headers: { get: (n: string) => r.headers?.[n] ?? null },
      json: async () => {
        if (typeof r.body === "string") throw new Error("not json");
        return r.body;
      },
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? ""),
    });
  };
  return fn;
}

const LIST = {
  data: [
    { id: "claude-opus-5-5" },
    { id: "claude-sonnet-5-5" },
    { id: "claude-haiku-5-5" },
    { id: "claude-sonnet-4-5-20250929" },
  ],
};

describe("lookupProviderModel (Anthropic)", () => {
  it("asks GET /models/{id} with x-api-key and reads the facts", async () => {
    const seen: Seen[] = [];
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => ({ status: 200, body: OPUS }), seen),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      "https://api.anthropic.com/v1/models/claude-opus-5-5",
    );
    expect(seen[0].headers["x-api-key"]).toBe(KEY);
    expect(seen[0].headers["anthropic-version"]).toBe(ANTHROPIC_MODELS_VERSION);
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(r).toEqual({
      kind: "found",
      facts: {
        id: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        contextLength: 1_000_000,
        maxOutputTokens: 128_000,
        lifecycle: "active",
        supportsImages: true,
        supportsPdf: true,
        thinkingTypes: ["adaptive"],
      },
    });
  });

  it("reads deprecation and retirement dates", () => {
    expect(
      parseAnthropicModel({
        id: "claude-sonnet-4-5-20250929",
        lifecycle: "deprecated",
        deprecated_at: "2026-09-30T00:00:00Z",
        retires_at: "2026-11-30T00:00:00Z",
      }),
    ).toEqual({
      id: "claude-sonnet-4-5-20250929",
      lifecycle: "deprecated",
      deprecatedAt: "2026-09-30",
      retiresAt: "2026-11-30",
    });
  });

  it("encodes the id and uses the configured base and headers", async () => {
    const seen: Seen[] = [];
    await lookupProviderModel({
      provider: "anthropic",
      apiBase: "https://gateway.example/anthropic/v1/",
      apiKey: KEY,
      model: "weird/id",
      headers: { "x-gateway": "g" },
      fetchFn: fake(() => ({ status: 200, body: OPUS }), seen),
    });
    expect(seen[0].url).toBe(
      "https://gateway.example/anthropic/v1/models/weird%2Fid",
    );
    expect(seen[0].headers["x-gateway"]).toBe("g");
  });

  it("retries with the older version when the newer one is refused", async () => {
    const seen: Seen[] = [];
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(
        (_u, s) =>
          s.headers["anthropic-version"] === ANTHROPIC_MODELS_VERSION
            ? { status: 400, body: { error: "bad version" } }
            : { status: 200, body: { id: "claude-opus-5-5" } },
        seen,
      ),
    });
    expect(seen.map((s) => s.headers["anthropic-version"])).toEqual([
      ANTHROPIC_MODELS_VERSION,
      "2023-06-01",
    ]);
    expect(r).toEqual({ kind: "found", facts: { id: "claude-opus-5-5" } });
  });

  it("an unknown id is not-found, with close matches from the list", async () => {
    const seen: Seen[] = [];
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-55",
      fetchFn: fake(
        (url) =>
          url.includes("/models/")
            ? { status: 404, body: { error: { type: "not_found_error" } } }
            : { status: 200, body: LIST },
        seen,
      ),
    });
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.anthropic.com/v1/models/claude-opus-55",
      "https://api.anthropic.com/v1/models?limit=1000",
    ]);
    expect(r).toEqual({ kind: "not-found", suggestions: ["claude-opus-5-5"] });
    if (r.kind !== "not-found") throw new Error();
    expect(describeModelLookup("anthropic", "claude-opus-55", r)).toBe(
      'Anthropic does not know a model "claude-opus-55" for this key (HTTP 404). Check the spelling, or whether this key\'s account has access to it. Did you mean claude-opus-5-5?',
    );
  });

  it("uses a listing it was given instead of fetching one", async () => {
    const seen: Seen[] = [];
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-sonet-5-5",
      listed: LIST.data.map((m) => m.id),
      fetchFn: fake(() => ({ status: 404, body: {} }), seen),
    });
    expect(seen).toHaveLength(1);
    expect(r.kind).toBe("not-found");
    expect(r.kind === "not-found" && r.suggestions[0]).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("an alias the list shows only with its date counts as found", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-sonnet-4-5",
      listed: LIST.data.map((m) => m.id),
      fetchFn: fake(() => ({ status: 404, body: {} })),
    });
    expect(r).toEqual({
      kind: "found",
      facts: { id: "claude-sonnet-4-5-20250929" },
    });
  });

  it.each([401, 403])("HTTP %s is a key problem", async (status) => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => ({ status, body: { error: `bad key ${KEY}` } })),
    });
    expect(r).toMatchObject({ kind: "failed", reason: "auth", status });
    expect(JSON.stringify(r)).not.toContain(KEY);
    if (r.kind !== "failed") throw new Error();
    expect(describeModelLookup("anthropic", "claude-opus-5-5", r)).toMatch(
      /refused the key .*Check the API key/,
    );
  });

  it("HTTP 429 is a rate limit, with retry-after", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => ({
        status: 429,
        body: { error: "slow down" },
        headers: { "retry-after": "30" },
      })),
    });
    expect(r).toMatchObject({
      kind: "failed",
      reason: "rate-limited",
      status: 429,
      retryAfter: 30,
    });
    if (r.kind !== "failed") throw new Error();
    expect(describeModelLookup("anthropic", "m", r)).toContain(
      "retry after 30 s",
    );
  });

  it("a network error is told apart and the key is scrubbed", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => "network"),
    });
    expect(r).toMatchObject({ kind: "failed", reason: "network" });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("a slow server times out", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      timeoutMs: 20,
      fetchFn: fake(() => "hang"),
    });
    expect(r).toEqual({ kind: "failed", reason: "timeout" });
  });

  it("an endpoint without a models API is unsupported", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiBase: "https://proxy.example/v1",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => ({ status: 404, body: "<html>Not Found</html>" })),
    });
    expect(r).toEqual({ kind: "failed", reason: "unsupported", status: 404 });
  });

  it("a 200 that is not a model object is unsupported, not found", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => ({ status: 200, body: "<html>login</html>" })),
    });
    expect(r).toMatchObject({ kind: "failed", reason: "unsupported" });
  });

  it("other statuses are reported with the status", async () => {
    const r = await lookupProviderModel({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-opus-5-5",
      fetchFn: fake(() => ({ status: 503, body: { error: "overloaded" } })),
    });
    expect(r).toMatchObject({ kind: "failed", reason: "http", status: 503 });
  });
});

describe("lookupProviderModel (OpenAI)", () => {
  it("sends a bearer key and reads shutdown_date (Unix seconds)", async () => {
    const seen: Seen[] = [];
    const r = await lookupProviderModel({
      provider: "openai",
      apiKey: KEY,
      model: "gpt-4.1",
      fetchFn: fake(
        () => ({
          status: 200,
          body: {
            id: "gpt-4.1",
            object: "model",
            owned_by: "openai",
            shutdown_date: Date.UTC(2027, 1, 14) / 1000,
          },
        }),
        seen,
      ),
    });
    expect(seen[0].url).toBe("https://api.openai.com/v1/models/gpt-4.1");
    expect(seen[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].headers["x-api-key"]).toBeUndefined();
    expect(r).toEqual({
      kind: "found",
      facts: {
        id: "gpt-4.1",
        retiresAt: "2027-02-14",
        lifecycle: "deprecated",
      },
    });
  });

  it("reads an ISO shutdown_date and leaves a model without one active", async () => {
    const r = await lookupProviderModel({
      provider: "openai",
      apiKey: KEY,
      model: "gpt-x",
      fetchFn: fake(() => ({
        status: 200,
        body: { id: "gpt-x", shutdown_date: "2027-03-01" },
      })),
    });
    expect(r).toMatchObject({ facts: { retiresAt: "2027-03-01" } });
    const plain = await lookupProviderModel({
      provider: "openai",
      apiKey: KEY,
      model: "gpt-y",
      fetchFn: fake(() => ({ status: 200, body: { id: "gpt-y" } })),
    });
    expect(plain).toEqual({ kind: "found", facts: { id: "gpt-y" } });
  });

  it("a compatible server with a list but no per-model route still finds a listed id", async () => {
    const r = await lookupProviderModel({
      provider: "openai",
      apiBase: "http://127.0.0.1:8000/v1",
      model: "qwen3",
      fetchFn: fake((url) =>
        url.endsWith("/models")
          ? { status: 200, body: { data: [{ id: "qwen3" }] } }
          : { status: 404, body: {} },
      ),
    });
    expect(r).toEqual({ kind: "found", facts: { id: "qwen3" } });
  });

  it("does not send an Authorization header without a key", async () => {
    const seen: Seen[] = [];
    await lookupProviderModel({
      provider: "openai",
      apiBase: "http://127.0.0.1:8000/v1",
      model: "qwen3",
      fetchFn: fake(() => ({ status: 200, body: { id: "qwen3" } }), seen),
    });
    expect(seen[0].headers.Authorization).toBeUndefined();
  });
});

describe("closeModelMatches", () => {
  const ids = [
    "gpt-5.5",
    "gpt-5.5-mini",
    "gpt-4.1",
    "o4-mini",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
  ];

  it("finds punctuation slips, prefixes and small typos, closest first", () => {
    expect(closeModelMatches("claude-opus-55", ids)).toEqual([
      "claude-opus-5-5",
    ]);
    expect(closeModelMatches("gpt-5.5-min", ids)[0]).toBe("gpt-5.5-mini");
    expect(closeModelMatches("gpt5.5", ids)[0]).toBe("gpt-5.5");
    expect(closeModelMatches("claude-sonet-5-5", ids)[0]).toBe(
      "claude-sonnet-5-5",
    );
  });

  it("offers nothing for an unrelated id and never the id itself", () => {
    expect(closeModelMatches("llama-3-70b", ids)).toEqual([]);
    expect(closeModelMatches("gpt-4.1", ids)).not.toContain("gpt-4.1");
    expect(closeModelMatches("", ids)).toEqual([]);
  });

  it("returns at most the limit", () => {
    expect(closeModelMatches("gpt", ids, 2)).toHaveLength(2);
  });
});

describe("describeModelFacts and toModelCheck", () => {
  it("summarises what the provider reported", () => {
    const facts = parseAnthropicModel(OPUS)!;
    expect(describeModelFacts(facts)).toBe(
      "Claude Opus 5.5 (claude-opus-5-5): 1,000,000-token context; 128,000 max output tokens; reads images and PDFs; thinking: adaptive.",
    );
    expect(
      describeModelFacts({
        id: "x",
        lifecycle: "deprecated",
        retiresAt: "2026-11-30",
      }),
    ).toBe("x: deprecated, retires 2026-11-30.");
  });

  it("turns each outcome into a check", () => {
    expect(
      toModelCheck(
        "openai",
        "gpt-z",
        { kind: "not-found", suggestions: [] },
        {
          isOpenAI: true,
        },
      ),
    ).toMatchObject({
      status: "not-found",
      message: expect.stringMatching(/^OpenAI does not know a model "gpt-z"/),
    });
    expect(
      toModelCheck("openai", "m", { kind: "failed", reason: "unsupported" }),
    ).toMatchObject({
      status: "unverified",
      reason: "unsupported",
      message: expect.stringContaining("not checked"),
    });
  });
});
