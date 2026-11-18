import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it } from "vitest";

import { buildChatRequestBody } from "./requestBody.js";

const user = (content: string, cachePin?: boolean): ChatHistoryItem =>
  ({ message: { role: "user", content }, contextItems: [], cachePin }) as any;

const toolTurn = (id: string): ChatHistoryItem => {
  const toolCall = {
    id,
    type: "function" as const,
    function: { name: "Read", arguments: "{}" },
  };
  return {
    message: { role: "assistant", content: "", toolCalls: [toolCall] },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall,
        status: "done",
        parsedArgs: {},
        output: [{ name: "o", description: "", content: "out" }],
      },
    ],
  } as any;
};

const model = (provider: string) =>
  ({ name: "m", provider, model: "m" }) as ModelConfig;

describe("buildChatRequestBody and the fork-point pin", () => {
  // user, assistant+tool call (two OpenAI messages: assistant and tool), pinned user
  const history = [user("start"), toolTurn("c1"), user("item prompt", true)];

  it("marks the OpenAI message the pinned item produced, after the system message", () => {
    const body: any = buildChatRequestBody({
      model: model("bedrock"),
      chatHistory: history,
      systemMessage: "sys",
    });
    const roles = body.messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
    const pinnedAt = body.messages.findIndex(
      (m: any) => m.x_continue_cache_pin === true,
    );
    expect(pinnedAt).toBe(4);
    expect(body.messages[4].content).toBe("item prompt");
  });

  it.each(["anthropic", "bedrock"])("sets the mark for %s", (provider) => {
    const body: any = buildChatRequestBody({
      model: model(provider),
      chatHistory: history,
      systemMessage: "sys",
    });
    expect(JSON.stringify(body)).toContain("x_continue_cache_pin");
  });

  it.each(["openai", "ollama", "gemini"])(
    "sets no mark for %s, whose adapter passes messages through",
    (provider) => {
      const body: any = buildChatRequestBody({
        model: model(provider),
        chatHistory: history,
        systemMessage: "sys",
      });
      expect(JSON.stringify(body)).not.toContain("x_continue_cache_pin");
    },
  );

  it("sets nothing when no item is pinned", () => {
    const body: any = buildChatRequestBody({
      model: model("bedrock"),
      chatHistory: [user("start"), toolTurn("c1"), user("more")],
      systemMessage: "sys",
    });
    expect(JSON.stringify(body)).not.toContain("x_continue_cache_pin");
  });
});

describe("buildChatRequestBody and toolDialect", () => {
  const build = (m: object) =>
    buildChatRequestBody({
      model: { ...model("bedrock"), ...m } as ModelConfig,
      chatHistory: [user("hi")],
      systemMessage: "sys",
    }) as any;

  it("adds nothing without a toolDialect", () => {
    delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
    expect(build({})).not.toHaveProperty("x_continue_recover_text_tool_calls");
  });

  it("maps toolDialect onto the recovery field for Bedrock", () => {
    delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
    expect(build({ toolDialect: "qwen-xml" })).toMatchObject({
      x_continue_recover_text_tool_calls: "force:qwen-xml",
    });
  });

  it.each(["openai", "ollama", "lmstudio", "vllm"])(
    "maps toolDialect onto the recovery field for %s",
    (provider) => {
      delete process.env.CONTINUE_RECOVER_TEXT_TOOL_CALLS;
      const body = buildChatRequestBody({
        model: { ...model(provider), toolDialect: "qwen-xml" } as ModelConfig,
        chatHistory: [user("hi")],
        systemMessage: "sys",
      }) as any;
      expect(body.x_continue_recover_text_tool_calls).toBe("force:qwen-xml");
    },
  );

  it("leaves other providers alone", () => {
    const body = buildChatRequestBody({
      model: { ...model("anthropic"), toolDialect: "qwen-xml" } as ModelConfig,
      chatHistory: [user("hi")],
      systemMessage: "sys",
    }) as any;
    expect(body).not.toHaveProperty("x_continue_recover_text_tool_calls");
  });
});

describe("buildChatRequestBody normalises the history (core/llm/normalizeTurns.ts)", () => {
  const thinkingItem = (content: string): ChatHistoryItem =>
    ({ message: { role: "thinking", content }, contextItems: [] }) as any;
  const assistantItem = (content: string): ChatHistoryItem =>
    ({ message: { role: "assistant", content }, contextItems: [] }) as any;

  it("sends reasoning as nothing, not as a second assistant turn", () => {
    const body: any = buildChatRequestBody({
      model: model("openai"),
      chatHistory: [
        user("q"),
        thinkingItem("let me think"),
        assistantItem("answer"),
        user("next"),
      ],
      systemMessage: "sys",
    });
    expect(body.messages.map((m: any) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(body.messages)).not.toContain("let me think");
  });

  it("drops reasoning left without an answer by an abort", () => {
    const body: any = buildChatRequestBody({
      model: model("openai"),
      chatHistory: [user("q"), thinkingItem("half a thought"), user("again")],
      systemMessage: "sys",
    });
    expect(body.messages.map((m: any) => m.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
  });

  it("after an abort (user, user): sent as is, or merged for a strict template", () => {
    const history = [user("q"), user("q again")];
    const loose: any = buildChatRequestBody({
      model: model("openai"),
      chatHistory: history,
      systemMessage: "sys",
    });
    expect(loose.messages.map((m: any) => m.content)).toEqual([
      "sys",
      expect.stringContaining("q"),
      "q again",
    ]);
    const strict: any = buildChatRequestBody({
      model: model("vllm"),
      chatHistory: history,
      systemMessage: "sys",
    });
    expect(strict.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
    expect(strict.messages[1].content).toContain("q\n\nq again");
  });

  it("answers a tool call whose state has no result", () => {
    const turn = toolTurn("c1") as any;
    turn.message.toolCalls.push({
      id: "c2",
      type: "function",
      function: { name: "Read", arguments: "{}" },
    });
    const body: any = buildChatRequestBody({
      model: model("anthropic"),
      chatHistory: [user("q"), turn, user("next")],
      systemMessage: "sys",
    });
    const results = body.messages.filter((m: any) => m.role === "tool");
    expect(results.map((m: any) => m.tool_call_id)).toEqual(["c1", "c2"]);
  });

  it("pins the right message when reasoning comes before the pinned item", () => {
    const body: any = buildChatRequestBody({
      model: model("anthropic"),
      chatHistory: [
        user("q"),
        thinkingItem("t"),
        assistantItem("a"),
        user("pinned", true),
      ],
      systemMessage: "sys",
    });
    const pinnedAt = body.messages.findIndex(
      (m: any) => m.x_continue_cache_pin === true,
    );
    expect(body.messages[pinnedAt].content).toBe("pinned");
  });
});
