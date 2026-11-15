import type {
  ChatMessage,
  ModelDescription,
  PromptLog,
  SubagentRunState,
  ToolCallState,
} from "core";
import { EXPLORE_AGENT, SubagentDefinition } from "core/subagents/definitions";
import { serializeTool } from "core/tools";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  grepSearchTool,
  readFileTool,
  runTerminalCommandTool,
} from "core/tools/definitions";
import { buildSubagentTool } from "core/tools/definitions/subagent";
import { ToCoreProtocol } from "core/protocol";
import { renderChatMessage } from "core/util/messageContent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { abortStream } from "../../redux/slices/sessionSlice";
import { RootState } from "../../redux/store";
import { createMockStore, getEmptyRootState } from "../test/mockStore";
import {
  answerSubagentApproval,
  cancelInboxMessage,
  peekInbox,
  sendToSubagent,
  stopSubagentRun,
} from "./registry";
import { runSubagentTool } from "./runSubagent";

const model: ModelDescription = {
  title: "Claude",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
};

const RUNNER: SubagentDefinition = {
  name: "runner",
  description: "Runs commands",
  prompt: "Run what you are asked to.",
  tools: ["Bash", "Read"],
  source: "workspace-claude",
};

const TOOLS = [
  serializeTool(readFileTool),
  serializeTool(grepSearchTool),
  serializeTool(runTerminalCommandTool),
  buildSubagentTool([EXPLORE_AGENT, RUNNER]),
];

function subagentCall(id: string): ToolCallState {
  const args = { agent: "Explore", prompt: "Find foo", description: "find" };
  return {
    toolCallId: id,
    status: "calling",
    parsedArgs: args,
    toolCall: {
      id,
      type: "function",
      function: {
        name: BuiltInToolNames.Subagent,
        arguments: JSON.stringify(args),
      },
    },
  };
}

function makeStore(callIds: string[], ui: Partial<RootState["ui"]> = {}) {
  const empty = getEmptyRootState();
  const calls = callIds.map(subagentCall);
  const messenger = new MockIdeMessenger();
  messenger.responses["subagents/list"] = {
    agents: [EXPLORE_AGENT, RUNNER],
    errors: [],
  };
  const store = createMockStore(
    {
      config: {
        ...empty.config,
        config: {
          ...empty.config.config,
          tools: TOOLS,
          modelsByRole: { ...empty.config.config.modelsByRole, chat: [model] },
          selectedModelByRole: {
            ...empty.config.config.selectedModelByRole,
            chat: model,
          },
        },
      },
      ui: { ...empty.ui, ...ui },
      session: {
        ...empty.session,
        isStreaming: true,
        history: [
          {
            message: { id: "u", role: "user", content: "hi" },
            contextItems: [],
          },
          {
            message: {
              id: "a",
              role: "assistant",
              content: "",
              toolCalls: calls.map((c) => c.toolCall),
            },
            contextItems: [],
            toolCallStates: calls,
          },
        ],
      },
    },
    messenger,
  );
  return { store, messenger };
}

type Turn =
  ChatMessage[] | ((signal: AbortSignal) => AsyncGenerator<ChatMessage[]>);

/** Each model call answers with the next turn; records what was sent. */
function script(messenger: MockIdeMessenger, turns: Turn[]) {
  const requests: ToCoreProtocol["llm/streamChat"][0][] = [];
  messenger.llmStreamChat = async function* (msg, signal) {
    requests.push(msg);
    const turn = turns.shift();
    if (!turn) throw new Error("no more turns");
    if (typeof turn === "function") {
      yield* turn(signal);
    } else {
      for (const chunk of turn) yield [chunk];
    }
    return undefined as PromptLog | undefined;
  };
  return requests;
}

function toolCallChunk(id: string, name: string, args: object): ChatMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

