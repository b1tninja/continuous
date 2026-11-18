import fs from "node:fs";
import path from "node:path";

import type { Session } from "core/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeChatHistory } from "./commands/chat.js";
import { env } from "./env.js";
import {
  getPolicyLevels,
  resetPolicyLevels,
  setPolicyLevels,
} from "./permissions/policyLevels.js";
import { services } from "./services/index.js";
import {
  getCurrentSession,
  loadOrCreateSessionById,
  startNewSession,
} from "./session.js";
import { handleSlashCommands } from "./slashCommands.js";

vi.mock("./telemetry/telemetryService.js", () => ({
  telemetryService: { recordSlashCommand: vi.fn() },
}));

// Real files in the test run's own global folder (vitest.global-dir-setup.ts)
const dir = path.join(env.continueHome, "sessions");

function parent(): Session {
  return {
    sessionId: "parent-id",
    title: "Fix the parser",
    workspaceDirectory: "/work/project",
    history: [
      {
        message: { role: "user", content: "fix the parser" },
        contextItems: [],
      },
      {
        message: {
          role: "assistant",
          content: "Fixed.",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        contextItems: [],
      },
      {
        message: {
          role: "tool",
          content: "const a = 1;",
          toolCallId: "call_1",
        },
        contextItems: [],
      },
      {
        message: { role: "assistant", content: "Done, tests pass." },
        contextItems: [],
      },
    ],
    mode: "agent",
    chatModelTitle: "Claude Opus 5.5",
    usage: { totalCost: 2, promptTokens: 1000, completionTokens: 100 },
    promptCache: {
      lastRequestAt: 1_763_000_000_000,
      lastInputTokens: 180_000,
      lastTtl: "1h",
      requests: 9,
      escalated: true,
      escalatedBy: "requests",
    },
    taskPlan: {
      items: [{ id: "1", text: "Fix the parser", status: "completed" }],
      updatedAt: "2026-11-13T00:00:00.000Z",
    },
    planFile: "file:///work/project/.continuous/plans/parser.md",
    checkpoints: [{ turnId: "t1", files: [] } as any],
  };
}

const file = (id: string) => path.join(dir, `${id}.json`);
/**
 * A saved session, without the `editorState` the CLI adds to user messages
 * when it writes one (modifySessionBeforeSave): it is for the GUI's input box
 * and is not part of what a request sends.
 */
const readFile = (id: string): Session => {
  const session: Session = JSON.parse(fs.readFileSync(file(id), "utf8"));
  return {
    ...session,
    history: session.history.map(({ editorState, ...item }) => {
      void editorState;
      return item;
    }),
  };
};

/** What a fork must carry over, whichever way it was made. */
function copied(session: Session) {
  return {
    history: session.history,
    mode: session.mode,
    chatModelTitle: session.chatModelTitle,
    taskPlan: session.taskPlan,
    promptCache: session.promptCache,
    planFile: session.planFile,
    checkpoints: session.checkpoints,
    usage: session.usage,
    forkedFrom: session.forkedFrom,
  };
}

const EXPECTED = {
  history: parent().history,
  mode: "agent",
  chatModelTitle: "Claude Opus 5.5",
  taskPlan: parent().taskPlan,
  // The request count restarts; timing, size, lifetime and Auto's escalation stay
  promptCache: {
    lastRequestAt: 1_763_000_000_000,
    lastInputTokens: 180_000,
    lastTtl: "1h",
    escalated: true,
    escalatedBy: "requests",
  },
  planFile: undefined,
  checkpoints: undefined,
  usage: undefined,
  forkedFrom: { sessionId: "parent-id" },
};

describe("forking a session in the CLI", () => {
  const savedTestFlag = process.env.CONTINUE_CLI_TEST;
  let parentBytes: string;

  beforeEach(() => {
    // session.ts uses another folder when CONTINUE_CLI_TEST and HOME are set
    delete process.env.CONTINUE_CLI_TEST;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    parentBytes = JSON.stringify(parent(), null, 2);
    fs.writeFileSync(file("parent-id"), parentBytes);
    startNewSession();
  });

  afterEach(() => {
    startNewSession();
    resetPolicyLevels();
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedTestFlag !== undefined) {
      process.env.CONTINUE_CLI_TEST = savedTestFlag;
    }
  });

  it("--fork copies the history, mode, model, task plan and cache record", async () => {
    const history = await initializeChatHistory({ fork: "parent-id" });

    const fork = getCurrentSession();
    expect(fork.sessionId).not.toBe("parent-id");
    expect(history).toEqual(parent().history);
    expect(copied(fork)).toEqual(EXPECTED);
    // Saved with those fields, beside the untouched original
    expect(copied(readFile(fork.sessionId))).toEqual(EXPECTED);
    expect(fs.readFileSync(file("parent-id"), "utf8")).toBe(parentBytes);
  });

  it("--fork keeps the history byte for byte, so the next request starts with the parent's prefix", async () => {
    await initializeChatHistory({ fork: "parent-id" });
    expect(JSON.stringify(getCurrentSession().history)).toBe(
      JSON.stringify(parent().history),
    );
  });

  it("/fork forks instead of printing a command, and continues in the fork", async () => {
    loadOrCreateSessionById("parent-id");

    const result = await handleSlashCommands("/fork", {} as any);

    const fork = getCurrentSession();
    expect(fork.sessionId).not.toBe("parent-id");
    expect(result?.output).toContain("Forked into a new session");
    expect(result?.output).toContain(fork.sessionId);
    expect(result?.output).not.toContain("--fork");
    expect(services.chatHistory.getSessionId()).toBe(fork.sessionId);
    expect(copied(readFile(fork.sessionId))).toEqual(EXPECTED);
    // The original keeps everything, including what a fork leaves behind
    const original = readFile("parent-id");
    expect(original.planFile).toBe(parent().planFile);
    expect(original.usage).toEqual(parent().usage);
    expect(original.history).toEqual(parent().history);
  });

  it("/fork and --fork make the same copy", async () => {
    await initializeChatHistory({ fork: "parent-id" });
    const viaFlag = copied(getCurrentSession());
    startNewSession();
    loadOrCreateSessionById("parent-id");
    await handleSlashCommands("/fork", {} as any);
    expect(copied(getCurrentSession())).toEqual(viaFlag);
  });

  it("/fork keeps this run's permission levels, IDGAF included", async () => {
    loadOrCreateSessionById("parent-id");
    setPolicyLevels({ ...getPolicyLevels(), tools: "idgaf" });
    const before = getPolicyLevels();
    await handleSlashCommands("/fork", {} as any);
    expect(getPolicyLevels()).toEqual(before);
    expect(getPolicyLevels().tools).toBe("idgaf");
  });

  it("/fork says so and does nothing before the first message", async () => {
    const result = await handleSlashCommands("/fork", {} as any);
    expect(result?.output).toContain("Nothing to fork yet");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([
      "parent-id.json",
    ]);
  });
});
