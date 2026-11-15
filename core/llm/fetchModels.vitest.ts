import { afterEach, describe, expect, it, vi } from "vitest";

import {
  anthropicModelToFetched,
  fetchModels,
  windowFromInputAndOutput,
} from "./fetchModels";

// Provider list requests go through the shared fetch; stand in for it with the
// global stub these tests already use.
vi.mock("@continuedev/fetch", () => ({
  fetchwithRequestOptions: (...args: unknown[]) =>
    (globalThis as any).fetch(...args),
}));

describe("windowFromInputAndOutput", () => {
  it("adds the output limit to the input limit", () => {
    expect(windowFromInputAndOutput(100_000, 128_000)).toBe(228_000);
  });
  it("keeps an input limit with no output limit", () => {
    expect(windowFromInputAndOutput(200_000, undefined)).toBe(200_000);
  });
  it("is undefined without an input limit", () => {
    expect(windowFromInputAndOutput(undefined, 8_192)).toBeUndefined();
  });
});

describe("fetchModels: separate input/output limits", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

  it("Anthropic: input budget equals max_input_tokens", async () => {
    respond({
      data: [
        {
          id: "claude-opus-5-5",
          display_name: "Claude Opus 5.5",
          max_input_tokens: 100_000,
          max_tokens: 128_000,
        },
      ],
    });
    const [m] = await fetchModels("anthropic", "key");
    expect(m.maxTokens).toBe(128_000);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(String(url)).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect(init.headers["x-api-key"]).toBe("key");
    // The prompt is pruned to contextLength - maxTokens.
    expect(m.contextLength! - m.maxTokens!).toBe(100_000);
  });

  it("Anthropic: lists models at a custom apiBase", async () => {
    respond({ data: [{ id: "claude-sonnet-4-6", display_name: "Sonnet" }] });
    await fetchModels(
      "anthropic",
      "gateway-key",
      "https://llm.example/anthropic/v1",
    );
    const [url, init] = (fetch as any).mock.calls[0];
    expect(String(url)).toBe(
      "https://llm.example/anthropic/v1/models?limit=100",
    );
    expect(init.headers["x-api-key"]).toBe("gateway-key");
    expect(String(url)).not.toContain("api.anthropic.com");
  });

  it("Anthropic: follows has_more and last_id until the list ends", async () => {
    const pages = [
      {
        data: [{ id: "claude-a", display_name: "A" }],
        has_more: true,
        last_id: "claude-a",
      },
      {
        data: [{ id: "claude-b", display_name: "B" }],
        has_more: false,
        last_id: "claude-b",
      },
    ];
    const fn = vi.fn(
      async () => new Response(JSON.stringify(pages.shift()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fn);
    const models = await fetchModels("anthropic", "key");
    expect(models.map((m) => m.modelId)).toEqual(["claude-a", "claude-b"]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(String((fn.mock.calls[0] as any)[0])).toBe(
      "https://api.anthropic.com/v1/models?limit=100",
    );
    expect(String((fn.mock.calls[1] as any)[0])).toBe(
      "https://api.anthropic.com/v1/models?limit=100&after_id=claude-a",
    );
  });

  it("Anthropic: stops at the page cap when has_more never clears", async () => {
    let n = 0;
    const fn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: `claude-${n}` }],
            has_more: true,
            last_id: `claude-${n++}`,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fn);
    const models = await fetchModels("anthropic", "key");
    expect(fn).toHaveBeenCalledTimes(10);
    expect(models).toHaveLength(10);
  });

  it("Anthropic: a repeated cursor ends the loop", async () => {
    const fn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "x" }],
            has_more: true,
            last_id: "x",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fn);
    await fetchModels("anthropic", "key");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("Gemini: input budget equals inputTokenLimit", async () => {
    respond({
      models: [
        {
          name: "models/gemini-test",
          displayName: "Gemini Test",
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          supportedGenerationMethods: ["generateContent"],
        },
      ],
    });
    const [m] = await fetchModels("gemini", "key");
    expect(m.contextLength! - m.maxTokens!).toBe(1_048_576);
  });

  it("Gemini: keeps the base path when it has no trailing slash", async () => {
    respond({ models: [] });
    await fetchModels("gemini", "key", "https://llm.example/v1beta");
    const [url] = (fetch as any).mock.calls[0];
    expect(String(url)).toContain("https://llm.example/v1beta/models");
  });
});

describe("anthropicModelToFetched", () => {
  it("reads image input, lifecycle and the retirement date", () => {
    const m = anthropicModelToFetched({
      id: "claude-sonnet-4-5-20250929",
      display_name: "Claude Sonnet 4.5",
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: { image_input: { supported: true } },
      lifecycle: "deprecated",
      retires_at: "2026-11-30T00:00:00Z",
    });
    expect(m).toMatchObject({
      modelId: "claude-sonnet-4-5-20250929",
      contextLength: 264_000,
      maxTokens: 64_000,
      supportsImages: true,
      deprecated: true,
      retiresAt: "2026-11-30T00:00:00Z",
    });
    // Effort levels would become OpenAI-style reasoning_effort variants
    expect(m.reasoningEfforts).toBeUndefined();
  });

  it("says a model takes no images only when the API says so", () => {
    expect(
      anthropicModelToFetched({
        id: "a",
        capabilities: { image_input: { supported: false } },
      }).supportsImages,
    ).toBe(false);
    const bare = anthropicModelToFetched({ id: "b" });
    expect("supportsImages" in bare).toBe(false);
    expect(bare.deprecated).toBeUndefined();
    expect("retiresAt" in bare).toBe(false);
  });

  it("ignores a retirement date that does not parse and an active model's null", () => {
    expect(
      anthropicModelToFetched({ id: "c", retires_at: "soon" }).retiresAt,
    ).toBeUndefined();
    const active = anthropicModelToFetched({
      id: "d",
      lifecycle: "active",
      retires_at: null,
    });
    expect(active.deprecated).toBe(false);
    expect(active.retiresAt).toBeUndefined();
  });
});