function runOf(store: any, id: string): SubagentRunState | undefined {
  const state = store.getState() as RootState;
  return state.session.history[1].toolCallStates?.find(
    (c) => c.toolCallId === id,
  )?.subagent;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(check()).toBe(true);
}

/** A turn that writes some text, then waits until its run is cancelled. */
function blockingTurn(text: string, started?: () => void): Turn {
  return async function* (signal) {
    started?.();
    yield [{ role: "assistant", content: text }];
    await new Promise<void>((resolve) =>
      signal.aborted
        ? resolve()
        : signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
}

function extras(store: any, messenger: MockIdeMessenger) {
  return {
    dispatch: store.dispatch,
    getState: store.getState,
    ideMessenger: messenger,
  };
}

const args = (agent = "Explore") => ({
  agent,
  prompt: "Find foo",
  description: "find",
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSubagentTool", () => {
  it("runs a fresh conversation with the agent's tools and returns only its answer and metadata", async () => {
    const { store, messenger } = makeStore(["s1"]);
    const requests = script(messenger, [
      [toolCallChunk("c1", BuiltInToolNames.GrepSearch, { query: "foo" })],
      [{ role: "assistant", content: "foo is in a.ts:3" }],
    ]);

    const result = await runSubagentTool(
      args(),
      "s1",
      extras(store, messenger),
    );

    // Fresh context: the agent's system prompt and the prompt, nothing of
    // the parent conversation
    const first = requests[0];
    expect(first.messages[0].role).toBe("system");
    expect(first.messages[0].content).toContain("You are Explore");
    expect(first.messages).toHaveLength(2);
    expect(first.messages[1].role).toBe("user");
    expect(renderChatMessage(first.messages[1])).toBe("Find foo");
    // Explore's tools that the parent has; never the subagent tool or the
    // terminal
    expect(
      first.completionOptions.tools?.map((t) => t.function.name).sort(),
    ).toEqual([BuiltInToolNames.GrepSearch, BuiltInToolNames.ReadFile]);
    expect(first.title).toBe("Claude");
    // The subagent itself sees its tool's output
    expect(JSON.stringify(requests[1].messages)).toContain(
      "Tool call executed successfully",
    );

    expect(result.respondImmediately).toBe(true);
    const content = result.output![0].content;
    expect(content).toContain("foo is in a.ts:3");
    expect(content).toContain("status: completed");
    expect(content).toContain("- grep_search foo (done)");
    // ...but the parent does not
    expect(content).not.toContain("Tool call executed successfully");

    const run = runOf(store, "s1")!;
    expect(run.status).toBe("completed");
    expect(run.model).toBe("Claude");
    expect(run.text).toBe("foo is in a.ts:3");
    expect(run.toolCalls).toEqual([
      { name: "grep_search", summary: "foo", status: "done" },
    ]);
  });

  it("asks the person on the card when the parent's policy asks, and a rejection skips the call", async () => {
    const { store, messenger } = makeStore(["s1"], {
      toolSettings: {
        [BuiltInToolNames.RunTerminalCommand]: "allowedWithPermission",
      },
    });
    const request = vi.spyOn(messenger, "request");
    script(messenger, [
      [
        toolCallChunk("c1", BuiltInToolNames.RunTerminalCommand, {
          command: "rm -rf build",
        }),
      ],
      [{ role: "assistant", content: "Could not clean." }],
    ]);

    const done = runSubagentTool(
      args("runner"),
      "s1",
      extras(store, messenger),
    );
    await until(() => !!runOf(store, "s1")?.pendingApproval);
    const pending = runOf(store, "s1")!.pendingApproval!;
    expect(pending.toolName).toBe(BuiltInToolNames.RunTerminalCommand);
    expect(pending.summary).toBe("rm -rf build");

    expect(answerSubagentApproval(pending.id, false)).toBe(true);
    const result = await done;

    expect(
      request.mock.calls.filter(([type]) => type === "tools/call"),
    ).toHaveLength(0);
    const run = runOf(store, "s1")!;
    expect(run.pendingApproval).toBeUndefined();
    expect(run.toolCalls[0].status).toBe("canceled");
    expect(result.output![0].content).toContain(
      "- run_terminal_command rm -rf build (canceled)",
    );
  });

  it("runs an asked-about call once the person allows it", async () => {
    const { store, messenger } = makeStore(["s1"], {
      toolSettings: {
        [BuiltInToolNames.RunTerminalCommand]: "allowedWithPermission",
      },
    });
    const request = vi.spyOn(messenger, "request");
    script(messenger, [
      [
        toolCallChunk("c1", BuiltInToolNames.RunTerminalCommand, {
          command: "ls",
        }),
      ],
      [{ role: "assistant", content: "Listed." }],
    ]);
    const done = runSubagentTool(
      args("runner"),
      "s1",
      extras(store, messenger),
    );
    await until(() => !!runOf(store, "s1")?.pendingApproval);
    answerSubagentApproval(runOf(store, "s1")!.pendingApproval!.id, true);
    await done;
    expect(
      request.mock.calls.filter(([type]) => type === "tools/call"),
    ).toHaveLength(1);
    expect(runOf(store, "s1")!.toolCalls[0].status).toBe("done");
  });

  it("refuses a call the parent's policies refuse, without asking", async () => {
    const { store, messenger } = makeStore(["s1"]);
    messenger.responseHandlers["tools/evaluatePolicy"] = async () => ({
      policy: "disabled",
      reason: "deny rule",
    });
    script(messenger, [
      [
        toolCallChunk("c1", BuiltInToolNames.RunTerminalCommand, {
          command: "ls",
        }),
      ],
      [{ role: "assistant", content: "Refused." }],
    ]);
    await runSubagentTool(args("runner"), "s1", extras(store, messenger));
    const run = runOf(store, "s1")!;
    expect(run.toolCalls[0].status).toBe("errored");
    expect(run.status).toBe("completed");
  });

  it("refuses a tool the model names but the agent was not given", async () => {
    const { store, messenger } = makeStore(["s1"]);
    script(messenger, [
      [toolCallChunk("c1", BuiltInToolNames.Subagent, args())],
      [{ role: "assistant", content: "ok" }],
    ]);
    const request = vi.spyOn(messenger, "request");
    await runSubagentTool(args(), "s1", extras(store, messenger));
    expect(runOf(store, "s1")!.toolCalls[0]).toMatchObject({
      name: BuiltInToolNames.Subagent,
      status: "errored",
    });
    expect(
      request.mock.calls.filter(([type]) => type === "tools/call"),
    ).toHaveLength(0);
  });

  it("is cancelled with the parent and returns what it wrote, without continuing the parent", async () => {
    const { store, messenger } = makeStore(["s1"]);
    script(messenger, [blockingTurn("partial findings")]);
    const done = runSubagentTool(args(), "s1", extras(store, messenger));
    await until(() => runOf(store, "s1")?.text === "partial findings");

    store.dispatch(abortStream());
    const result = await done;

    expect(result.respondImmediately).toBe(false);
    const content = result.output![0].content;
    expect(content).toContain("partial findings");
    expect(content).toContain("status: cancelled");
    expect(content).toContain("reason: The parent conversation was stopped");
    expect(runOf(store, "s1")!.status).toBe("cancelled");
    const state = store.getState() as RootState;
    expect(state.session.history[1].toolCallStates![0].status).toBe("done");
  });

  it("stops one run from its card and lets the parent carry on", async () => {
    const { store, messenger } = makeStore(["s1"]);
    script(messenger, [blockingTurn("halfway")]);
    const done = runSubagentTool(args(), "s1", extras(store, messenger));
    await until(() => runOf(store, "s1")?.status === "running");

    expect(stopSubagentRun("s1")).toBe(true);
    const result = await done;
    expect(result.respondImmediately).toBe(true);
    expect(result.output![0].content).toContain("reason: Stopped by the user");
    expect(runOf(store, "s1")!.status).toBe("cancelled");
    expect(stopSubagentRun("s1")).toBe(false);
  });

  it("stops as partial at its turn limit", async () => {
    const { store, messenger } = makeStore(["s1"]);
    messenger.responses["subagents/list"] = {
      agents: [{ ...EXPLORE_AGENT, maxTurns: 1 }],
      errors: [],
    };
    script(messenger, [
      [
        { role: "assistant", content: "Looking." },
        toolCallChunk("c1", BuiltInToolNames.GrepSearch, { query: "foo" }),
      ],
    ]);
    const result = await runSubagentTool(
      args(),
      "s1",
      extras(store, messenger),
    );
    expect(runOf(store, "s1")!.status).toBe("partial");
    expect(result.output![0].content).toContain("Looking.");
    expect(result.output![0].content).toContain(
      "reason: Stopped after 1 model calls",
    );
  });

  it("fails with the reason when the agent does not exist", async () => {
    const { store, messenger } = makeStore(["s1"]);
    const result = await runSubagentTool(
      args("nobody"),
      "s1",
      extras(store, messenger),
    );
    expect(result.output![0].content).toContain("status: failed");
    expect(result.output![0].content).toContain('No subagent named "nobody"');
    expect(runOf(store, "s1")!.status).toBe("failed");
  });

  it("runs at most three at once; the rest wait as queued", async () => {
    const ids = ["s1", "s2", "s3", "s4"];
    const { store, messenger } = makeStore(ids, {
      // Caching off, so the prefix gate does not hold the siblings back
      promptCacheSettings: { Claude: "off" },
    });
    script(
      messenger,
      ids.map((id) => blockingTurn(id)),
    );
    const runs = ids.map((id) =>
      runSubagentTool(args(), id, extras(store, messenger)),
    );
    await until(
      () =>
        ids.filter((id) => runOf(store, id)?.status === "running").length === 3,
    );
    expect(runOf(store, "s4")!.status).toBe("queued");

    stopSubagentRun("s1");
    await until(() => runOf(store, "s4")?.status === "running");
    store.dispatch(abortStream());
    await Promise.all(runs);
    expect(ids.map((id) => runOf(store, id)!.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("runs one at a time on a local server that serves one request at once", async () => {
    model.apiBase = "http://127.0.0.1:8083/v1/";
    try {
      const ids = ["s1", "s2"];
      const { store, messenger } = makeStore(ids, {
        promptCacheSettings: { Claude: "off" },
      });
      const asked: unknown[] = [];
      messenger.responseHandlers["models/serverConcurrency"] = async (req) => {
        asked.push(req);
        return 1;
      };
      script(
        messenger,
        ids.map((id) => blockingTurn(id)),
      );
      const runs = ids.map((id) =>
        runSubagentTool(args(), id, extras(store, messenger)),
      );
      await until(() => runOf(store, "s1")?.status === "running");
      // The window has room for three, but the server has one slot
      expect(runOf(store, "s2")!.status).toBe("queued");
      expect(asked[0]).toEqual({ title: "Claude" });

      stopSubagentRun("s1");
      await until(() => runOf(store, "s2")?.status === "running");
      store.dispatch(abortStream());
      await Promise.all(runs);
    } finally {
      delete model.apiBase;
    }
  });

  it("with caching on, holds a sibling's first request until the first run's response starts", async () => {
    const { store, messenger } = makeStore(["s1", "s2"], {
      promptCacheSettings: { Claude: "5m" },
    });
    let releaseFirst!: () => void;
    const firstMayAnswer = new Promise<void>((r) => (releaseFirst = r));
    const requests = script(messenger, [
      async function* () {
        await firstMayAnswer;
        yield [{ role: "assistant", content: "one" }];
      },
      [{ role: "assistant", content: "two" }],
    ]);

    const first = runSubagentTool(args(), "s1", extras(store, messenger));
    await until(() => requests.length === 1);
    const second = runSubagentTool(args(), "s2", extras(store, messenger));
    await until(() => runOf(store, "s2")?.status === "running");
    await new Promise((r) => setTimeout(r, 30));
    expect(requests).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(requests).toHaveLength(2);
    expect(requests[0].completionOptions.promptCaching).toBe(true);
  });
});

/** A turn that sends the person's messages while it streams, then answers. */
function sendingTurn(
  send: () => void,
  ...chunks: ChatMessage[]
): (signal: AbortSignal) => AsyncGenerator<ChatMessage[]> {
  return async function* () {
    send();
    for (const chunk of chunks) yield [chunk];
  };
}

const userTexts = (request: { messages: ChatMessage[] }) =>
  request.messages
    .filter((m) => m.role === "user")
    .map((m) => renderChatMessage(m));

const wrapped = (text: string) =>
  `<message from="person">\n${text}\n</message>`;

describe("messages from the person to a running subagent", () => {
  it("puts a Send now message after the tool results, wrapped as the person's, in the next request", async () => {
    const { store, messenger } = makeStore(["s1"]);
    const requests = script(messenger, [
      sendingTurn(
        () =>
          expect(sendToSubagent("s1", "Skip tests/", { steer: true })).toBe(
            "queued",
          ),
        toolCallChunk("c1", BuiltInToolNames.GrepSearch, { query: "foo" }),
      ),
      [{ role: "assistant", content: "foo is in a.ts:3, tests skipped" }],
    ]);

    await runSubagentTool(args(), "s1", extras(store, messenger));

    expect(requests).toHaveLength(2);
    expect(userTexts(requests[0])).toEqual(["Find foo"]);
    const roles = requests[1].messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(userTexts(requests[1])[1]).toBe(wrapped("Skip tests/"));
    const run = runOf(store, "s1")!;
    expect(run.status).toBe("completed");
    expect(run.text).toBe("foo is in a.ts:3, tests skipped");
    expect(run.messages).toEqual([
      { text: "Skip tests/", at: expect.any(Number), delivered: true },
    ]);
    expect(peekInbox("s1")).toHaveLength(0);
  });

  it("keeps a queued message until the run would finish, then continues with it as one more model call", async () => {
    const { store, messenger } = makeStore(["s1"]);
    const requests = script(messenger, [
      sendingTurn(
        () => sendToSubagent("s1", "Also check b.ts", { steer: false }),
        toolCallChunk("c1", BuiltInToolNames.GrepSearch, { query: "foo" }),
      ),
      [{ role: "assistant", content: "foo is in a.ts:3" }],
      [{ role: "assistant", content: "foo is in a.ts:3 and b.ts:9" }],
    ]);

    const result = await runSubagentTool(
      args(),
      "s1",
      extras(store, messenger),
    );

    // Not at the tool boundary: only Send now goes in there
    expect(userTexts(requests[1])).toEqual(["Find foo"]);
    expect(requests).toHaveLength(3);
    expect(requests[2].messages.map((m) => m.role).slice(-2)).toEqual([
      "assistant",
      "user",
    ]);
    expect(userTexts(requests[2]).at(-1)).toBe(wrapped("Also check b.ts"));
    expect(result.output![0].content).toContain("foo is in a.ts:3 and b.ts:9");
    expect(runOf(store, "s1")!.messages?.map((m) => m.delivered)).toEqual([
      true,
    ]);
  });

  it("delivers several messages as one user message in the order sent, Send now at the boundary and the rest at the end", async () => {
    const { store, messenger } = makeStore(["s1"]);
    const requests = script(messenger, [
      sendingTurn(
        () => {
          sendToSubagent("s1", "one (queued)", { steer: false });
          sendToSubagent("s1", "two (now)", { steer: true });
          sendToSubagent("s1", "three (now)", { steer: true });
          sendToSubagent("s1", "four (queued)", { steer: false });
        },
        toolCallChunk("c1", BuiltInToolNames.GrepSearch, { query: "foo" }),
      ),
      [{ role: "assistant", content: "first answer" }],
      [{ role: "assistant", content: "final answer" }],
    ]);

    await runSubagentTool(args(), "s1", extras(store, messenger));

    expect(userTexts(requests[1]).at(-1)).toBe(
      `${wrapped("two (now)")}\n\n${wrapped("three (now)")}`,
    );
    expect(userTexts(requests[2]).at(-1)).toBe(
      `${wrapped("one (queued)")}\n\n${wrapped("four (queued)")}`,
    );
    expect(runOf(store, "s1")!.messages?.map((m) => m.text)).toEqual([
      "two (now)",
      "three (now)",
      "one (queued)",
      "four (queued)",
    ]);
  });

  it("never delivers a message cancelled before delivery", async () => {
    const { store, messenger } = makeStore(["s1"]);
    const requests = script(messenger, [
      sendingTurn(
        () => {
          sendToSubagent("s1", "never mind", { steer: true });
          const [queued] = peekInbox("s1");
          expect(cancelInboxMessage("s1", queued.id)).toBe(true);
          expect(cancelInboxMessage("s1", queued.id)).toBe(false);
        },
        toolCallChunk("c1", BuiltInToolNames.GrepSearch, { query: "foo" }),
      ),
      [{ role: "assistant", content: "done" }],
    ]);

    await runSubagentTool(args(), "s1", extras(store, messenger));

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).not.toContain("never mind");
    expect(runOf(store, "s1")!.messages).toBeUndefined();
  });

  it("reports messages the run ended before reading: stopped by the person", async () => {
    const { store, messenger } = makeStore(["s1"]);
    script(messenger, [blockingTurn("halfway")]);
    const done = runSubagentTool(args(), "s1", extras(store, messenger));
    await until(() => runOf(store, "s1")?.status === "running");
    sendToSubagent("s1", "and then b.ts", { steer: false });
    stopSubagentRun("s1");
    const result = await done;

    const run = runOf(store, "s1")!;
    expect(run.status).toBe("cancelled");
    expect(run.messages).toEqual([
      { text: "and then b.ts", at: expect.any(Number), delivered: false },
    ]);
    expect(run.notices).toContain(
      "Your message was not delivered: the run ended first.",
    );
    // The parent model is not told what the person wrote to the subagent
    expect(result.output![0].content).not.toContain("and then b.ts");
    expect(peekInbox("s1")).toHaveLength(0);
    // The run has ended: nothing more is accepted
    expect(sendToSubagent("s1", "late", { steer: true })).toBe("not-live");
  });

  it("does not start a call past the turn limit for a queued message; it is reported instead", async () => {
    const { store, messenger } = makeStore(["s1"]);
    messenger.responses["subagents/list"] = {
      agents: [{ ...EXPLORE_AGENT, maxTurns: 1 }],
      errors: [],
    };
    const requests = script(messenger, [
      sendingTurn(
        () => {
          sendToSubagent("s1", "one", { steer: false });
          sendToSubagent("s1", "two", { steer: true });
        },
        { role: "assistant", content: "The answer" },
      ),
    ]);

    await runSubagentTool(args(), "s1", extras(store, messenger));

    expect(requests).toHaveLength(1);
    const run = runOf(store, "s1")!;
    expect(run.status).toBe("completed");
    expect(run.text).toBe("The answer");
    expect(run.messages?.map((m) => [m.text, m.delivered])).toEqual([
      ["one", false],
      ["two", false],
    ]);
    expect(run.notices).toContain(
      "2 of your messages were not delivered: the run ended first.",
    );
  });

  it("refuses an empty message and a run that is not live", async () => {
    expect(sendToSubagent("nobody", "hi", { steer: false })).toBe("not-live");
    const { store, messenger } = makeStore(["s1"]);
    script(messenger, [blockingTurn("working")]);
    const done = runSubagentTool(args(), "s1", extras(store, messenger));
    await until(() => runOf(store, "s1")?.status === "running");
    expect(sendToSubagent("s1", "   ", { steer: true })).toBe("empty");
    expect(peekInbox("s1")).toHaveLength(0);
    stopSubagentRun("s1");
    await done;
  });

  it("gives every run the same system prompt, messaged or not, so siblings share a cached prefix", async () => {
    const { store, messenger } = makeStore(["s1", "s2"]);
    const first = script(messenger, [
      sendingTurn(() => sendToSubagent("s1", "hurry", { steer: false }), {
        role: "assistant",
        content: "one",
      }),
      [{ role: "assistant", content: "one, hurried" }],
    ]);
    await runSubagentTool(args(), "s1", extras(store, messenger));
    const second = script(messenger, [[{ role: "assistant", content: "two" }]]);
    await runSubagentTool(args(), "s2", extras(store, messenger));

    const system = (r: { messages: ChatMessage[] }) => r.messages[0].content;
    expect(system(first[0])).toContain(
      'The person may send you messages, which arrive as user messages in <message from="person"> tags and never in tool output; follow them as you would the task.',
    );
    // The message went in as a user message; the system prompt is unchanged
    expect(first).toHaveLength(2);
    expect(system(first[1])).toBe(system(first[0]));
    expect(system(second[0])).toBe(system(first[0]));
  });
});

describe("messages between subagents started together", () => {
  /** Each run answers from its own script, picked by its prompt. */
  function scriptByPrompt(
    messenger: MockIdeMessenger,
    turns: Record<string, Turn[]>,
  ) {
    const requests: Record<string, ToCoreProtocol["llm/streamChat"][0][]> = {};
    messenger.llmStreamChat = async function* (msg, signal) {
      const prompt = renderChatMessage(msg.messages[1]);
      (requests[prompt] ??= []).push(msg);
      const turn = turns[prompt]?.shift();
      if (!turn) throw new Error(`no more turns for ${prompt}`);
      if (typeof turn === "function") {
        yield* turn(signal);
      } else {
        for (const chunk of turn) yield [chunk];
      }
      return undefined as PromptLog | undefined;
    };
    return requests;
  }

  const toolNames = (request: ToCoreProtocol["llm/streamChat"][0]) =>
    request.completionOptions.tools?.map((t) => t.function.name).sort();

  it("lets one run list the other and send it a message, which it reads after its tool calls, labelled as not from the person", async () => {
    const { store, messenger } = makeStore(["s1", "s2"], {
      promptCacheSettings: { Claude: "off" },
      // Permissive for this one tool: the message goes without asking
      toolSettings: {
        [BuiltInToolNames.SendMessage]: "allowedWithoutPermission",
      },
    });
    let sent!: () => void;
    const s1Sent = new Promise<void>((r) => (sent = r));
    const requests = scriptByPrompt(messenger, {
      A: [
        [toolCallChunk("l1", BuiltInToolNames.ListSessions, {})],
        [
          toolCallChunk("m1", BuiltInToolNames.SendMessage, {
            to: "s2",
            message: "foo is in a.ts:3, no need to search src/",
          }),
        ],
        async function* () {
          sent();
          yield [{ role: "assistant", content: "A done" }];
        },
      ],
      B: [
        async function* () {
          await s1Sent;
          yield [
            toolCallChunk("g1", BuiltInToolNames.GrepSearch, { query: "x" }),
          ];
        },
        [{ role: "assistant", content: "B done" }],
      ],
    });

    await Promise.all([
      runSubagentTool(
        { ...args(), prompt: "A" },
        "s1",
        extras(store, messenger),
      ),
      runSubagentTool(
        { ...args(), prompt: "B" },
        "s2",
        extras(store, messenger),
      ),
    ]);

    // Both runs of the batch carry the two tools, so they keep one prefix
    expect(toolNames(requests.A[0])).toEqual(toolNames(requests.B[0]));
    expect(toolNames(requests.A[0])).toEqual(
      [
        BuiltInToolNames.GrepSearch,
        BuiltInToolNames.ListSessions,
        BuiltInToolNames.ReadFile,
        BuiltInToolNames.SendMessage,
      ].sort(),
    );
    // list_sessions names the other run, not this one
    const listed = JSON.stringify(requests.A[1].messages);
    expect(listed).toContain('id s2: Explore, \\"find\\", running');
    expect(listed).toContain("You are Explore (id s1)");
    // send_message tells the sender it was queued
    expect(JSON.stringify(requests.A[2].messages)).toContain(
      "Queued for Explore (id s2)",
    );
    // The receiver reads it after its tool results, framed as an agent's
    const last = userTexts(requests.B[1]).at(-1)!;
    expect(requests.B[1].messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect(last).toContain('<message from="agent" name="Explore" id="s1">');
    expect(last).toContain("not from the person");
    expect(last).toContain("foo is in a.ts:3, no need to search src/");
    expect(last).not.toContain('from="person"');
    expect(runOf(store, "s2")!.messages).toEqual([
      {
        text: "foo is in a.ts:3, no need to search src/",
        at: expect.any(Number),
        delivered: true,
        from: "Explore",
      },
    ]);
    // The parent reads only the reports, never the messages
    expect(runOf(store, "s1")!.text).toBe("A done");
  });

  it("asks the person before a message is sent at the default level, and a rejection sends nothing", async () => {
    const { store, messenger } = makeStore(["s1", "s2"], {
      promptCacheSettings: { Claude: "off" },
    });
    scriptByPrompt(messenger, {
      A: [
        [
          toolCallChunk("m1", BuiltInToolNames.SendMessage, {
            to: "s2",
            message: "stop searching",
          }),
        ],
        [{ role: "assistant", content: "A done" }],
      ],
      B: [blockingTurn("searching")],
    });
    const first = runSubagentTool(
      { ...args(), prompt: "A" },
      "s1",
      extras(store, messenger),
    );
    const second = runSubagentTool(
      { ...args(), prompt: "B" },
      "s2",
      extras(store, messenger),
    );
    await until(() => !!runOf(store, "s1")?.pendingApproval);
    const pending = runOf(store, "s1")!.pendingApproval!;
    expect(pending.toolName).toBe(BuiltInToolNames.SendMessage);
    answerSubagentApproval(pending.id, false);
    await first;
    expect(peekInbox("s2")).toHaveLength(0);
    expect(runOf(store, "s1")!.toolCalls).toEqual([
      expect.objectContaining({ name: "send_message", status: "canceled" }),
    ]);
    stopSubagentRun("s2");
    await second;
  });

  it("refuses a message to a run that was not started with it", async () => {
    const { store, messenger } = makeStore(["s1", "s2"], {
      promptCacheSettings: { Claude: "off" },
      toolSettings: {
        [BuiltInToolNames.SendMessage]: "allowedWithoutPermission",
      },
    });
    const requests = scriptByPrompt(messenger, {
      A: [
        [
          toolCallChunk("m1", BuiltInToolNames.SendMessage, {
            to: "elsewhere",
            message: "hi",
          }),
        ],
        [{ role: "assistant", content: "A done" }],
      ],
    });
    await runSubagentTool(
      { ...args(), prompt: "A" },
      "s1",
      extras(store, messenger),
    );
    expect(JSON.stringify(requests.A[1].messages)).toContain(
      'No subagent with id \\"elsewhere\\" was started with you',
    );
    expect(runOf(store, "s1")!.toolCalls[0].status).toBe("errored");
  });
});
