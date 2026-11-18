/**
 * A trimmed copy of `https://models.dev/api.json` as it answered on
 * 2026-11-13: real entries for the providers and cases the tests need, plus
 * three made-up entries (marked) for the shapes the parser must refuse. The
 * real answer was 6.1 MB with 236 providers; nothing here is fetched.
 */
export const MODELS_DEV_TRIMMED = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
    },
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    models: {
      "us.anthropic.claude-opus-4-7": {
        id: "us.anthropic.claude-opus-4-7",
        name: "Claude Opus 4.7 (US)",
        cost: {
          input: 5.5,
          output: 27.5,
          cache_read: 0.55,
          cache_write: 6.875,
        },
      },
      "global.anthropic.claude-opus-4-7": {
        id: "global.anthropic.claude-opus-4-7",
        name: "Claude Opus 4.7 (Global)",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      "mistral.ministral-3-14b-instruct": {
        id: "mistral.ministral-3-14b-instruct",
        name: "Ministral 14B 3.0",
        cost: { input: 0.2, output: 0.2 },
      },
    },
  },
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        cost: {
          input: 1.25,
          output: 10,
          cache_read: 0.125,
          tiers: [
            {
              input: 2.5,
              output: 15,
              cache_read: 0.25,
              tier: { type: "context", size: 200000 },
            },
          ],
          context_over_200k: { input: 2.5, output: 15, cache_read: 0.25 },
        },
      },
    },
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    models: {
      "mistral-large-latest": {
        id: "mistral-large-latest",
        name: "Mistral Large (latest)",
        cost: { input: 0.7, output: 2.1, cache_read: 0.07 },
      },
      // Made up: a tier this code does not understand leaves the model unpriced
      "mistral-batch-tier-example": {
        id: "mistral-batch-tier-example",
        name: "Example",
        cost: {
          input: 1,
          output: 1,
          tiers: [{ input: 0.5, output: 0.5, tier: { type: "batch" } }],
        },
      },
      // Made up: a rate that is not a number leaves the model unpriced
      "mistral-bad-rate-example": {
        id: "mistral-bad-rate-example",
        name: "Example",
        cost: { input: "0.7", output: 2.1 },
      },
      // Made up: no cost at all
      "mistral-no-cost-example": {
        id: "mistral-no-cost-example",
        name: "Example",
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.6-luna": {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        cost: {
          input: 0.2,
          output: 1.2,
          cache_read: 0.02,
          cache_write: 0.25,
          tiers: [
            {
              input: 0.4,
              output: 1.8,
              cache_read: 0.04,
              cache_write: 0.5,
              tier: { type: "context", size: 272000 },
            },
          ],
        },
      },
    },
  },
  // A reseller: not mapped to any Continuous provider, so never used
  "302ai": {
    id: "302ai",
    name: "302.AI",
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
    },
  },
};
