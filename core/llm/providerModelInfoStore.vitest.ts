import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountFingerprint,
  clearProviderInfoMemory,
  MAX_PROVIDER_INFO_ENTRIES,
  providerInfoPath,
  providerModelFactsFor,
  readCachedModelFacts,
  writeCachedModelFacts,
} from "./providerModelInfoStore.js";

const KEY = "sk-ant-api03-SECRET-VALUE";
const automatic = { policy: "automatic" as const, refreshHours: 24 };

describe("providerModelInfoStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provider-info-"));
    clearProviderInfoMemory();
  });

  it("names the file by provider and a hash, never the key", () => {
    const file = providerInfoPath({ provider: "anthropic", apiKey: KEY }, dir);
    expect(file).not.toContain(KEY);
    expect(file).toMatch(/provider-anthropic-[0-9a-f]{24}\.json$/);
  });

  it("separates accounts and bases, and ignores a trailing slash", () => {
    const a = accountFingerprint({ provider: "openai", apiKey: "k1" });
    expect(accountFingerprint({ provider: "openai", apiKey: "k2" })).not.toBe(
      a,
    );
    expect(
      accountFingerprint({
        provider: "openai",
        apiKey: "k1",
        apiBase: "https://gw.example/v1",
      }),
    ).not.toBe(a);
    expect(
      accountFingerprint({
        provider: "openai",
        apiKey: "k1",
        apiBase: "https://api.openai.com/v1/",
      }),
    ).toBe(a);
  });

  it("keeps an answer with its date and without the key", () => {
    const target = {
      provider: "anthropic" as const,
      apiKey: KEY,
      model: "claude-opus-5-5",
    };
    writeCachedModelFacts(
      target,
      { id: "claude-opus-5-5", contextLength: 1_000_000 },
      { dir, now: new Date("2026-11-13T10:00:00Z") },
    );
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(dir, files[0]), "utf8");
    expect(text).not.toContain(KEY);
    clearProviderInfoMemory();
    expect(readCachedModelFacts(target, dir)).toEqual({
      id: "claude-opus-5-5",
      contextLength: 1_000_000,
      fetchedAt: "2026-11-13T10:00:00.000Z",
    });
  });

  it("is used only for Anthropic and OpenAI, and never with updates off", () => {
    const target = { apiKey: KEY, model: "claude-opus-5-5" };
    writeCachedModelFacts(
      { provider: "anthropic", ...target },
      { id: "claude-opus-5-5", contextLength: 1_000_000 },
      { dir },
    );
    expect(
      providerModelFactsFor("anthropic", target, { dir, settings: automatic })
        ?.contextLength,
    ).toBe(1_000_000);
    expect(
      providerModelFactsFor("anthropic", target, {
        dir,
        settings: { policy: "ask", refreshHours: 24 },
      })?.contextLength,
    ).toBe(1_000_000);
    expect(
      providerModelFactsFor("anthropic", target, {
        dir,
        settings: { policy: "off", refreshHours: 24 },
      }),
    ).toBeUndefined();
    expect(
      providerModelFactsFor("bedrock", target, { dir, settings: automatic }),
    ).toBeUndefined();
  });

  it("a missing or broken file reads as nothing", () => {
    expect(
      readCachedModelFacts(
        { provider: "openai", apiKey: "k", model: "gpt-x" },
        join(dir, "missing"),
      ),
    ).toBeUndefined();
  });

  it("keeps at most the newest entries per account", () => {
    const t = { provider: "openai" as const, apiKey: "k" };
    for (let i = 0; i < MAX_PROVIDER_INFO_ENTRIES + 3; i++) {
      writeCachedModelFacts(
        { ...t, model: `m${i}` },
        { id: `m${i}` },
        { dir, now: new Date(Date.UTC(2026, 0, 1, 0, i)) },
      );
    }
    clearProviderInfoMemory();
    expect(readCachedModelFacts({ ...t, model: "m0" }, dir)).toBeUndefined();
    expect(
      readCachedModelFacts(
        { ...t, model: `m${MAX_PROVIDER_INFO_ENTRIES + 2}` },
        dir,
      ),
    ).toBeDefined();
  });
});
