import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import {
  LEAKED_CALL_NUDGE,
  LEAKED_CALL_NUDGE_SESSION_LIMIT,
} from "core/util/turnEnd.js";
import type { ChatCompletionFunctionTool } from "openai/resources.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { services } from "../services/index.js";

import {
  NUDGE_LEAKED_CALLS_ENV,
  resetLeakedCallNudges,
} from "./leakedCallNudge.js";
import { streamChatResponse } from "./streamChatResponse.js";

/*
 * H13: a reply that is a tool call written as text ends the turn with nothing
 * done. In a headless turn it now gets one nudge, then the turn ends. Nothing
 * in the text is parsed or run.
 */

const writeTool: ChatCompletionFunctionTool = {
  type: "function",
  function: { name: "Write", parameters: { type: "object" } },
};

const handleToolCalls = vi.hoisted(() => vi.fn(async () => false));
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => [writeTool]),
    handleToolCalls,
  };
});

vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return {
    ...actual,
    getSessionTaskPlan: () => undefined,
    getSessionLoop: () => undefined,
    trackSessionUsage: vi.fn(),
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
      isHeadless: vi.fn(() => true),
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

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "write a.txt" }, contextItems: [] },
];

const LEAK =
  "<function=Write>\n<parameter=path>\na.txt\n</parameter>\n</function>";

function llmApiReplying(replies: string[]) {
  let n = 0;
  return {
    chatCompletionStream: vi.fn().mockImplementation(async () => {
      const content = replies[Math.min(n++, replies.length - 1)];
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content } }] };
        },
      };
    }),
  } as unknown as BaseLlmApi;
}

const run = (llmApi: BaseLlmApi) =>
  streamChatResponse(history, model, llmApi, new AbortController());

const lastUser = (llmApi: BaseLlmApi, call: number) => {
  const messages = vi.mocked(llmApi.chatCompletionStream).mock.calls[call][0]
    .messages as Array<{ role: string; content: unknown }>;
  return String(messages.filter((m) => m.role === "user").at(-1)?.content);
};

describe("a tool call written as text in a headless turn", () => {
  beforeEach(() => {
    vi.mocked(services.toolPermissions.isHeadless).mockReturnValue(true);
    handleToolCalls.mockClear();
    resetLeakedCallNudges();
    delete process.env[NUDGE_LEAKED_CALLS_ENV];
  });

  it("gets one nudge, and the turn ends when the model writes it again", async () => {
    const llmApi = llmApiReplying([LEAK]);
    await run(llmApi);
    // the reply, the nudge, the reply again: the cap is one nudge per turn
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(2);
    expect(lastUser(llmApi, 1)).toContain(LEAKED_CALL_NUDGE);
    // nothing in the text ran as a call
    expect(handleToolCalls).toHaveBeenCalledTimes(2);
    for (const [args] of handleToolCalls.mock.calls as unknown as Array<
      [{ toolCalls: unknown[] }]
    >) {
      expect(args.toolCalls).toEqual([]);
    }
  });

  it("ends the turn at once when the nudge is answered with a report", async () => {
    const llmApi = llmApiReplying([LEAK, "Created a.txt with the content."]);
    await run(llmApi);
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(2);
  });

  it("does not nudge a reply that only quotes the format in a code fence", async () => {
    const llmApi = llmApiReplying([
      "The format is:\n\n```xml\n" + LEAK + "\n```\n\nThat is all.",
    ]);
    await run(llmApi);
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(1);
  });

  it("does not nudge a text call to a tool that was not offered", async () => {
    const llmApi = llmApiReplying([LEAK.replace("Write", "Other")]);
    await run(llmApi);
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(1);
  });
});

describe("the nudge outside a headless turn, and its limits", () => {
  beforeEach(() => {
    vi.mocked(services.toolPermissions.isHeadless).mockReturnValue(false);
    handleToolCalls.mockClear();
    resetLeakedCallNudges();
    delete process.env[NUDGE_LEAKED_CALLS_ENV];
  });

  it("nudges once in an interactive turn too", async () => {
    const llmApi = llmApiReplying([LEAK]);
    await run(llmApi);
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(2);
    expect(lastUser(llmApi, 1)).toContain(LEAKED_CALL_NUDGE);
  });

  it("does not nudge an interactive turn that only announces a step", async () => {
    const llmApi = llmApiReplying(["Let me check the file."]);
    await run(llmApi);
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(1);
  });

  it("sends nothing extra when the setting is off", async () => {
    process.env[NUDGE_LEAKED_CALLS_ENV] = "0";
    const llmApi = llmApiReplying([LEAK]);
    await run(llmApi);
    expect(llmApi.chatCompletionStream).toHaveBeenCalledTimes(1);
  });

  it("stops after the session limit", async () => {
    let extra = 0;
    for (let i = 0; i < LEAKED_CALL_NUDGE_SESSION_LIMIT + 2; i++) {
      const llmApi = llmApiReplying([LEAK]);
      await run(llmApi);
      extra += vi.mocked(llmApi.chatCompletionStream).mock.calls.length - 1;
    }
    expect(extra).toBe(LEAKED_CALL_NUDGE_SESSION_LIMIT);
  });
});
