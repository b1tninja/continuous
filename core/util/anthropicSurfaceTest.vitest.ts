import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_FALLBACK_VERSION,
  ANTHROPIC_LIST_VERSION,
  type AnthropicFetch,
  testAnthropicConnection,
} from "./anthropicSurfaceTest.js";
import { testOpenAICompatConnection } from "./openaiCompatTest.js";
import { readNoticeState } from "./retirementNoticeState.js";

const KEY = "sk-ant-api03-SECRET-VALUE";
const body = {
  data: [
    {
      id: "claude-sonnet-4-5-20250929",
      display_name: "Claude Sonnet 4.5",
      lifecycle: "deprecated",
      deprecated_at: "2026-09-30T00:00:00Z",
      retires_at: "2026-11-30T00:00:00Z",
    },
    { id: "claude-sonnet-5-5", lifecycle: "active", retires_at: null },
  ],
};

function fake(
  respond: (version: string, url: string) => { status: number; body: unknown },
  seen: { url: string; headers: Record<string, string>; method: string }[] = [],
): AnthropicFetch {
  return async (url, init) => {
    seen.push({ url, headers: init.headers, method: init.method });
    const r = respond(init.headers["anthropic-version"], url);
    return {
      ok: r.status < 400,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

describe("testAnthropicConnection", () => {
  it("sends GET /models with x-api-key and the newer version, and reads the lifecycle", async () => {
    const seen: any[] = [];
    const res = await testAnthropicConnection({
      apiKey: KEY,
      models: ["claude-sonnet-4-5-20250929"],
      now: "2026-11-11",
      fetchFn: fake(
        (_v, url) => ({
          status: 200,
          body: url.includes("/models/") ? body.data[0] : body,
        }),
        seen,
      ),
    });
    // The listing, then the configured id itself
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toBe(
      "https://api.anthropic.com/v1/models/claude-sonnet-4-5-20250929",
    );
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(seen[0].headers["x-api-key"]).toBe(KEY);
    expect(seen[0].headers["anthropic-version"]).toBe(ANTHROPIC_LIST_VERSION);
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(res.ok && res.models).toEqual([
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-5-5",
    ]);
    expect(res.ok && res.notices[0]).toMatchObject({
      from: "live",
      severity: "retiring",
      retiresAt: "2026-11-30",
      deprecatedAt: "2026-09-30",
    });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it("matches an alias to the dated id the list returns", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      models: ["claude-sonnet-4-5"],
      now: "2026-11-11",
      fetchFn: fake(() => ({ status: 200, body })),
    });
    expect(res.ok && res.notices[0]?.from).toBe("live");
  });

  it("falls back to the older version when the newer one is refused", async () => {
    const seen: any[] = [];
    const res = await testAnthropicConnection({
      apiKey: KEY,
      models: ["claude-sonnet-4-5-20250929"],
      now: "2026-11-11",
      fetchFn: fake(
        (v, url) =>
          v === ANTHROPIC_LIST_VERSION
            ? { status: 400, body: { error: { message: "bad version" } } }
            : {
                status: 200,
                body: url.includes("/models/")
                  ? { id: "claude-sonnet-4-5-20250929" }
                  : { data: [{ id: "claude-sonnet-4-5-20250929" }] },
              },
        seen,
      ),
    });
    // The listing (newer version refused, then the older one), then the id
    expect(seen.map((s) => s.headers["anthropic-version"])).toEqual([
      ANTHROPIC_LIST_VERSION,
      ANTHROPIC_FALLBACK_VERSION,
      ANTHROPIC_LIST_VERSION,
      ANTHROPIC_FALLBACK_VERSION,
    ]);
    expect(res.ok && res.modelChecks[0]?.status).toBe("found");
    // No lifecycle fields came back: the checked-in table answers.
    expect(res.ok && res.notices[0]?.from).toBe("table");
  });

  it("checks the configured id: found, with what Anthropic reports", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      models: ["claude-opus-5-5"],
      fetchFn: fake((_v, url) =>
        url.includes("/models/")
          ? {
              status: 200,
              body: {
                id: "claude-opus-5-5",
                max_input_tokens: 1_000_000,
                max_tokens: 128_000,
                capabilities: { image_input: { supported: true } },
              },
            }
          : { status: 200, body },
      ),
    });
    expect(res.ok && res.modelChecks).toEqual([
      expect.objectContaining({
        status: "found",
        model: "claude-opus-5-5",
        facts: expect.objectContaining({
          contextLength: 1_000_000,
          maxOutputTokens: 128_000,
          supportsImages: true,
        }),
      }),
    ]);
  });

  it("an unknown id names close matches; the connection still succeeds", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      models: ["claude-sonnet-55"],
      fetchFn: fake((_v, url) =>
        url.includes("/models/")
          ? { status: 404, body: { error: { type: "not_found_error" } } }
          : { status: 200, body },
      ),
    });
    expect(res.ok).toBe(true);
    expect(res.ok && res.modelChecks[0]).toMatchObject({
      status: "not-found",
      suggestions: ["claude-sonnet-5-5"],
      message: expect.stringContaining("Did you mean claude-sonnet-5-5?"),
    });
  });

  it("a rate limit on the id check is reported as not checked", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      models: ["claude-opus-5-5"],
      fetchFn: fake((_v, url) =>
        url.includes("/models/")
          ? { status: 429, body: { error: "rate" } }
          : { status: 200, body },
      ),
    });
    expect(res.ok && res.modelChecks[0]).toMatchObject({
      status: "unverified",
      reason: "rate-limited",
    });
  });

  it("says when the listing itself is rate limited", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      fetchFn: fake(() => ({ status: 429, body: {} })),
    });
    expect(!res.ok && res.error).toContain("rate limiting");
  });

  it("says the key was rejected without echoing it", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      fetchFn: fake(() => ({ status: 401, body: { error: { message: KEY } } })),
    });
    expect(res).toEqual({
      ok: false,
      error: "Anthropic rejected the API key (HTTP 401).",
    });
  });

  it("scrubs the key from a network error", async () => {
    const res = await testAnthropicConnection({
      apiKey: KEY,
      fetchFn: async () => {
        throw new Error(`failed with ${KEY}`);
      },
    });
    expect(!res.ok && res.error).not.toContain(KEY);
  });

  it("needs a key", async () => {
    const res = await testAnthropicConnection({});
    expect(res.ok).toBe(false);
  });
});

