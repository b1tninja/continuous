import { describe, expect, it } from "vitest";

import type { ChatHistoryItem, Session } from "../index.js";
import { forkSession, forkTitle } from "./forkSession";
import { DROPPED_PROMPT_MARKER } from "./promptLogs";

const item = (
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatHistoryItem> = {},
): ChatHistoryItem => ({
  message: { role, content, id: `${role}-${content}` } as any,
  contextItems: [],
  ...extra,
});

function parent(): Session {
  return {
    sessionId: "parent",
    title: "Fix the parser",
    workspaceDirectory: "file:///repo",
    history: [
      item("user", "fix it", {
        contextItems: [
          {
            name: "a.ts",
            description: "a.ts",
            content: "const a = 1;",
            uri: { type: "file", value: "file:///repo/a.ts" },
          } as any,
        ],
      }),
      item("assistant", "done", {
        reasoning: { text: "think", active: false, startAt: 1, endAt: 2 },
        toolCallStates: [],
      }),
      item("user", "now the tests"),
      item("assistant", "tests pass", {
        conversationSummary: "summary so far",
      }),
    ],
    mode: "agent",
    chatModelTitle: "Claude Opus",
    usage: { totalCost: 1.5, promptTokens: 100, completionTokens: 10 },
    promptCache: {
      lastRequestAt: 1_000,
      lastInputTokens: 200_000,
      lastTtl: "1h",
      requests: 12,
      escalated: true,
      escalatedBy: "requests",
    },
    checkpoints: [{ turnId: "t", files: [] } as any],
    taskPlan: {
      items: [{ id: "1", text: "Parse", status: "in_progress" }],
      updatedAt: "2026-11-13T00:00:00.000Z",
    },
    planFile: "file:///repo/.continuous/plans/parser.md",
    queuedMessages: [{ id: "q", editorState: {} } as any],
    loop: { items: {}, questions: [] } as any,
    loopRequested: true,
  };
}

describe("forkSession: what a fork copies", () => {
  // The copy table of plans/research/session-forking-and-cache.md section 6.3
  it.each([
    ["history up to the fork point", "history", true],
    ["mode", "mode", true],
    ["chat model", "chatModelTitle", true],
    ["task plan (D3: copied)", "taskPlan", true],
    ["prompt cache record", "promptCache", true],
    ["plan file (D3: not shared)", "planFile", false],
    ["loop", "loop", false],
    ["loop request", "loopRequested", false],
    ["queued messages", "queuedMessages", false],
    ["file checkpoints", "checkpoints", false],
    ["usage", "usage", false],
  ] as const)("%s", (_label, field, copied) => {
    const fork = forkSession(parent(), { sessionId: "fork" });
    if (copied) {
      expect(fork[field]).toBeDefined();
    } else {
      expect(fork[field]).toBeUndefined();
    }
  });

  it("is a new session that names its parent", () => {
    const fork = forkSession(parent(), { sessionId: "fork" });
    expect(fork.sessionId).toBe("fork");
    expect(fork.title).toBe("Fix the parser (fork)");
    expect(fork.workspaceDirectory).toBe("file:///repo");
    expect(fork.forkedFrom).toEqual({ sessionId: "parent" });
  });

  it("keeps every history item byte for byte, with attachments, reasoning, tool states and summaries", () => {
    const p = parent();
    const fork = forkSession(p, { sessionId: "fork" });
    expect(JSON.stringify(fork.history)).toBe(JSON.stringify(p.history));
  });

  it("drops prompts, keeping the completions", () => {
    const p = parent();
    p.history[1] = {
      ...p.history[1],
      promptLogs: [
        {
          modelTitle: "m",
          modelProvider: "p",
          prompt: "the whole conversation",
          completion: "done",
        },
      ],
    };
    const fork = forkSession(p, { sessionId: "fork" });
    expect(fork.history[1].promptLogs).toEqual([
      {
        modelTitle: "m",
        modelProvider: "p",
        prompt: DROPPED_PROMPT_MARKER,
        completion: "done",
      },
    ]);
    expect(p.history[1].promptLogs![0].prompt).toBe("the whole conversation");
  });

  it("copies the history instead of sharing it", () => {
    const p = parent();
    const fork = forkSession(p, { sessionId: "fork" });
    fork.history[0].message.content = "changed";
    fork.taskPlan!.items[0].status = "completed";
    expect(p.history[0].message.content).toBe("fix it");
    expect(p.taskPlan!.items[0].status).toBe("in_progress");
  });

  it("works on frozen history, as the GUI's store hands it over", () => {
    const p = parent();
    Object.freeze(p.history);
    p.history.forEach((h) => Object.freeze(h));
    expect(() => forkSession(p, { sessionId: "fork" })).not.toThrow();
  });

  it("from an earlier message keeps the items up to and including it", () => {
    const p = parent();
    const fork = forkSession(p, { sessionId: "fork", upTo: 1 });
    expect(fork.history.map((h) => h.message.content)).toEqual([
      "fix it",
      "done",
    ]);
    expect(JSON.stringify(fork.history)).toBe(
      JSON.stringify(p.history.slice(0, 2)),
    );
    expect(fork.forkedFrom).toEqual({ sessionId: "parent", index: 1 });
  });

  it("at the last item is a whole-session fork", () => {
    const fork = forkSession(parent(), { sessionId: "fork", upTo: 3 });
    expect(fork.history).toHaveLength(4);
    expect(fork.forkedFrom).toEqual({ sessionId: "parent" });
  });

  it("keeps the cache record's timing and lifetime, restarts the request count and keeps Auto's escalation", () => {
    const fork = forkSession(parent(), { sessionId: "fork" });
    expect(fork.promptCache).toEqual({
      lastRequestAt: 1_000,
      lastInputTokens: 200_000,
      lastTtl: "1h",
      escalated: true,
      escalatedBy: "requests",
    });
  });

  it("takes the record of the fork point when the caller knows it", () => {
    const fork = forkSession(parent(), {
      sessionId: "fork",
      upTo: 1,
      promptCache: { lastRequestAt: 500, lastInputTokens: 90_000 },
    });
    expect(fork.promptCache).toEqual({
      lastRequestAt: 500,
      lastInputTokens: 90_000,
    });
  });

  it("has no cache record when the parent never sent a request", () => {
    const p = { ...parent(), promptCache: undefined };
    expect(forkSession(p, { sessionId: "fork" }).promptCache).toBeUndefined();
  });

  it("does not mark a fork of a fork twice", () => {
    expect(forkTitle("Fix the parser (fork)")).toBe("Fix the parser (fork)");
  });
});
