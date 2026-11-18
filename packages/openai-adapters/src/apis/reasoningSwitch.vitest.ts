import { describe, expect, it, vi } from "vitest";

import { deepSeekThinking } from "./DeepSeek.js";
import { GeminiApi, geminiThinkingControl } from "./Gemini.js";
import { OpenAIApi } from "./OpenAI.js";
import { toResponsesParams } from "./openaiResponses.js";
import { OpenRouterApi, openRouterReasoning } from "./OpenRouter.js";
import {
  openaiReasoningEffort,
  reasoningSwitch,
  requestedReasoningEffort,
  withoutReasoningEffort,
  withRequestedReasoningEffort,
} from "./reasoningSwitch.js";

const chat = (model: string, extra: Record<string, unknown> = {}) =>
  ({
    model,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  }) as any;

describe("the reasoning switch", () => {
  it("is off with none, on at a level otherwise, and unset without a value", () => {
    expect(reasoningSwitch(undefined).reasoning).toBeUndefined();
    expect(reasoningSwitch("none")).toMatchObject({ reasoning: false });
    expect(reasoningSwitch("minimal")).toMatchObject({
      reasoning: true,
      level: "low",
      budgetTokens: 1024,
    });
    expect(reasoningSwitch("medium")).toMatchObject({ budgetTokens: 4096 });
    for (const effort of ["high", "xhigh", "max"]) {
      expect(reasoningSwitch(effort)).toMatchObject({
        level: "high",
        budgetTokens: 16384,
      });
    }
  });

  it("takes the body's effort over the config's", () => {
    expect(
      requestedReasoningEffort(
        { reasoning_effort: "low" },
        { reasoning_effort: "high" },
      ),
    ).toBe("low");
    expect(requestedReasoningEffort({}, { reasoning_effort: "high" })).toBe(
      "high",
    );
    expect(requestedReasoningEffort({}, { other: 1 })).toBeUndefined();
    expect(
      withRequestedReasoningEffort(chat("m"), { reasoning_effort: "high" })
        .reasoning_effort,
    ).toBe("high");
  });

  it("removes only reasoning_effort from the config's extra body fields", () => {
    expect(
      withoutReasoningEffort({
        timeout: 5,
        extraBodyProperties: { reasoning_effort: "high", top_k: 3 },
      }),
    ).toEqual({ timeout: 5, extraBodyProperties: { top_k: 3 } });
    expect(
      withoutReasoningEffort({ extraBodyProperties: { reasoning_effort: "x" } })
        ?.extraBodyProperties,
    ).toBeUndefined();
    const untouched = { extraBodyProperties: { top_k: 3 } };
    expect(withoutReasoningEffort(untouched)).toBe(untouched);
  });
});

describe("OpenAI's own API", () => {
  it("sends the effort to reasoning models only, in values each takes", () => {
    expect(openaiReasoningEffort("gpt-4o", "high")).toBeUndefined();
    expect(openaiReasoningEffort("gpt-5.1", "none")).toBe("none");
    expect(openaiReasoningEffort("gpt-5", "none")).toBe("minimal");
    expect(openaiReasoningEffort("gpt-5-mini", "none")).toBe("minimal");
    expect(openaiReasoningEffort("o3", "none")).toBeUndefined();
    expect(openaiReasoningEffort("o4-mini", "medium")).toBe("medium");
    expect(openaiReasoningEffort("gpt-5.2", "max")).toBe("high");
    expect(openaiReasoningEffort("o3", "minimal")).toBe("low");
  });

  it("normalizes the chat body on api.openai.com and leaves other servers alone", () => {
    const official = new OpenAIApi({ provider: "openai", apiKey: "k" } as any);
    expect(
      official.modifyChatBody(chat("gpt-5.1", { reasoning_effort: "none" }))
        .reasoning_effort,
    ).toBe("none");
    expect(
      official.modifyChatBody(chat("gpt-4o", { reasoning_effort: "high" })),
    ).not.toHaveProperty("reasoning_effort");

    // The config's effort (a CLI use's modeModels effort) reaches the body too
    const withConfig = new OpenAIApi({
      provider: "openai",
      apiKey: "k",
      requestOptions: { extraBodyProperties: { reasoning_effort: "max" } },
    } as any);
    expect(withConfig.modifyChatBody(chat("o3")).reasoning_effort).toBe("high");

    const local = new OpenAIApi({
      provider: "openai",
      apiKey: "k",
      apiBase: "http://localhost:8080/v1/",
    } as any);
    expect(
      local.modifyChatBody(chat("qwen3", { reasoning_effort: "none" }))
        .reasoning_effort,
    ).toBe("none");
  });

  it("asks a Responses reasoning model for summaries unless reasoning is off", () => {
    expect(toResponsesParams(chat("gpt-5")).reasoning).toEqual({
      summary: "auto",
    });
    expect(
      toResponsesParams(chat("gpt-5", { reasoning_effort: "low" })).reasoning,
    ).toEqual({ effort: "low", summary: "auto" });
    expect(
      toResponsesParams(chat("gpt-5.1", { reasoning_effort: "none" }))
        .reasoning,
    ).toEqual({ effort: "none" });
    expect(toResponsesParams(chat("gpt-4.1")).reasoning).toBeUndefined();
  });

  it("puts the config's effort on a Responses request", async () => {
    const api = new OpenAIApi({
      provider: "openai",
      apiKey: "k",
      requestOptions: { extraBodyProperties: { reasoning_effort: "none" } },
    } as any);
    const create = vi.fn().mockResolvedValue({ output: [] });
    (api as any).openai = { responses: { create } };
    await api.responsesNonStream(chat("gpt-5"), new AbortController().signal);
    // GPT-5 has no "none": its lowest effort, which still has summaries
    expect(create.mock.calls[0][0].reasoning).toEqual({
      effort: "minimal",
      summary: "auto",
    });
  });
});

