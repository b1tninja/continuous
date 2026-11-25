import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import { reviewerCandidates } from "./reviewerModels";

const m = (title: string, provider: string) =>
  ({ title, provider, model: title }) as ModelDescription;

describe("the models the reviewer may be", () => {
  it("is every chat-capable model of the active config, from any provider, each once", () => {
    const local = m("Strata act", "openai");
    const bedrock = m("Sonnet (Bedrock)", "bedrock");
    const out = reviewerCandidates({
      chat: [local, bedrock],
      edit: [local],
      apply: [local],
      reviewer: [bedrock],
    });
    expect(out.map((x) => x.title)).toEqual(["Strata act", "Sonnet (Bedrock)"]);
  });

  it("is not limited to models that list the reviewer role", () => {
    const only = m("Local", "openai");
    expect(reviewerCandidates({ chat: [only], reviewer: [] })).toEqual([only]);
  });

  it("leaves out embedding, reranking and autocomplete models", () => {
    const out = reviewerCandidates({
      chat: [m("Chat", "openai")],
      embed: [m("Embed", "openai")],
      rerank: [m("Rerank", "cohere")],
      autocomplete: [m("Tab", "openai")],
    });
    expect(out.map((x) => x.title)).toEqual(["Chat"]);
  });

  it("is empty for a config with no models", () => {
    expect(reviewerCandidates(undefined)).toEqual([]);
    expect(reviewerCandidates({})).toEqual([]);
  });
});
