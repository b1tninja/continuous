import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { ACT_TURN_TAIL } from "core/llm/prompts/turns.js";
import { createLoop, startItemRun } from "core/util/loopMode.js";
import type { ChatCompletionFunctionTool } from "openai/resources.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";

import {
  processStreamingResponse,
  streamChatResponse,
} from "./streamChatResponse.js";

/*
 * The use's tail (`modeModels.<use>.tail`) goes at the end of every user
 * message of the request and nowhere else: the system message and the
 * assistant messages are the same bytes with or without it, and a message's
 * bytes never change between requests, so the cached prefix holds and each
 * request extends the one before.
 */

const session = vi.hoisted(() => ({
  loop: undefined as unknown,
}));
vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return {
    ...actual,
    getSessionTaskPlan: () => ({
      items: [{ id: "1", text: "Fix", status: "in_progress" }],
      updatedAt: "2026-11-08T12:00:00.000Z",
    }),
    getSessionLoop: () => session.loop,
    trackSessionUsage: vi.fn(),
  };
});

// No tools and no tool calls, so streamChatResponse makes one request
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls: vi.fn(async () => false),
  };
});

vi.mock("../services/index.js", () => ({
  services: {
    systemMessage: {
      getSystemMessage: vi.fn(async () => "sys"),
      turnTail: vi.fn(() => undefined),
    },
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "enabled" })),
      isHeadless: vi.fn(() => false),
    },
    chatHistory: {
      isReady: vi.fn(() => false),
      getHistory: vi.fn(() => []),
    },
  },
}));

vi.mock("../util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const model = {
  model: "us.amazon.nova-2-lite-v1:0",
  defaultCompletionOptions: { contextLength: 100_000, maxTokens: 100 },
} as ModelConfig;

const taskListTool: ChatCompletionFunctionTool = {
  type: "function",
  function: { name: "TaskList", parameters: { type: "object" } },
};

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "first" }, contextItems: [] },
  { message: { role: "assistant", content: "ok" }, contextItems: [] },
  { message: { role: "user", content: "second" }, contextItems: [] },
];

type Sent = Array<{ role: string; content: unknown }>;

function llmApiRecording() {
  const llmApi = {
    chatCompletionStream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: "ok" } }] };
      },
    }),
  } as unknown as BaseLlmApi;
  const sent = () =>
    vi.mocked(llmApi.chatCompletionStream).mock.calls[0][0].messages as Sent;
  return { llmApi, sent };
}

async function requestWith(
  turnTail: string | undefined,
  tools: ChatCompletionFunctionTool[] = [],
): Promise<Sent> {
  const { llmApi, sent } = llmApiRecording();
  await processStreamingResponse({
    chatHistory: history,
    model,
    llmApi,
    abortController: new AbortController(),
    systemMessage: "sys",
    tools,
    turnTail,
  });
  return sent();
}

describe("the tail in the CLI request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("goes last on every user message; the system and assistant messages are byte-identical without it", async () => {
    const without = await requestWith(undefined);
    const withTail = await requestWith(ACT_TURN_TAIL);
    expect(withTail.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(withTail[0])).toBe(JSON.stringify(without[0]));
    expect(JSON.stringify(withTail[2])).toBe(JSON.stringify(without[2]));
    expect(without.at(-1)?.content).toBe("second");
    expect(withTail.at(-1)?.content).toBe(`second\n\n${ACT_TURN_TAIL}`);
    // The environment block stays on the first user message, the tail after it
    const first = String(withTail[1].content);
    expect(first.startsWith('first\n\n<context name="environment">')).toBe(
      true,
    );
    expect(first.endsWith(`</context>\n\n${ACT_TURN_TAIL}`)).toBe(true);
  });

  it("keeps a later request an extension of the earlier one", async () => {
    const { llmApi, sent } = llmApiRecording();
    await processStreamingResponse({
      chatHistory: history.slice(0, 1),
      model,
      llmApi,
      abortController: new AbortController(),
      systemMessage: "sys",
      tools: [],
      turnTail: "Act.",
    });
    const earlier = sent();
    const later = await requestWith("Act.");
    expect(earlier).toHaveLength(2);
    expect(JSON.stringify(later.slice(0, 2))).toBe(JSON.stringify(earlier));
  });

  it("on a Loop item comes after the plan block, and the system message is the same as the mode's", async () => {
    const now = new Date();
    const plan = {
      items: [{ id: "1", text: "Fix", status: "in_progress" as const }],
      updatedAt: now.toISOString(),
    };
    session.loop = startItemRun(
      createLoop(plan, { now, sessionTokens: 0 }),
      "1",
      2,
      now,
    );
    // The plan block is placed by the stream for the main history, which the
    // history service holds
    vi.mocked(services.chatHistory.isReady).mockReturnValue(true);
    vi.mocked(services.chatHistory.getHistory).mockReturnValue(history);
    vi.mocked(services.systemMessage.turnTail).mockReturnValue(ACT_TURN_TAIL);
    try {
      const { llmApi, sent } = llmApiRecording();
      await streamChatResponse(history, model, llmApi, new AbortController());
      const messages = sent();
      // Fresh context: the run's request starts at the item prompt
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(messages[0].content).toBe("sys");
      const prompt = String(messages[1].content);
      expect(prompt.startsWith("second\n\n<task_list>")).toBe(true);
      expect(prompt).toContain('<context name="environment">');
      expect(prompt.endsWith(`\n\n${ACT_TURN_TAIL}`)).toBe(true);
      expect(prompt.indexOf("</task_list>")).toBeLessThan(
        prompt.indexOf(ACT_TURN_TAIL),
      );
    } finally {
      session.loop = undefined;
      vi.mocked(services.chatHistory.isReady).mockReturnValue(false);
    }
  });

  it("stays before the task list block, which is sent last", async () => {
    const messages = await requestWith("Act.", [taskListTool]);
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(messages[3].content).toBe("second\n\nAct.");
    expect(String(messages.at(-1)?.content).startsWith("<task_list>")).toBe(
      true,
    );
  });

  it("is read from the system message service for the turn's use, and left out of a compaction", async () => {
    vi.mocked(services.systemMessage.turnTail).mockReturnValue("Act.");
    const { llmApi, sent } = llmApiRecording();
    await streamChatResponse(history, model, llmApi, new AbortController());
    expect(services.systemMessage.turnTail).toHaveBeenCalledWith("agent");
    expect(sent().at(-1)?.content).toBe("second\n\nAct.");

    const compaction = llmApiRecording();
    await streamChatResponse(
      history,
      model,
      compaction.llmApi,
      new AbortController(),
      undefined,
      true,
    );
    expect(compaction.sent().at(-1)?.content).toBe("second");
  });
});
