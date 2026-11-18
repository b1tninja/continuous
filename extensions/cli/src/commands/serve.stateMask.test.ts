import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Built at run time so no scanner reads a credential shape in this file.
const CANARY = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");

const fake = vi.hoisted(() => ({ loop: undefined as any }));

vi.mock("../services/index.js", () => ({
  services: {
    toolPermissions: {
      getState: vi.fn(() => ({ currentMode: "normal" })),
      isHeadless: vi.fn(() => true),
    },
    chatHistory: { isReady: () => true, getHistory: () => [] },
  },
}));

vi.mock("../session.js", () => ({
  updateSessionHistory: vi.fn(),
  trackSessionUsage: vi.fn(),
  getSessionLoop: vi.fn(() => fake.loop),
  getCompleteStateSnapshot: (
    session: any,
    isProcessing: boolean,
    messageQueueLength: number,
    pendingPermission: any,
  ) => ({ session, isProcessing, messageQueueLength, pendingPermission }),
}));

vi.mock("../util/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { messageQueue } from "../stream/messageQueue.js";
import {
  holdPendingQuestion,
  resetPendingQuestions,
} from "../util/pendingQuestions.js";

import type { ServerState } from "./serve.helpers.js";
import { getServeStateSnapshot } from "./serve.messages.js";

const state = (over: Partial<ServerState> = {}) =>
  ({
    session: { sessionId: "s1", history: [] },
    isProcessing: false,
    pendingPermission: null,
    ...over,
  }) as unknown as ServerState;

beforeEach(() => {
  messageQueue.clear();
  resetPendingQuestions();
  fake.loop = undefined;
});

afterEach(() => {
  messageQueue.clear();
  resetPendingQuestions();
});

describe("GET /state masks every field, not only the session", () => {
  it("a secret in a queued message is masked", async () => {
    await messageQueue.enqueueMessage(`deploy with token ${CANARY} please`);
    const snapshot = getServeStateSnapshot(state());
    expect(snapshot.messageQueue).toHaveLength(1);
    expect(snapshot.messageQueue[0].message).toContain("deploy with token");
    expect(snapshot.messageQueue[0].message).toContain("please");
    expect(JSON.stringify(snapshot)).not.toContain(CANARY);
  });

  it("a secret in a held question, its options, default and answer is masked", () => {
    holdPendingQuestion({
      question: `Should I keep GITHUB_TOKEN=${CANARY} in the script?`,
      options: [`use ${CANARY}`, "remove it"],
      defaultAnswer: `use ${CANARY}`,
    });
    const snapshot = getServeStateSnapshot(state());
    expect(snapshot.pendingQuestions).toHaveLength(1);
    expect(snapshot.pendingQuestions[0].state).toBe("open");
    expect(snapshot.pendingQuestions[0].question).toContain("Should I keep");
    expect(snapshot.pendingQuestions[0].options?.[1]).toBe("remove it");
    expect(snapshot.openQuestions).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain(CANARY);
  });

  it("a secret in the loop (a held approval's command, a report) is masked", () => {
    fake.loop = {
      status: "running",
      round: 1,
      items: [],
      questions: [
        {
          id: "lq1",
          itemId: "1",
          kind: "approval",
          question: `Bash: curl -H "Authorization: Bearer ${CANARY}" https://example.test`,
        },
      ],
      current: { kind: "item", itemId: "1", report: { summary: CANARY } },
      log: [],
      reminders: [],
    };
    const snapshot = getServeStateSnapshot(state());
    expect(snapshot.loop?.questions[0].id).toBe("lq1");
    expect(snapshot.loop?.questions[0].question).toContain("Bash: curl");
    expect(JSON.stringify(snapshot)).not.toContain(CANARY);
  });

  it("the session and a pending permission stay masked, and plain values are kept", async () => {
    await messageQueue.enqueueMessage("run the tests");
    const snapshot = getServeStateSnapshot(
      state({
        session: {
          sessionId: "s1",
          history: [{ message: { role: "user", content: `key ${CANARY}` } }],
        } as any,
        isProcessing: true,
        pendingPermission: {
          toolName: "Bash",
          toolArgs: { command: `GITHUB_TOKEN=${CANARY} gh api user` },
          requestId: "r1",
        } as any,
      }),
    );
    expect(JSON.stringify(snapshot)).not.toContain(CANARY);
    expect(snapshot.isProcessing).toBe(true);
    expect(snapshot.messageQueueLength).toBe(1);
    expect(snapshot.messageQueue[0]).toMatchObject({
      message: "run the tests",
      steer: false,
    });
    expect(typeof snapshot.messageQueue[0].timestamp).toBe("number");
    expect(snapshot.messageQueuePaused).toBe(false);
    expect((snapshot.pendingPermission as any).requestId).toBe("r1");
    expect(snapshot.truncatedReplies).toBe(0);
  });
});
