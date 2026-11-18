import { ChatCompletionCreateParams } from "openai/resources/index";
import { describe, expect, it } from "vitest";

import Deepseek from "./llms/Deepseek";
import Gemini from "./llms/Gemini";
import OpenAI, { responsesReasoning } from "./llms/OpenAI";
import OpenRouter from "./llms/OpenRouter";
import VertexAI from "./llms/VertexAI";
import {
  reasoningEffortFromOptions,
  withReasoningEffort,
} from "./reasoningEffort";

const body = (model: string): ChatCompletionCreateParams => ({
  model,
  messages: [{ role: "user", content: "hi" }],
});

describe("the reasoning toggle as reasoning_effort", () => {
  it("is unset, none, or the effort for the budget", () => {
    expect(reasoningEffortFromOptions({})).toBeUndefined();
    expect(reasoningEffortFromOptions({ reasoning: false })).toBe("none");
    // The GUI's default budget, 2048 tokens
    expect(reasoningEffortFromOptions({ reasoning: true })).toBe("medium");
    expect(
      reasoningEffortFromOptions({
        reasoning: true,
        reasoningBudgetTokens: 1024,
      }),
    ).toBe("low");
    expect(
      reasoningEffortFromOptions({
        reasoning: true,
        reasoningBudgetTokens: 16384,
      }),
    ).toBe("high");
  });

  it("leaves a body's own effort alone, and off out when asked to", () => {
    expect(
      withReasoningEffort(
        { ...body("m"), reasoning_effort: "low" },
        { reasoning: true, reasoningBudgetTokens: 16384 },
      ).reasoning_effort,
    ).toBe("low");
    expect(
      withReasoningEffort(body("m"), { reasoning: false }, true),
    ).not.toHaveProperty("reasoning_effort");
    expect(withReasoningEffort(body("m"), {})).not.toHaveProperty(
      "reasoning_effort",
    );
  });
});

describe("the providers that forward it", () => {
  it("OpenAI forwards it on its own API only", () => {
    const official = new OpenAI({ model: "gpt-5", apiKey: "k" });
    expect(
      official["modifyChatBody"](body("gpt-5"), {
        model: "gpt-5",
        reasoning: true,
        reasoningBudgetTokens: 16384,
      }).reasoning_effort,
    ).toBe("high");
    const local = new OpenAI({
      model: "qwen3",
      apiKey: "k",
      apiBase: "http://localhost:8080/v1/",
    });
    expect(
      local["modifyChatBody"](body("qwen3"), {
        model: "qwen3",
        reasoning: false,
      }),
    ).not.toHaveProperty("reasoning_effort");
  });

  it("OpenRouter forwards on, not off (Edit and Apply ask for off on every model)", () => {
    const openRouter = new OpenRouter({ model: "x", apiKey: "k" });
    expect(
      openRouter["modifyChatBody"](body("deepseek/deepseek-r1"), {
        model: "deepseek/deepseek-r1",
        reasoning: true,
      }).reasoning_effort,
    ).toBe("medium");
    expect(
      openRouter["modifyChatBody"](body("openai/o3"), {
        model: "openai/o3",
        reasoning: false,
      }),
    ).not.toHaveProperty("reasoning_effort");
  });

  it("DeepSeek, Gemini and Vertex forward on and off", () => {
    const deepseek = new Deepseek({ model: "deepseek-chat", apiKey: "k" });
    expect(
      deepseek["modifyChatBody"](body("deepseek-chat"), {
        model: "deepseek-chat",
        reasoning: false,
      }).reasoning_effort,
    ).toBe("none");
    const gemini = new Gemini({ model: "gemini-2.5-flash", apiKey: "k" });
    expect(
      gemini["modifyChatBody"](body("gemini-2.5-flash"), {
        model: "gemini-2.5-flash",
        reasoning: true,
        reasoningBudgetTokens: 1024,
      }).reasoning_effort,
    ).toBe("low");
    const vertexClaude = new VertexAI({
      model: "claude-opus-4-6",
      projectId: "p",
      region: "us-east5",
      env: { region: "us-east5", projectId: "p" },
    });
    expect(
      vertexClaude["modifyChatBody"](body("claude-opus-4-6"), {
        model: "claude-opus-4-6",
        reasoning: true,
        reasoningBudgetTokens: 16384,
      }).reasoning_effort,
    ).toBe("high");
  });
});

describe("the Responses request's reasoning", () => {
  it("follows the toggle, and stays medium when the request says nothing", () => {
    expect(responsesReasoning("gpt-5", { reasoning: undefined })).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(
      responsesReasoning("gpt-5", {
        reasoning: true,
        reasoningBudgetTokens: 16384,
      }),
    ).toEqual({ effort: "high", summary: "auto" });
    expect(responsesReasoning("gpt-5.1", { reasoning: false })).toEqual({
      effort: "none",
    });
    expect(responsesReasoning("gpt-5", { reasoning: false })).toEqual({
      effort: "minimal",
    });
    expect(responsesReasoning("o3", { reasoning: false })).toEqual({
      effort: "low",
      summary: "auto",
    });
  });
});
