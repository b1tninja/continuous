import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Anthropic from "./llms/Anthropic.js";
import OpenAI from "./llms/OpenAI.js";
import {
  clearProviderInfoMemory,
  writeCachedModelFacts,
} from "./providerModelInfoStore.js";
import { MODEL_INFO_UPDATES_ENV } from "./modelCatalogStore.js";

/**
 * The provider's cached answer between the person's config and llm-info, in
 * a real LLM class. The cache lives in the test global folder.
 */
describe("BaseLLM with a cached provider answer", () => {
  const prior = process.env[MODEL_INFO_UPDATES_ENV];
  beforeEach(() => {
    delete process.env[MODEL_INFO_UPDATES_ENV];
    clearProviderInfoMemory();
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[MODEL_INFO_UPDATES_ENV];
    else process.env[MODEL_INFO_UPDATES_ENV] = prior;
    clearProviderInfoMemory();
  });

  it("uses the provider's window and cap where config is silent", () => {
    writeCachedModelFacts(
      { provider: "openai", apiKey: "k1", model: "gpt-unlisted-test" },
      {
        id: "gpt-unlisted-test",
        contextLength: 400_000,
        maxOutputTokens: 64_000,
      },
    );
    const llm = new OpenAI({ model: "gpt-unlisted-test", apiKey: "k1" });
    expect(llm.contextLength).toBe(400_000);
    expect(llm.completionOptions.maxTokens).toBe(64_000);
  });

  it("another key's answer is not used", () => {
    writeCachedModelFacts(
      { provider: "openai", apiKey: "k1", model: "gpt-unlisted-test" },
      { id: "gpt-unlisted-test", contextLength: 400_000 },
    );
    const llm = new OpenAI({ model: "gpt-unlisted-test", apiKey: "k2" });
    expect(llm.contextLength).not.toBe(400_000);
  });

  it("config wins", () => {
    writeCachedModelFacts(
      { provider: "openai", apiKey: "k1", model: "gpt-unlisted-test" },
      {
        id: "gpt-unlisted-test",
        contextLength: 400_000,
        maxOutputTokens: 64_000,
      },
    );
    const llm = new OpenAI({
      model: "gpt-unlisted-test",
      apiKey: "k1",
      contextLength: 32_000,
      completionOptions: { model: "gpt-unlisted-test", maxTokens: 1000 },
    });
    expect(llm.contextLength).toBe(32_000);
    expect(llm.completionOptions.maxTokens).toBe(1000);
  });

  it("with model information updates off the cached answer is ignored", () => {
    writeCachedModelFacts(
      { provider: "openai", apiKey: "k1", model: "gpt-unlisted-test" },
      { id: "gpt-unlisted-test", contextLength: 400_000 },
    );
    process.env[MODEL_INFO_UPDATES_ENV] = "off";
    clearProviderInfoMemory();
    const llm = new OpenAI({ model: "gpt-unlisted-test", apiKey: "k1" });
    expect(llm.contextLength).not.toBe(400_000);
  });

  it("a later answer applies to the running model, and Anthropic's default cap is never raised", () => {
    const llm = new Anthropic({ model: "claude-opus-5-5", apiKey: "k" });
    const before = llm.completionOptions.maxTokens;
    llm.applyProviderModelFacts({
      contextLength: 900_000,
      maxOutputTokens: 128_000,
    });
    expect(llm.contextLength).toBe(900_000);
    expect(llm.completionOptions.maxTokens).toBe(before);
    llm.applyProviderModelFacts({ maxOutputTokens: 1024 });
    expect(llm.completionOptions.maxTokens).toBe(Math.min(before!, 1024));
  });

  it("a later answer never overrides a configured window", () => {
    const llm = new Anthropic({
      model: "claude-opus-5-5",
      apiKey: "k",
      contextLength: 50_000,
    });
    llm.applyProviderModelFacts({ contextLength: 900_000 });
    expect(llm.contextLength).toBe(50_000);
  });
});
