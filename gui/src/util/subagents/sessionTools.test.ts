import type { ToolCallState } from "core";
import { MAX_AGENT_MESSAGES_PER_RUN } from "core/subagents/messages";
import { BuiltInToolNames } from "core/tools/builtIn";
import { afterEach, describe, expect, it } from "vitest";
import type { RootState } from "../../redux/store";
import { getEmptyRootState } from "../test/mockStore";
import {
  agentMessagesLeft,
  peekInbox,
  registerSubagentRun,
  sendAgentMessage,
  takeInbox,
} from "./registry";
import {
  answerSessionTool,
  sessionToolsFor,
  subagentBatchOf,
} from "./sessionTools";

function call(id: string, name: string, args: object = {}): ToolCallState {
  return {
    toolCallId: id,
    status: "calling",
    parsedArgs: args as Record<string, unknown>,
    toolCall: {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  };
}

const sub = (id: string, description: string) =>
  call(id, BuiltInToolNames.Subagent, {
    agent: "Explore",
    description,
    prompt: "p",
  });

function stateWith(calls: ToolCallState[]): () => RootState {
  const empty = getEmptyRootState();
  const state = {
    ...empty,
    session: {
      ...empty.session,
      history: [
        {
          message: { id: "u", role: "user" as const, content: "hi" },
          contextItems: [],
        },
        {
          message: { id: "a", role: "assistant" as const, content: "" },
          contextItems: [],
          toolCallStates: calls,
        },
      ],
    },
  };
  return () => state as RootState;
}

const unregister: (() => void)[] = [];
function live(...ids: string[]) {
  for (const id of ids) {
    unregister.push(registerSubagentRun(id, new AbortController()));
  }
}
afterEach(() => {
  for (const id of ["r1", "r2", "r3"]) takeInbox(id, "all");
  unregister.splice(0).forEach((u) => u());
});

describe("sessionToolsFor", () => {
  it("gives nothing to a run started alone, so its prompt does not change", () => {
    expect(sessionToolsFor({}, 1)).toEqual([]);
  });

  it("gives both tools to runs started together", () => {
    expect(sessionToolsFor({}, 2).map((t) => t.function.name)).toEqual([
      BuiltInToolNames.ListSessions,
      BuiltInToolNames.SendMessage,
    ]);
  });

  it("leaves out what the agent file disallows", () => {
    expect(
      sessionToolsFor({ disallowedTools: ["send_message"] }, 3).map(
        (t) => t.function.name,
      ),
    ).toEqual([BuiltInToolNames.ListSessions]);
  });
});

describe("subagentBatchOf", () => {
  it("returns the subagent calls of the reply that holds the call, and nothing else", () => {
    const getState = stateWith([
      sub("r1", "a"),
      call("g", BuiltInToolNames.GrepSearch, { query: "x" }),
      sub("r2", "b"),
    ]);
    expect(
      subagentBatchOf(getState().session.history, "r2").map(
        (c) => c.toolCallId,
      ),
    ).toEqual(["r1", "r2"]);
    expect(subagentBatchOf(getState().session.history, "nope")).toEqual([]);
  });
});

describe("sendAgentMessage", () => {
  const from = { runId: "r1", name: "Explore" };

  it("queues the message as Send now, from the agent", () => {
    live("r1", "r2");
    expect(sendAgentMessage(from, "r2", "  found it  ")).toBe("queued");
    expect(peekInbox("r2")).toEqual([
      expect.objectContaining({
        text: "found it",
        steer: true,
        from: { kind: "agent", name: "Explore", runId: "r1" },
      }),
    ]);
  });

  it("refuses itself, an ended run, empty and long text", () => {
    live("r1");
    expect(sendAgentMessage(from, "r1", "hi")).toBe("self");
    expect(sendAgentMessage(from, "r2", "hi")).toBe("not-live");
    live("r2");
    expect(sendAgentMessage(from, "r2", "  ")).toBe("empty");
    expect(sendAgentMessage(from, "r2", "x".repeat(5000))).toBe("too-long");
  });

  it("refuses the same text twice to the same run, and stops at the per-run limit", () => {
    live("r1", "r2", "r3");
    expect(sendAgentMessage(from, "r2", "one")).toBe("queued");
    expect(sendAgentMessage(from, "r2", "one")).toBe("duplicate");
    expect(sendAgentMessage(from, "r3", "one")).toBe("queued");
    for (let i = 2; i < MAX_AGENT_MESSAGES_PER_RUN; i++) {
      expect(sendAgentMessage(from, "r2", `more ${i}`)).toBe("queued");
    }
    expect(agentMessagesLeft("r1")).toBe(0);
    expect(sendAgentMessage(from, "r2", "one too many")).toBe("limit");
    // The other run has its own allowance
    expect(sendAgentMessage({ runId: "r2", name: "B" }, "r1", "hi")).toBe(
      "queued",
    );
  });

  it("forgets a run's count when it ends", () => {
    live("r2");
    const end = registerSubagentRun("r1", new AbortController());
    expect(sendAgentMessage(from, "r2", "one")).toBe("queued");
    end();
    live("r1");
    expect(agentMessagesLeft("r1")).toBe(MAX_AGENT_MESSAGES_PER_RUN);
  });
});

describe("answerSessionTool", () => {
  const self = { runId: "r1", name: "Explore" };

  it("leaves other tools to core", () => {
    expect(
      answerSessionTool(
        call("x", BuiltInToolNames.ReadFile),
        self,
        stateWith([]),
      ),
    ).toBeUndefined();
  });

  it("lists the other runs of the batch with their state", () => {
    live("r1", "r2");
    const ended = { ...sub("r3", "check b"), subagent: undefined };
    const getState = stateWith([
      sub("r1", "find a"),
      sub("r2", "find b"),
      {
        ...ended,
        subagent: {
          agent: "Explore",
          prompt: "p",
          status: "completed",
          toolCalls: [],
          text: "",
        },
      } as ToolCallState,
    ]);
    const [item] = answerSessionTool(
      call("l", BuiltInToolNames.ListSessions),
      self,
      getState,
    )!;
    expect(item.content).toBe(
      [
        `You are Explore (id r1). You may send ${MAX_AGENT_MESSAGES_PER_RUN} more message(s).`,
        "Started together with you:",
        '- id r2: Explore, "find b", running',
        '- id r3: Explore, "check b", ended (completed)',
      ].join("\n"),
    );
  });

  it("refuses an id outside the batch and a run that has ended", () => {
    live("r1");
    const getState = stateWith([sub("r1", "a"), sub("r2", "b")]);
    const send = (to: string) =>
      answerSessionTool(
        call("m", BuiltInToolNames.SendMessage, { to, message: "hi" }),
        self,
        getState,
      );
    expect(() => send("zz")).toThrow(/No subagent with id "zz"/);
    expect(() => send("r1")).toThrow(/your own id/);
    expect(() => send("r2")).toThrow(/takes no messages/);
  });
});