describe("Test connection for provider anthropic", () => {
  it("keeps the lifecycle locally and returns the notice, never the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notices-"));
    const noticeFile = join(dir, "n.json");
    const res = await testOpenAICompatConnection({
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-sonnet-4-5-20250929",
      now: "2026-11-11",
      noticeFile,
      providerInfoDir: dir,
      fetchFn: fake((_v, url) => ({
        status: 200,
        body: url.includes("/models/") ? body.data[0] : body,
      })) as any,
    });
    expect(res.ok && res.retirement?.[0].retiresAt).toBe("2026-11-30");
    expect(res.ok && res.modelCheck?.status).toBe("found");
    // What Anthropic reported for the model is kept, keyed by a hash
    const kept = readdirSync(dir).filter((f) => f.startsWith("provider-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, kept[0]), "utf8")).not.toContain(KEY);
    expect(JSON.stringify(res)).not.toContain(KEY);
    const state = readNoticeState(noticeFile);
    expect(state.live["claude-sonnet-4-5-20250929"]).toMatchObject({
      lifecycle: "deprecated",
      retiresAt: "2026-11-30T00:00:00Z",
      readOn: "2026-11-11",
    });
    expect(state.live["claude-sonnet-5-5"]).toBeUndefined();
    expect(readFileSync(noticeFile, "utf8")).not.toContain(KEY);
  });

  it("writes nothing with record: false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notices-"));
    const noticeFile = join(dir, "n.json");
    await testOpenAICompatConnection({
      provider: "anthropic",
      apiKey: KEY,
      record: false,
      model: "claude-sonnet-4-5-20250929",
      noticeFile,
      providerInfoDir: dir,
      fetchFn: fake((_v, url) => ({
        status: 200,
        body: url.includes("/models/") ? body.data[0] : body,
      })) as any,
    });
    expect(readNoticeState(noticeFile).live).toEqual({});
    expect(readdirSync(dir).filter((f) => f.startsWith("provider-"))).toEqual(
      [],
    );
  });
});
