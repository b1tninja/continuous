import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import type { ChatHistoryItem } from "core/index.js";
import { webContentStore } from "core/util/web/contentStore.js";
import { preparePage } from "core/util/web/window.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamChatResponse } from "./streamChatResponse.js";

/*
 * A turn's tool calls carry the session's web store id, and when the turn
 * ends its turn-scoped pages (no-store, credentialed, non-public) leave the
 * store (core/util/web/contentStore.ts). A compaction runs inside a turn and
 * leaves them.
 */

vi.mock("../session.js", async () => {
  const actual = await vi.importActual<object>("../session.js");
  return {
    ...actual,
    getCurrentSession: () => ({ sessionId: "cli-session" }),
    trackSessionUsage: vi.fn(),
  };
});

// Held here, not imported: importing the mocked module from the test would
// load it before streamChatResponse.js and leave the stream the real one
const tools = vi.hoisted(() => ({
  handleToolCalls: vi.fn(async (_options: { sessionId?: string }) => true),
}));
vi.mock("./handleToolCalls.js", async () => {
  const actual = await vi.importActual<object>("./handleToolCalls.js");
  return {
    ...actual,
    getRequestTools: vi.fn(async () => []),
    handleToolCalls: tools.handleToolCalls,
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

const history: ChatHistoryItem[] = [
  { message: { role: "user", content: "read the page" }, contextItems: [] },
];

const count = (text: string) => Math.ceil(text.length / 4);

function store(sessionId: string, noStore: boolean, url: string): void {
  const text = `# ${url}\n\nBody.`;
  webContentStore.recordFetchedPage({
    sessionId,
    finalUrl: url,
    acceptVariant: "text/markdown",
    text,
    page: preparePage(text, { windowTokens: 2_000, count }),
    noStore,
  });
}

/** One request; the model's reply has a tool call, so handleToolCalls runs. */
async function turn(
  options: Parameters<typeof streamChatResponse>[6] = {},
  isCompacting = false,
  fail = false,
): Promise<void> {
  const llmApi = {
    chatCompletionStream: fail
      ? vi.fn().mockRejectedValue(new Error("down"))
      : vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "Fetch", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            };
          },
        }),
  } as unknown as BaseLlmApi;
  await streamChatResponse(
    history,
    model,
    llmApi,
    new AbortController(),
    undefined,
    isCompacting,
    options,
  ).catch((e) => {
    if (!fail) throw e;
  });
}

describe("streamChatResponse and the web content store", () => {
  beforeEach(() => {
    // The tool call ends the run after it, as a final answer would
    tools.handleToolCalls.mockClear();
  });
  afterEach(() => {
    webContentStore.clearAll();
  });

  it("passes the current session's id to the tool calls", async () => {
    await turn();
    expect(tools.handleToolCalls.mock.calls[0][0].sessionId).toBe(
      "cli-session",
    );
  });

  it("passes a subagent's own store id when it has one", async () => {
    await turn({ webSessionId: "cli-session/subagent/agent-1" });
    expect(tools.handleToolCalls.mock.calls[0][0].sessionId).toBe(
      "cli-session/subagent/agent-1",
    );
  });

  it("drops the turn-scoped pages when the turn ends, and keeps the rest", async () => {
    store("cli-session", true, "https://private.example/");
    store("cli-session", false, "https://public.example/");
    await turn();
    expect(
      webContentStore
        .session("cli-session")
        .list()
        .map((e) => e.finalUrl),
    ).toEqual(["https://public.example/"]);
  });

  it("drops them when the turn ends in an error too", async () => {
    store("cli-session", true, "https://private.example/");
    await turn({}, false, true);
    expect(webContentStore.usage("cli-session").entries).toBe(0);
  });

  it("leaves them during a compaction, which is inside the turn", async () => {
    store("cli-session", true, "https://private.example/");
    await turn({}, true);
    expect(webContentStore.usage("cli-session").entries).toBe(1);
  });
});
