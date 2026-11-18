import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import { warmCacheLoss } from "./cacheSafeguards";
import {
  localCacheWarmMs,
  OLLAMA_REQUEST_KEEP_ALIVE_MS,
} from "./localWarmWindow";
import { LOCAL_CACHE_WARM_MS } from "./promptCache";

const model = (provider: string, keepAlive?: number): ModelDescription => ({
  title: "m",
  provider,
  model: "m",
  underlyingProviderName: provider,
  ...(keepAlive !== undefined && { completionOptions: { keepAlive } }),
});

describe("localCacheWarmMs", () => {
  it("is the request keep-alive our Ollama provider sends (30 min)", () => {
    expect(localCacheWarmMs(model("ollama"))).toBe(
      OLLAMA_REQUEST_KEEP_ALIVE_MS,
    );
  });

  it("honours a configured keepAlive, in seconds", () => {
    expect(localCacheWarmMs(model("ollama", 300))).toBe(5 * 60 * 1000);
  });

  it("a negative keepAlive never unloads; 0 unloads at once", () => {
    expect(localCacheWarmMs(model("ollama", -1))).toBe(Infinity);
    expect(localCacheWarmMs(model("ollama", 0))).toBe(0);
  });

  it("keeps the generic window for llama.cpp and other servers", () => {
    expect(localCacheWarmMs(model("llama.cpp"))).toBe(LOCAL_CACHE_WARM_MS);
    expect(localCacheWarmMs(undefined)).toBe(LOCAL_CACHE_WARM_MS);
  });

  it("drives the cold-resume warning for Ollama", () => {
    const state = {
      escalated: false,
      lastRequestAt: 0,
      lastInputTokens: 100_000,
    };
    const m = model("ollama", 300);
    expect(warmCacheLoss(m, undefined, state, 4 * 60_000)).toBeDefined();
    expect(warmCacheLoss(m, undefined, state, 6 * 60_000)).toBeUndefined();
  });
});
