import fs from "fs";
import os from "os";
import path from "path";

import type { LoopState } from "core/index.js";
import { refusalText } from "core/tools/refusalText.js";
import { LOOP_LIMITS } from "core/util/loopMode.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPolicyLevels,
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import { services } from "../services/index.js";
import {
  createSession,
  getCurrentSession,
  getSessionLoop,
  updateSessionLoop,
} from "../session.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { savePlan } from "../tools/presentPlan.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
  testModel,
  toolTurn,
} from "../ui/__tests__/TUIChat.flowHarness.js";

import { nextLoopTurn, type LoopTurn } from "./loopDriver.js";
import {
  holdLoopCall,
  loopRunEndedAtCap,
  loopRunEndedResult,
} from "./loopHolds.js";
import {
  answerLoopQuestion,
  resetLoopMemory,
  startLoopFromPlan,
} from "./loopSession.js";

const CAP = LOOP_LIMITS.maxOpenQuestionsPerItem;

const history = () => services.chatHistory.getHistory();
const loopNow = (): LoopState => getSessionLoop()!;
const nextTurn = () => nextLoopTurn(history().length) as LoopTurn | undefined;

/** The results the run's tool calls got, in order. */
const toolResults = () =>
  history()
    .flatMap((item) => item.toolCallStates ?? [])
    .map((tc) => tc.output?.map((o) => o.content).join("") ?? "");

/**
 * The question cap in the CLI: a call that would ask when the item already
 * holds its limit of open questions ends the item's run as waiting, instead
 * of being answered and followed by the next one.
 */
describe("a held call at the item's question limit in the CLI", () => {
  let cwd: string;

  beforeEach(async () => {
    await resetFlowState();
    resetPolicyLevels();
    // Every question waits for the person: what this is about
    setPolicyLevels({ ...getPolicyLevels(), questions: "manual" });
    updateSessionLoop(undefined);
    resetLoopMemory();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-loop-cap-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
  });

  afterEach(async () => {
    updateSessionLoop(undefined);
    resetLoopMemory();
    await resetFlowState();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  /** One item running in normal mode, where Write asks. */
  async function startItem(llm: ScriptedLlm) {
    await registerFlowServices({ llm, mode: "normal" });
    createSession([]);
    await services.chatHistory.initialize(getCurrentSession(), false);
    await savePlan({ title: "Work", plan: "The work.", todos: ["One"] }, cwd);
    startLoopFromPlan("normal");
    const turn = nextTurn();
    expect(turn?.kind).toBe("item");
    services.chatHistory.addUserMessage(turn!.prompt);
  }

  /** Sends the item's request and runs its turn to the end. */
  const runTurn = (llm: ScriptedLlm) =>
    streamChatResponse(history(), testModel, llm.api, new AbortController());

  const write = (n: number) =>
    toolTurn(
      "Write",
      {
        filepath: path.join(cwd, `f${n}.ts`),
        content: `export const n = ${n};\n`,
      },
      `call_write_${n}`,
    );

  it("below the limit each call is held as a question and the run goes on", async () => {
    await startItem(new ScriptedLlm([]));
    for (let n = 1; n <= CAP; n++) {
      const held = holdLoopCall({
        name: "Write",
        arguments: { filepath: path.join(cwd, `f${n}.ts`) },
      });
      expect(held).toMatchObject({
        approved: false,
        denialReason: "loop",
        denialMessage: expect.stringContaining(`held as question q${n}`),
      });
    }
    expect(loopNow().questions).toHaveLength(CAP);
    expect(loopNow().current?.report).toBeUndefined();
    expect(loopRunEndedAtCap()).toBe(false);
    expect(
      loopRunEndedResult({ name: "Write", arguments: {} }),
    ).toBeUndefined();
  });

  it("a model that keeps calling a held tool gets one result at the limit, the item waits, and it runs again once answered", async () => {
    // A fixed script: four calls are held, the fifth is past the limit. The
    // sixth and seventh are only read if the turn did not end there.
    const llm = new ScriptedLlm([
      write(1),
      write(2),
      write(3),
      write(4),
      write(5),
      write(6),
      write(7),
    ]);
    await startItem(llm);
    await runTurn(llm);

    // No request followed the fifth call
    expect(llm.requests).toHaveLength(CAP + 1);
    const results = toolResults();
    expect(results).toHaveLength(CAP + 1);
    for (let n = 1; n <= CAP; n++) {
      expect(results[n - 1]).toContain(`held as question q${n}`);
    }
    expect(results[CAP]).toBe(refusalText.questionCapWaiting("Write", CAP));
    expect(loopNow().questions).toHaveLength(CAP);
    expect(loopNow().current).toMatchObject({
      questionCap: true,
      report: { outcome: "waiting" },
    });
    expect(fs.readdirSync(cwd).filter((f) => f.endsWith(".ts"))).toEqual([]);

    // The driver records the run: the item waits on the person, not nudged
    expect(nextTurn()).toBeUndefined();
    expect(loopNow().status).toBe("waiting");
    expect(loopNow().current).toBeUndefined();
    expect(loopNow().items[0]).toMatchObject({
      status: "waiting",
      summary:
        "Stopped at the question limit: 4 questions are open for the person.",
    });

    // One answer is not enough while others are open; the last one wakes it
    const open = loopNow().questions.map((q) => q.id);
    for (const [i, questionId] of open.entries()) {
      expect(loopNow().items[0].status).toBe("waiting");
      expect(
        answerLoopQuestion({ questionId, text: "", approve: true }),
      ).toMatchObject({
        ok: true,
        route: i === open.length - 1 ? "requeue" : "next-run",
      });
    }
    const again = nextTurn();
    expect(again?.kind).toBe("item");
    expect(again?.prompt).toContain("Allowed.");

    // The run after the answers: the allowed call runs this time
    const rerun = new ScriptedLlm([
      write(1),
      toolTurn("FinishItem", { outcome: "done", summary: "Wrote it" }),
    ]);
    services.chatHistory.addUserMessage(again!.prompt);
    await runTurn(rerun);
    expect(rerun.requests).toHaveLength(2);
    expect(fs.existsSync(path.join(cwd, "f1.ts"))).toBe(true);
    expect(nextTurn()).toBeUndefined();
    expect(loopNow().items[0].status).toBe("done");
  }, 30_000);

  it("a later call of the reply that reached the limit is not run and not held", async () => {
    await startItem(new ScriptedLlm([]));
    for (let n = 1; n <= CAP; n++) {
      holdLoopCall({
        name: "Write",
        arguments: { filepath: path.join(cwd, `f${n}.ts`) },
      });
    }
    const over = holdLoopCall({
      name: "Write",
      arguments: { filepath: path.join(cwd, "over.ts") },
    });
    expect(over).toEqual({
      approved: false,
      denialReason: "loop",
      denialMessage: refusalText.questionCapWaiting("Write", CAP),
    });
    expect(loopRunEndedAtCap()).toBe(true);
    expect(loopRunEndedResult({ name: "Read", arguments: {} })).toBe(
      refusalText.runEnded("Read"),
    );
    expect(loopNow().questions).toHaveLength(CAP);
  });
});
