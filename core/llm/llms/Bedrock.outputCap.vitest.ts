import { describe, expect, it } from "vitest";

import Bedrock from "./Bedrock";

describe("Claude output cap on a Bedrock request", () => {
  it("raises maxTokens that is not above the thinking budget", () => {
    const bedrock = new Bedrock({
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      region: "us-east-1",
    });
    const input = (
      bedrock as unknown as {
        _generateConverseInput: (
          messages: unknown[],
          options: unknown,
        ) => {
          inferenceConfig: { maxTokens?: number };
        };
      }
    )._generateConverseInput([{ role: "user", content: "hi" }], {
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      reasoning: true,
      reasoningBudgetTokens: 1024,
      maxTokens: 300,
    });
    expect(input.inferenceConfig.maxTokens).toBe(5120);
  });
});
