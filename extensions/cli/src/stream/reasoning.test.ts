import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it } from "vitest";

import {
  ReasoningAccumulator,
  reasoningTextOfDelta,
  thoughtForLabel,
} from "./reasoning.js";
import {
  buildChatRequestBody,
  reasoningEffortForModel,
} from "./requestBody.js";

describe("reasoning in a delta", () => {
  it("reads every shape the adapters send, the first with text winning", () => {
    expect(reasoningTextOfDelta({ reasoning_content: "a" })).toBe("a");
    expect(reasoningTextOfDelta({ reasoning: "b" })).toBe("b");
    expect(
      reasoningTextOfDelta({
        reasoning: { content: [{ type: "reasoning_text", text: "c" }] },
      }),
    ).toBe("c");
    expect(
      reasoningTextOfDelta({
        reasoning_details: [
          { type: "reasoning.summary", summary: "d" },
          { type: "reasoning.text", text: "e" },
          { type: "reasoning.encrypted", data: "x" },
        ],
      }),
    ).toBe("de");
    expect(
      reasoningTextOfDelta({
        reasoning: "f",
        reasoning_details: [{ type: "reasoning.text", text: "f" }],
      }),
    ).toBe("f");
    expect(reasoningTextOfDelta({ content: "answer" })).toBe("");
    expect(reasoningTextOfDelta(undefined)).toBe("");
  });

  it("keeps one signed entry per thinking block, and redacted thinking, in order", () => {
    const acc = new ReasoningAccumulator();
    acc.add({ reasoning_content: "one" }, 1000);
    acc.add({ reasoning_details: [{ signature: "s1" }] }, 1100);
    acc.add(
      { reasoning_details: [{ type: "reasoning.encrypted", data: "r" }] },
      1200,
    );
    acc.add({ reasoning_content: "two" }, 1300);
    acc.add({ reasoning_details: [{ signature: "s2" }] }, 1400);
    acc.markAnswer(5000);
    acc.markAnswer(9000); // the first answer chunk counts
    const result = acc.result(10_000)!;
    expect(result.text).toBe("onetwo");
    expect(result.details).toEqual([
      { type: "reasoning.text", text: "one", signature: "s1" },
      { type: "reasoning.encrypted", data: "r" },
      { type: "reasoning.text", text: "two", signature: "s2" },
    ]);
    expect(result.startAt).toBe(1000);
    expect(result.endAt).toBe(5000);
  });

  it("has no result without reasoning, and ends at the stream's end without an answer", () => {
    const none = new ReasoningAccumulator();
    none.markAnswer(5);
    expect(none.result(10)).toBeUndefined();
    const onlyThinking = new ReasoningAccumulator();
    onlyThinking.add({ reasoning_content: "x" }, 1);
    expect(onlyThinking.result(42)?.endAt).toBe(42);
  });

  it("labels the time spent thinking", () => {
    expect(thoughtForLabel(0, 4200)).toBe("Thought for 4s");
    expect(thoughtForLabel(0, 65_000)).toBe("Thought for 1m 5s");
    expect(thoughtForLabel(10, 0)).toBe("Thought for 0s");
  });
});

const user = (content: string): ChatHistoryItem =>
  ({ message: { role: "user", content }, contextItems: [] }) as any;

const reply = (reasoning?: ChatHistoryItem["reasoning"]): ChatHistoryItem => {
  const toolCall = {
    id: "t1",
    type: "function" as const,
    function: { name: "Read", arguments: "{}" },
  };
  return {
    message: { role: "assistant", content: "Reading.", toolCalls: [toolCall] },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: "t1",
        toolCall,
        status: "done",
        parsedArgs: {},
        output: [{ name: "o", description: "", content: "out" }],
      },
    ],
    ...(reasoning && { reasoning }),
  } as any;
};

const model = (
  provider: string,
  extra: Partial<ModelConfig> = {},
): ModelConfig => ({ name: "m", provider, model: "m", ...extra }) as any;

describe("reasoning sent back", () => {
  const signed = {
    active: false,
    text: "Look first.",
    startAt: 1,
    endAt: 2,
    details: [{ type: "reasoning.text", text: "Look first.", signature: "s" }],
  };
  const history = [user("go"), reply(signed), user("next")];

  it.each(["anthropic", "vertexai"])(
    "puts Claude's signed thinking on its reply for %s",
    (provider) => {
      const body: any = buildChatRequestBody({
        model: model(provider),
        chatHistory: history,
        systemMessage: "sys",
      });
      const assistant = body.messages.find((m: any) => m.role === "assistant");
      expect(assistant.reasoning_details).toEqual(signed.details);
      expect(body.messages.map((m: any) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "tool",
        "user",
      ]);
    },
  );

  it("gives DeepSeek reasoning_content on every reply, empty when there was none", () => {
    const body: any = buildChatRequestBody({
      model: model("deepseek"),
      chatHistory: [
        user("go"),
        reply(signed),
        user("more"),
        reply(),
        user("x"),
      ],
      systemMessage: "sys",
    });
    const replies = body.messages.filter((m: any) => m.role === "assistant");
    expect(replies.map((m: any) => m.reasoning_content)).toEqual([
      "Look first.",
      "",
    ]);
    expect(replies[0]).not.toHaveProperty("reasoning_details");
  });

  it("sends nothing new to other providers", () => {
    const body: any = buildChatRequestBody({
      model: model("openai"),
      chatHistory: history,
      systemMessage: "sys",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("reasoning_details");
    expect(text).not.toContain("reasoning_content");
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});

describe("the model's reasoning setting as reasoning_effort", () => {
  it("follows defaultCompletionOptions for providers whose adapter reads it", () => {
    const on = model("anthropic", {
      defaultCompletionOptions: {
        reasoning: true,
        reasoningBudgetTokens: 16384,
      },
    } as any);
    expect(reasoningEffortForModel(on)).toBe("high");
    expect(
      reasoningEffortForModel(
        model("gemini", {
          defaultCompletionOptions: { reasoning: false },
        } as any),
      ),
    ).toBe("none");
    expect(
      reasoningEffortForModel(
        model("openrouter", {
          defaultCompletionOptions: { reasoning: true },
        } as any),
      ),
    ).toBe("medium");
    expect(
      buildChatRequestBody({
        model: on,
        chatHistory: [user("x")],
        systemMessage: "s",
      }).reasoning_effort,
    ).toBe("high");
  });

  it("sends nothing without a setting, when the config's effort is set, or to other servers", () => {
    expect(reasoningEffortForModel(model("anthropic"))).toBeUndefined();
    expect(
      reasoningEffortForModel(
        model("anthropic", {
          defaultCompletionOptions: { reasoning: true },
          requestOptions: { extraBodyProperties: { reasoning_effort: "low" } },
        } as any),
      ),
    ).toBeUndefined();
    expect(
      reasoningEffortForModel(
        model("openai", {
          apiBase: "http://localhost:8080/v1/",
          defaultCompletionOptions: { reasoning: false },
        } as any),
      ),
    ).toBeUndefined();
    expect(
      reasoningEffortForModel(
        model("openai", {
          defaultCompletionOptions: { reasoning: false },
        } as any),
      ),
    ).toBe("none");
    expect(
      reasoningEffortForModel(
        model("ollama", {
          defaultCompletionOptions: { reasoning: true },
        } as any),
      ),
    ).toBeUndefined();
  });
});
