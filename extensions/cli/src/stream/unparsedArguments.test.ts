import type { ModelConfig } from "@continuedev/config-yaml";
import type { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import {
  incompleteToolCallResult,
  truncatedToolCallResult,
} from "core/util/truncatedJson.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";
import type { ToolCall } from "../tools/types.js";

import { handleToolCalls } from "./handleToolCalls.js";
import { resetRepeatGuard } from "./repeatGuard.js";
import { buildChatRequestBody } from "./requestBody.js";
import {
  executeStreamedToolCalls,
  preprocessStreamedToolCalls,
} from "./streamChatResponse.helpers.js";
import { processStreamingResponse } from "./streamChatResponse.js";
import { argumentsUnparsed } from "./unparsedArguments.js";

vi.mock("../services/index.js", async (original) => {
  const actual = await original<{ services: Record<string, unknown> }>();
  return {
    ...actual,
    services: {
      ...actual.services,
      chatHistory: {
        isReady: vi.fn().mockReturnValue(false),
        addAssistantMessage: vi.fn(),
        addToolResult: vi.fn(),
      },
    },
  };
});
vi.mock("./streamChatResponse.helpers.js", async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    executeStreamedToolCalls: vi.fn(actual.executeStreamedToolCalls as never),
  };
});

/** One chunk of a streamed call, with the finish reason when it is the last. */
function chunk(
  args: string,
  opts: { name?: string; finish?: string } = {},
): ChatCompletionChunk {
  return {
    id: "test",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: opts.name, arguments: args },
            },
          ],
        },
        finish_reason: (opts.finish ?? null) as never,
      },
    ],
  };
}

async function streamed(
  chunks: ChatCompletionChunk[],
  maxTokens?: number,
): Promise<ToolCall[]> {
  const llmApi = {
    chatCompletionStream: vi.fn().mockImplementation(async function* () {
      yield* chunks;
    }),
  } as unknown as BaseLlmApi;
  const result = await processStreamingResponse({
    chatHistory: [
      { message: { role: "user", content: "go" }, contextItems: [] },
    ] as never,
    model: {
      model: "m",
      provider: "test-provider",
      ...(maxTokens && { defaultCompletionOptions: { maxTokens } }),
    } as unknown as ModelConfig,
    llmApi,
    abortController: new AbortController(),
    systemMessage: "sys",
    isHeadless: true,
  });
  return result.toolCalls;
}