describe("OpenRouter", () => {
  it("moves the effort into its reasoning object", () => {
    const moved = openRouterReasoning(
      chat("anthropic/claude-sonnet-4.5", { reasoning_effort: "high" }),
    ) as any;
    expect(moved.reasoning).toEqual({ effort: "high" });
    expect(moved).not.toHaveProperty("reasoning_effort");
    expect(
      (openRouterReasoning(chat("x", { reasoning_effort: "none" })) as any)
        .reasoning,
    ).toEqual({ effort: "none" });
    // A reasoning object the config sets wins
    expect(
      (
        openRouterReasoning(
          chat("x", { reasoning_effort: "low", reasoning: { max_tokens: 99 } }),
        ) as any
      ).reasoning,
    ).toEqual({ max_tokens: 99 });
    expect(openRouterReasoning(chat("x"))).not.toHaveProperty("reasoning");
  });

  it("does so on the request it sends, with the config's effort", () => {
    const api = new OpenRouterApi({
      provider: "openrouter",
      apiKey: "k",
      requestOptions: { extraBodyProperties: { reasoning_effort: "medium" } },
    } as any);
    const sent = api.modifyChatBody(chat("deepseek/deepseek-r1")) as any;
    expect(sent.reasoning).toEqual({ effort: "medium" });
    expect(sent).not.toHaveProperty("reasoning_effort");
  });
});

describe("DeepSeek", () => {
  it("turns the switch into its thinking toggle", () => {
    const off = deepSeekThinking(
      chat("deepseek-chat", { reasoning_effort: "none" }),
    ) as any;
    expect(off.thinking).toEqual({ type: "disabled" });
    expect(off).not.toHaveProperty("reasoning_effort");
    const on = deepSeekThinking(
      chat("deepseek-chat", { reasoning_effort: "high" }),
    ) as any;
    expect(on.thinking).toEqual({ type: "enabled" });
    expect(on.reasoning_effort).toBe("high");
    expect(deepSeekThinking(chat("deepseek-chat"))).not.toHaveProperty(
      "thinking",
    );
  });
});

describe("Gemini", () => {
  it("sets a thinking level on Gemini 3 and a budget on 2.5", () => {
    expect(geminiThinkingControl("gemini-3-flash-preview", "none")).toEqual({
      thinkingLevel: "MINIMAL",
    });
    expect(geminiThinkingControl("gemini-3-flash-preview", "medium")).toEqual({
      thinkingLevel: "MEDIUM",
    });
    expect(geminiThinkingControl("gemini-3-pro-preview", "none")).toEqual({
      thinkingLevel: "LOW",
    });
    expect(geminiThinkingControl("gemini-3-pro-preview", "medium")).toEqual({
      thinkingLevel: "HIGH",
    });
    expect(geminiThinkingControl("gemini-2.5-flash", "none")).toEqual({
      thinkingBudget: 0,
    });
    expect(geminiThinkingControl("gemini-2.5-flash", "low")).toEqual({
      thinkingBudget: 1024,
    });
    // 2.5 Pro cannot turn thinking off: left at its default
    expect(geminiThinkingControl("gemini-2.5-pro", "none")).toEqual({});
    expect(geminiThinkingControl("gemini-2.5-pro", undefined)).toEqual({});
    expect(geminiThinkingControl("gemini-2.0-flash", "high")).toEqual({});
  });

  it("sends the control with includeThoughts, and no thoughts when thinking is off", async () => {
    async function* none() {}
    const generateContentStream = vi.fn().mockResolvedValue(none());
    const genAI = { models: { generateContentStream } } as any;
    const api = new GeminiApi({ provider: "gemini", apiKey: "k" } as any);
    for await (const _ of api.streamWithGenAI(genAI, {
      ...chat("gemini-2.5-flash", { reasoning_effort: "high" }),
      stream: true,
    })) {
    }
    expect(
      generateContentStream.mock.calls[0][0].config.thinkingConfig,
    ).toEqual({ includeThoughts: true, thinkingBudget: 16384 });

    generateContentStream.mockResolvedValue(none());
    for await (const _ of api.streamWithGenAI(genAI, {
      ...chat("gemini-2.5-flash", { reasoning_effort: "none" }),
      stream: true,
    })) {
    }
    expect(
      generateContentStream.mock.calls[1][0].config.thinkingConfig,
    ).toEqual({ thinkingBudget: 0 });
  });
});
