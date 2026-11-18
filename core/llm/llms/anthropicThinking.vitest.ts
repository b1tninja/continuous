import { describe, expect, test } from "vitest";
import {
  budgetTokensToEffort,
  getAnthropicThinkingParams,
  supportsAdaptiveThinking,
  thinkingDisplayDefaultsToOmitted,
  thinksByDefault,
} from "./anthropicThinking.js";

describe("supportsAdaptiveThinking", () => {
  test.each([
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-sonnet-4-7",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "anthropic.claude-haiku-5-5",
    "us.anthropic.claude-opus-5-5",
  ])("%s uses adaptive thinking", (model) => {
    expect(supportsAdaptiveThinking(model)).toBe(true);
  });

  test.each([
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-sonnet-20240620",
    "gpt-4o",
  ])("%s keeps enabled thinking", (model) => {
    expect(supportsAdaptiveThinking(model)).toBe(false);
  });
});

describe("budgetTokensToEffort", () => {
  test("maps GUI budgets to effort levels", () => {
    expect(budgetTokensToEffort(1024)).toBe("low");
    expect(budgetTokensToEffort(4096)).toBe("medium");
    expect(budgetTokensToEffort(16384)).toBe("high");
  });
});

describe("getAnthropicThinkingParams", () => {
  test("returns no thinking fields when reasoning is off", () => {
    expect(
      getAnthropicThinkingParams({ model: "claude-sonnet-4-6" } as any),
    ).toEqual({});
  });

  test("uses adaptive thinking with effort for newer models", () => {
    expect(
      getAnthropicThinkingParams({
        model: "claude-sonnet-4-6",
        reasoning: true,
        reasoningBudgetTokens: 4096,
      } as any),
    ).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  test("keeps enabled thinking with budget for older models", () => {
    expect(
      getAnthropicThinkingParams({
        model: "claude-sonnet-4-20250514",
        reasoning: true,
        reasoningBudgetTokens: 2048,
      } as any),
    ).toEqual({
      thinking: { type: "enabled", budget_tokens: 2048 },
    });
  });
});

describe("thinking display", () => {
  test.each([
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-2",
    "claude-mythos-5-2",
    "us.anthropic.claude-opus-5-5",
  ])("%s hides its thinking unless asked", (model) => {
    expect(thinkingDisplayDefaultsToOmitted(model)).toBe(true);
  });

  test.each([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
  ])("%s shows its thinking by default", (model) => {
    expect(thinkingDisplayDefaultsToOmitted(model)).toBe(false);
  });

  test("only Claude 5 and later, Fable and Mythos think without being asked", () => {
    expect(thinksByDefault("claude-opus-5-5")).toBe(true);
    expect(thinksByDefault("claude-sonnet-5")).toBe(true);
    expect(thinksByDefault("claude-fable-5-1")).toBe(true);
    expect(thinksByDefault("claude-opus-4-8")).toBe(false);
    expect(thinksByDefault("claude-sonnet-4-6")).toBe(false);
  });

  test("asks for summarized thinking with reasoning on, where it would arrive empty", () => {
    expect(
      getAnthropicThinkingParams({
        model: "claude-opus-5-5",
        reasoning: true,
        reasoningBudgetTokens: 16384,
      } as any),
    ).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  test("asks a model that thinks anyway for summarized thinking with reasoning off, with no effort", () => {
    for (const reasoning of [false, undefined]) {
      expect(
        getAnthropicThinkingParams({
          model: "claude-sonnet-5-5",
          reasoning,
        } as any),
      ).toEqual({ thinking: { type: "adaptive", display: "summarized" } });
    }
  });

  test("sends nothing with reasoning off to a model that then does not think", () => {
    expect(
      getAnthropicThinkingParams({ model: "claude-opus-4-8" } as any),
    ).toEqual({});
  });
});