describe("a streamed call whose arguments did not parse", () => {
  beforeEach(() => {
    resetRepeatGuard();
    vi.mocked(executeStreamedToolCalls).mockClear();
  });

  it("is marked with core's cut-off line when the reply hit the output limit", async () => {
    const [call] = await streamed(
      [
        chunk('{"filepath":"a.txt","content":"first', { name: "Write" }),
        chunk(" half", { finish: "length" }),
      ],
      4096,
    );
    expect(call.unparsedArguments).toBe(truncatedToolCallResult("Write", 4096));
    expect(call.unparsedArguments).toContain(
      "was cut off at the output limit of 4096 tokens",
    );
    expect(call.arguments).toEqual({});
    expect(call.argumentsStr).toBe('{"filepath":"a.txt","content":"first half');
  });

  it("is marked with core's incomplete line when the reply ended normally", async () => {
    const [call] = await streamed([
      chunk('{"filepath":"a.txt","content":"x', {
        name: "Write",
        finish: "tool_calls",
      }),
    ]);
    expect(call.unparsedArguments).toBe(incompleteToolCallResult("Write"));
  });

  it("is told it was cut off when no stop reason came and the text stops part-way", async () => {
    const [call] = await streamed([chunk('{"pattern":"a', { name: "Search" })]);
    expect(call.unparsedArguments).toBe(
      truncatedToolCallResult("Search", undefined),
    );
  });

  it("does not keep the arguments of an earlier fragment that parsed", async () => {
    // Fragments of two calls on one index: the first parses, the whole does not
    const [call] = await streamed([
      chunk('{"filepath":"a.txt"}', { name: "Read" }),
      chunk('{"filepath":"b.txt"}', { finish: "tool_calls" }),
    ]);
    expect(call.unparsedArguments).toBe(incompleteToolCallResult("Read"));
    expect(call.arguments).toEqual({});
  });

  it("leaves a call with valid or no arguments alone", async () => {
    const [valid] = await streamed([
      chunk('{"filepath":"a.txt"}', { name: "Read", finish: "tool_calls" }),
    ]);
    expect(valid.unparsedArguments).toBeUndefined();
    expect(valid.arguments).toEqual({ filepath: "a.txt" });

    const [bare] = await streamed([
      chunk("", { name: "Status", finish: "tool_calls" }),
    ]);
    expect(bare.unparsedArguments).toBeUndefined();
    expect(argumentsUnparsed("  ")).toBe(false);
  });

  it("is answered with the line and never reaches a tool", async () => {
    const [call] = await streamed([
      chunk('{"timeout":', { name: "NoSuchTool", finish: "length" }),
    ]);
    const onToolError = vi.fn();
    const { preprocessedCalls, errorChatEntries } =
      await preprocessStreamedToolCalls(true, [call], { onToolError } as never);
    expect(preprocessedCalls).toEqual([]);
    // The cut-off line, not "There is no tool named NoSuchTool": nothing was looked up
    expect(errorChatEntries).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: truncatedToolCallResult("NoSuchTool", undefined),
      },
    ]);
    expect(onToolError).toHaveBeenCalledOnce();
  });

  it("keeps the text the model sent in the stored turn, and runs nothing", async () => {
    const calls = await streamed([
      chunk('{"command":"echo', { name: "Bash", finish: "length" }),
    ]);
    const history: ChatHistoryItem[] = [];
    await handleToolCalls({
      toolCalls: calls,
      chatHistory: history,
      content: "",
      callbacks: undefined,
      isHeadless: true,
    });

    const state = history[0].toolCallStates?.[0];
    expect(state?.toolCall.function.arguments).toBe('{"command":"echo');
    expect((history[0].message as any).toolCalls[0].function.arguments).toBe(
      '{"command":"echo',
    );
    expect(state?.status).toBe("errored");
    expect(state?.output?.[0].content).toBe(
      truncatedToolCallResult("Bash", undefined),
    );
    // Nothing was handed to the executor
    expect(vi.mocked(executeStreamedToolCalls).mock.calls[0][0]).toEqual([]);
    expect(services.chatHistory.addToolResult).not.toHaveBeenCalled();
  });

  it("is not mistaken for a repeat of the unparsed call before it", async () => {
    const answers: string[] = [];
    for (let round = 0; round < 3; round++) {
      const calls = await streamed([
        chunk(`{"command":"echo ${round}`, { name: "Bash", finish: "length" }),
      ]);
      const history: ChatHistoryItem[] = [];
      await handleToolCalls({
        toolCalls: calls,
        chatHistory: history,
        content: "",
        callbacks: undefined,
        isHeadless: true,
      });
      answers.push(
        String(history[0].toolCallStates?.[0].output?.[0].content ?? ""),
      );
    }
    for (const answer of answers) {
      expect(answer).toContain("was cut off at the output limit");
      expect(answer).not.toContain("already failed");
    }
    // The third round in a row still gets the invalid-round note
    expect(answers[2]).toContain("round in a row of tool calls with invalid");
  });

  it("goes out as {} in the next request", () => {
    const toolCall = {
      id: "call_1",
      type: "function" as const,
      function: { name: "Bash", arguments: '{"command":"echo' },
    };
    const history = [
      { message: { role: "user", content: "go" }, contextItems: [] },
      {
        message: { role: "assistant", content: "", toolCalls: [toolCall] },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "call_1",
            toolCall,
            status: "errored",
            parsedArgs: {},
            output: [{ name: "o", description: "", content: "cut off" }],
          },
        ],
      },
    ] as unknown as ChatHistoryItem[];
    const body: any = buildChatRequestBody({
      model: { name: "m", provider: "openai", model: "m" } as ModelConfig,
      chatHistory: history,
      systemMessage: "sys",
    });
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.arguments).toBe("{}");
    // The stored turn is not changed by building the request
    expect(toolCall.function.arguments).toBe('{"command":"echo');
  });
});
