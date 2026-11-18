import fs from "fs";
import os from "os";
import path from "path";

import type { ChatHistoryItem, LoopState } from "core/index.js";
import historyManager from "core/util/history.js";
import {
  answerLoop,
  createLoop,
  finishItemRun,
  LOOP_AUTONOMY,
  setLoopStrategy,
  startItemRun,
} from "core/util/loopMode.js";
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
  getSessionTaskPlan,
  loadOrCreateSessionById,
  trackSessionUsage,
  updateSessionLoop,
} from "../session.js";
import { savePlan } from "../tools/presentPlan.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
} from "../ui/__tests__/TUIChat.flowHarness.js";

import { runLoopCheck } from "./loopChecks.js";
import { loopWakeDelay, nextLoopTurn, type LoopTurn } from "./loopDriver.js";
import { setRunningLoopFallbackCheck } from "./loopFallbackCheck.js";
import { holdLoopCall, loopRepeatGuard } from "./loopHolds.js";
import {
  acceptLoopPlan,
  answerLoopQuestion,
  commitLoop,
  consumeLoopTurnEnd,
  loopPlanBlockForRequest,
  loopRequestHistory,
  prepareLoopTurn,
  requestLoopTurnEnd,
  resetLoopMemory,
  resumeStoppedLoop,
  runLoopItemAgain,
  setRunningLoopBudget,
  skipLoopItem,
  startLoopFromPlan,
  withLoopSteering,
} from "./loopSession.js";

/** The next model turn (these tests have no checks, so never a check step). */
const nextTurn = (historyLength: number) =>
  nextLoopTurn(historyLength) as LoopTurn | undefined;

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});

/** An assistant message with one finished tool call. */
function toolCallItem(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ChatHistoryItem {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    contextItems: [],
    toolCallStates: [
      {
        toolCallId: id,
        toolCall: {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
        status: "done",
        parsedArgs: args,
      },
    ],
  };
}

const history = () => services.chatHistory.getHistory();
const append = (...items: ChatHistoryItem[]) =>
  services.chatHistory.setHistory([...history(), ...items]);

/** The loop as it is now, for a change and a commit. */
const loopNow = (): LoopState => getSessionLoop()!;

/** Runs the next turn the driver asks for to a FinishItem report. */
function runItem(outcome: "done" | "stuck" | "waiting" = "done") {
  const turn = nextTurn(history().length);
  expect(turn?.kind).toBe("item");
  append(user(turn!.prompt));
  const loop = loopNow();
  commitLoop({
    ...loop,
    current: loop.current && {
      ...loop.current,
      report: { outcome, summary: `${outcome} it` },
    },
  });
  return turn!;
}

describe("Loop mode's driver in the CLI", () => {
  let cwd: string;

  beforeEach(async () => {
    await resetFlowState();
    resetPolicyLevels();
    updateSessionLoop(undefined);
    resetLoopMemory();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-loop-driver-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    await registerFlowServices({ llm: new ScriptedLlm([]), mode: "normal" });
    createSession([]);
    await services.chatHistory.initialize(getCurrentSession(), false);
    append(user("earlier chat"));
  });

  afterEach(async () => {
    updateSessionLoop(undefined);
    resetLoopMemory();
    await resetFlowState();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function planOf(...todos: string[]) {
    await savePlan({ title: "Work", plan: "The work.", todos }, cwd);
  }

  it("a run that ends over its item's own budget with no report ends as over budget, not nudged and not a failure of the loop's", async () => {
    await savePlan(
      {
        title: "Work",
        plan: "The work.",
        todos: ["One", "Two"],
        todo_details: [{ todo: 1, budget: "10K tokens" }],
      },
      cwd,
    );
    startLoopFromPlan("normal");
    expect(getSessionTaskPlan()?.items[0].budget).toEqual({ tokens: 10_000 });
    const turn = nextTurn(history().length);
    expect(turn?.kind).toBe("item");
    append(user(turn!.prompt));
    // The run used more than the item's budget and ended without finish_item
    trackSessionUsage(0, {
      promptTokens: 30_000,
      completionTokens: 500,
    });
    nextTurn(history().length);
    const item = loopNow().items.find((i) => i.id === "1")!;
    expect(item.status).toBe("failed");
    expect(item.overBudget).toMatchObject({ which: "tokens", limit: 10_000 });
    expect(item.summary).toContain("Over budget");
    expect(loopNow().consecutiveFailures ?? 0).toBe(0);
  });

  it("re-plans in Plan mode, and a re-plan that adds nothing starts the next round by itself (Auto)", async () => {
    await planOf("One", "Two");
    const loop = startLoopFromPlan("normal")!;
    // The whole-plan re-plan: Finish, not Fix forward
    commitLoop(setLoopStrategy({ ...loop, autonomy: "auto" }, "finish"));

    runItem("done");
    runItem("stuck");
    const replan = nextTurn(history().length);
    expect(replan?.kind).toBe("replan");
    expect(replan?.prompt).toContain('call PresentPlan with the title "Work"');
    expect(services.toolPermissions.getCurrentMode()).toBe("plan");
    // The re-plan's request starts at its own prompt
    append(user(replan!.prompt));
    // The run's first message is pinned as the prompt cache fork point.
    expect(loopRequestHistory(history())).toEqual([
      { ...user(replan!.prompt), cachePin: true },
    ]);

    // The re-plan presents the same to-dos
    await planOf("One", "Two");
    append(toolCallItem("PresentPlan", {}, "call_plan"));
    const next = nextTurn(history().length);
    expect(next?.kind).toBe("item");
    expect(next?.prompt).toContain("only this item: Two");
    expect(loopNow().round).toBe(2);
    expect(loopNow().replanReason).toBe("The re-plan adds no new to-dos.");
    expect(services.toolPermissions.getCurrentMode()).toBe("normal");
  });

  it("fix forward: a failed item gets a repair turn, and a split goes on by itself (Auto)", async () => {
    await planOf("One", "Two", "Three");
    const loop = startLoopFromPlan("normal")!;
    commitLoop(setLoopStrategy({ ...loop, autonomy: "auto" }, "fix-forward"));

    runItem("done");
    runItem("stuck");
    const repair = nextTurn(history().length);
    expect(repair?.kind).toBe("replan");
    expect(repair?.prompt).toContain("failed: Two");
    expect(repair?.prompt).toContain("What its run reported: stuck it");
    expect(repair?.prompt).toContain('call PresentPlan with the title "Work"');
    expect(services.toolPermissions.getCurrentMode()).toBe("plan");
    expect(loopNow().current).toMatchObject({
      kind: "replan",
      itemId: "2",
      itemText: "Two",
    });
    expect(loopNow().items[1].repairs).toBe(1);

    // The repair splits the item; every other to-do stays as it was
    append(user(repair!.prompt));
    await planOf("One", "Two, first half", "Two, second half", "Three");
    append(toolCallItem("PresentPlan", {}, "call_plan"));
    const next = nextTurn(history().length);
    expect(next?.kind).toBe("item");
    expect(next?.prompt).toContain("only this item: Two, first half");
    expect(loopNow().replanReason).toBe(
      "The repair replaces the failed item with 2 to-dos.",
    );
    expect(loopNow().round).toBe(2);
    expect(loopNow().items.map((i) => [i.status, i.repairs])).toEqual([
      ["done", undefined],
      ["running", 1],
      ["pending", 1],
      ["pending", undefined],
    ]);
    expect(services.toolPermissions.getCurrentMode()).toBe("normal");
  });

  async function stuckThenCheckReplaced(
    plan: "idgaf" | "permissive" | "cautious",
  ) {
    await savePlan(
      {
        title: "Work",
        plan: "The work.",
        todos: ["One", "Two"],
        todo_details: [{ todo: 1, check: "node one.js" }],
      },
      cwd,
    );
    setPolicyLevels({ ...getPolicyLevels(), plan, questions: plan });
    const loop = startLoopFromPlan("normal")!;
    commitLoop(setLoopStrategy(loop, "finish"));
    runItem("stuck");
    runItem("done");
    const replan = nextTurn(history().length);
    expect(replan?.kind).toBe("replan");
    append(user(replan!.prompt));
    // The re-plan swaps the stuck item's check for an easier one
    await savePlan(
      {
        title: "Work",
        plan: "The work.",
        todos: ["One", "Two"],
        todo_details: [{ todo: 1, check: "node --check one.js" }],
      },
      cwd,
    );
    append(toolCallItem("PresentPlan", {}, "call_plan"));
    return nextTurn(history().length);
  }

  for (const level of ["idgaf", "permissive"] as const) {
    it(`a re-plan that replaces a check goes on by itself at Plan edits ${level}, with a notice`, async () => {
      const next = await stuckThenCheckReplaced(level);
      expect(next?.kind).toBe("item");
      expect(loopNow().status).toBe("running");
      expect(loopNow().autoDecisions?.at(-1)).toMatchObject({
        kind: "plan",
        by: "system",
        text: "Plan updated: 2 kept, 0 added, 0 dropped; check of item 1 replaced",
      });
    });
  }

  it("the same re-plan waits on its card at Plan edits Cautious", async () => {
    expect(await stuckThenCheckReplaced("cautious")).toBeUndefined();
    expect(loopNow().status).toBe("awaiting_plan");
    expect(loopNow().replanReason).toContain("ended stuck");
  });

  it("a plan's open decisions are answered by the system when Questions is permissive", async () => {
    await savePlan(
      {
        title: "Work",
        plan: "The work.",
        todos: ["One"],
        decisions: [
          {
            question: "Which store?",
            options: ["sqlite", "postgres (recommended)"],
            pick: "sqlite",
            todos: [1],
          },
        ],
      },
      cwd,
    );
    setPolicyLevels({
      ...getPolicyLevels(),
      plan: "idgaf",
      questions: "idgaf",
    });
    startLoopFromPlan("normal");
    expect(loopNow().autoDecisions?.at(-1)).toMatchObject({
      kind: "question",
      by: "system",
      text: "Auto-answered: Which store? -> postgres",
    });
    const file = fs.readdirSync(path.join(cwd, ".continuous", "plans"))[0];
    expect(
      fs.readFileSync(path.join(cwd, ".continuous", "plans", file), "utf8"),
    ).toContain("postgres");
  });

  it("a supervised re-plan waits for Continue the loop", async () => {
    await planOf("One");
    setPolicyLevels({
      ...getPolicyLevels(),
      plan: "manual",
      questions: "manual",
    });
    startLoopFromPlan("normal");
    expect(loopNow().autonomy).toBe("supervised");
    runItem("stuck");
    expect(nextTurn(history().length)?.kind).toBe("replan");
    await planOf("One", "Two");
    append(toolCallItem("PresentPlan", {}, "call_plan"));

    expect(nextTurn(history().length)).toBeUndefined();
    expect(loopNow().status).toBe("awaiting_plan");
    expect(loopNow().replanReason).toBe("Every plan waits for you.");
    expect(acceptLoopPlan()).toBe(true);
    const next = nextTurn(history().length);
    expect(next?.prompt).toContain("only this item: One");
  });

  it("a re-plan that presents no plan is told once to present it, then stops the loop", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    runItem("stuck");
    const replan = nextTurn(history().length);
    expect(replan?.kind).toBe("replan");
    append(user(replan!.prompt));
    // The re-plan ended with no PresentPlan: one nudge, in the same run
    const nudge = nextTurn(history().length);
    expect(nudge?.kind).toBe("replan");
    expect(nudge?.prompt).toContain("Call PresentPlan now");
    expect(loopNow().current?.kind).toBe("replan");
    expect(loopNow().current?.nudged).toBe(true);
    append(user(nudge!.prompt));
    // Still no plan: now the loop stops
    expect(nextTurn(history().length)).toBeUndefined();
    expect(loopNow()).toMatchObject({
      status: "stopped",
      stopReason: "replan_failed",
    });
  });

  it("an item run that ends without FinishItem is told once to report, then counts as an attempt", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    const turn = nextTurn(history().length);
    expect(turn?.kind).toBe("item");
    append(user(turn!.prompt));
    // The run ended with no report
    const nudge = nextTurn(history().length);
    expect(nudge?.kind).toBe("item");
    expect(nudge?.prompt).toContain("Call FinishItem now");
    expect(loopNow().current?.itemId).toBe("1");
    append(user(nudge!.prompt));
    // Still no report: the run ends as an attempt and the item runs again
    const again = nextTurn(history().length);
    expect(again?.kind).toBe("item");
    expect(again?.prompt).toContain("only this item: One");
    expect(loopNow().items.find((i) => i.id === "1")?.attempts).toBe(2);
  });

  it("a loop saved mid-run comes back stopped, its item pending", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    nextTurn(history().length);
    expect(loopNow().current?.kind).toBe("item");
    const { sessionId } = getCurrentSession();
    // What a reload reads: the session file the CLI saved
    const saved = historyManager.load(sessionId);
    expect(saved.loop?.current?.kind).toBe("item");

    loadOrCreateSessionById(sessionId);
    const restored = loopNow();
    expect(restored.status).toBe("stopped");
    expect(restored.current).toBeUndefined();
    expect(restored.items[0].status).toBe("pending");
    expect(restored.stopDetail).toContain("Resume to go on");
    expect(nextTurn(history().length)).toBeUndefined();
  });

  it("delivers a steered answer at the tool boundary, ahead of the person's own steer", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    nextTurn(history().length);
    const held = holdLoopCall({ name: "Write", arguments: { filepath: "a" } });
    expect(held).toMatchObject({ approved: false, denialReason: "loop" });
    const q = loopNow().questions[0];
    expect(answerLoopQuestion({ questionId: q.id, text: "Yes, a" })).toEqual({
      ok: true,
      route: "steer",
      answerId: "a1",
    });

    const boundary = withLoopSteering(async () => user("and hurry"));
    const item = await boundary();
    expect(item?.message.content).toBe(
      `The person answered your question q1 ("${q.question}"): Yes, a\n\nand hurry`,
    );
    // Taken once only
    expect(await withLoopSteering()()).toBeUndefined();

    // It reached the run, so the next run does not carry it again
    const finished = loopNow();
    commitLoop({
      ...finished,
      current: finished.current && {
        ...finished.current,
        report: { outcome: "done" },
      },
    });
    const next = nextTurn(history().length);
    expect(next?.prompt).toContain("only this item: Two");
    expect(loopNow().answers[0].delivered).toBe(true);
  });

  it("a steered answer that misses the run goes with the item's redo", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    nextTurn(history().length);
    answerLoopQuestion({ itemId: "1", text: "Use tabs" });
    // The run ends with done before any tool boundary
    const loop = loopNow();
    commitLoop({
      ...loop,
      current: loop.current && {
        ...loop.current,
        report: { outcome: "done" },
      },
    });
    const redo = nextTurn(history().length);
    expect(redo?.prompt).toContain("Redo it to match their answer below");
    expect(redo?.prompt).toContain("- Use tabs");
  });

  it("refuses the fourth identical call of an item's run, and holds asks in a re-plan", async () => {
    await planOf("One");
    startLoopFromPlan("normal");
    nextTurn(history().length);
    const args = { filepath: "a.ts" };
    append(
      toolCallItem("Read", args, "r1"),
      toolCallItem("Read", args, "r2"),
      toolCallItem("Read", args, "r3"),
      toolCallItem("Read", args, "r4"),
    );
    const guard = loopRepeatGuard(["r4"]);
    expect(guard.check({ name: "Read", arguments: args })).toContain(
      "Read was not run: the same call has run 3 times with no file change",
    );
    expect(guard.check({ name: "Read", arguments: args })).toContain(
      "call FinishItem",
    );
    expect(
      loopRepeatGuard(["r4"]).check({ name: "Read", arguments: { x: 1 } }),
    ).toBeUndefined();

    // The loop's own tools are never held
    expect(holdLoopCall({ name: "FinishItem", arguments: {} })).toEqual({
      approved: true,
    });
    // A grant from Allow once is used up by the call
    const key = { name: "Bash", arguments: { command: "npm test" } };
    holdLoopCall(key);
    const q = loopNow().questions.at(-1)!;
    answerLoopQuestion({ questionId: q.id, text: "", approve: true });
    expect(holdLoopCall(key)).toEqual({ approved: true });
    expect(holdLoopCall(key)).toMatchObject({ approved: false });

    const replan: LoopState = {
      ...loopNow(),
      current: { kind: "replan", historyIndex: 0, startedAt: "" },
    };
    commitLoop(replan);
    expect(holdLoopCall(key)).toMatchObject({
      approved: false,
      denialMessage: expect.stringContaining("with PresentPlan"),
    });
  });

  it("the turn end applies to the main session only", () => {
    // FinishItem asks for it; a subagent's run turns the service off
    requestLoopTurnEnd();
    const ready = services.chatHistory.isReady;
    services.chatHistory.isReady = () => false;
    expect(consumeLoopTurnEnd()).toBe(false);
    services.chatHistory.isReady = ready;
    expect(consumeLoopTurnEnd(true)).toBe(false);
    expect(consumeLoopTurnEnd()).toBe(true);
    expect(consumeLoopTurnEnd()).toBe(false);
  });

  it("sends the plan block with an item's requests, not with a subagent's or compaction's", async () => {
    await planOf("One", "Two");
    startLoopFromPlan("normal");
    expect(loopPlanBlockForRequest()).toBe("");
    nextTurn(history().length);
    const block = loopPlanBlockForRequest();
    expect(block).toContain("[>] 1. One  <- this item");
    expect(block).toContain("report it with FinishItem");
    expect(loopPlanBlockForRequest(true)).toBe("");
    const ready = services.chatHistory.isReady;
    services.chatHistory.isReady = () => false;
    expect(loopPlanBlockForRequest()).toBe("");
    services.chatHistory.isReady = ready;
  });

  it("puts the plan block after the item prompt, the same for every request of the run", async () => {
    await planOf("One", "Two");
    commitLoop({ ...startLoopFromPlan("normal")!, freshContext: false });
    append(user("plan the work"));
    const turn = nextTurn(history().length);
    append(user(turn!.prompt));
    const block = loopPlanBlockForRequest();
    const first = loopRequestHistory(history());
    // Kept context: the turns before stay, the prompt carries the block
    expect(first).toHaveLength(history().length);
    expect(first.at(-1)!.message.content).toBe(`${turn!.prompt}\n\n${block}`);
    expect(history().at(-1)!.message.content).toBe(turn!.prompt);
    // A call the run makes later does not move or change it
    append(toolCallItem("Read", { filepath: "a.ts" }, "call_read"));
    const later = loopRequestHistory(history());
    expect(later.slice(0, first.length)).toEqual(first);
    // Fresh context: the request starts at the prompt, block included
    commitLoop({ ...getSessionLoop()!, freshContext: true });
    expect(loopRequestHistory(history())[0].message.content).toBe(
      `${turn!.prompt}\n\n${block}`,
    );
  });

  it("a resumed loop follows this process's levels, not the ones saved with it", async () => {
    await planOf("One");
    const plan = getSessionTaskPlan()!;
    const now = new Date("2026-11-07T10:00:00Z");
    const saved = {
      ...createLoop(plan, { now, sessionTokens: 0, autonomy: "auto" }),
      policy: { plan: "cautious", questions: "cautious" },
      status: "stopped" as const,
    } as LoopState;
    commitLoop(saved);
    setPolicyLevels({
      ...getPolicyLevels(),
      plan: "idgaf",
      questions: "idgaf",
    });
    expect(resumeStoppedLoop(now)).toBe(true);
    expect(getSessionLoop()?.policy).toMatchObject({
      plan: "idgaf",
      questions: "idgaf",
    });
  });

  it("an unattended loop wakes when its wait runs out", async () => {
    await planOf("One");
    const plan = getSessionTaskPlan()!;
    const now = new Date("2026-11-07T10:00:00Z");
    let loop = createLoop(plan, {
      now,
      sessionTokens: 0,
      autonomy: "unattended",
    });
    loop = finishItemRun(startItemRun(loop, "1", 0, now), {
      outcome: "waiting",
    });
    expect(loopWakeDelay(loop, now.getTime())).toBeUndefined();
    const waiting = {
      ...loop,
      status: "waiting" as const,
      waitingSince: now.toISOString(),
    };
    expect(loopWakeDelay(waiting, now.getTime() + 60_000)).toBe(
      LOOP_AUTONOMY.unattended.waitTimeoutMs - 60_000,
    );
    expect(
      loopWakeDelay({ ...waiting, autonomy: "auto" }, now.getTime()),
    ).toBeUndefined();
    // answerLoop on a waiting loop resumes it, which the runner then sees
    const resumed = answerLoop(
      { ...waiting, questions: [] },
      { itemId: "1", text: "Go on" },
      now,
    );
    expect(resumed.ok && resumed.loop.status).toBe("running");
  });

  it("skips an item, runs a done one again, and changes the limits", async () => {
    await planOf("One", "Two", "Three");
    setPolicyLevels({
      ...getPolicyLevels(),
      plan: "manual",
      questions: "manual",
    });
    startLoopFromPlan("normal");
    expect(skipLoopItem("9")).toEqual({
      ok: false,
      error: "No item 9 in the loop",
    });

    // Item 1 runs; it cannot be skipped while it does
    runItem("done");
    const two = nextTurn(history().length);
    expect(two?.prompt).toContain("only this item: Two");
    expect(skipLoopItem("2").ok).toBe(false);
    expect(runLoopItemAgain("2").ok).toBe(false);

    // Item 3 is skipped meanwhile: the task list shows it cancelled
    expect(skipLoopItem("3").ok).toBe(true);
    expect(getSessionTaskPlan()!.items[2].status).toBe("cancelled");

    // Item 1 again: the next run says it is a repeat at the person's request
    expect(runLoopItemAgain("1").ok).toBe(true);
    expect(getSessionTaskPlan()!.items[0].status).toBe("pending");
    const loop = loopNow();
    commitLoop({
      ...loop,
      current: loop.current && {
        ...loop.current,
        report: { outcome: "done", summary: "Two done" },
      },
    });
    const again = nextTurn(history().length);
    expect(again?.prompt).toContain("only this item: One");
    expect(again?.prompt).toContain("the person asked for it to run again");

    // The limits: out of bounds is refused, and nothing changes
    expect(setRunningLoopBudget({ maxRounds: 51 })).toEqual({
      ok: false,
      error: "maxRounds must be an integer from 1 to 50",
    });
    expect(loopNow().budget.maxRounds).toBe(3);
    expect(
      setRunningLoopBudget({ maxRounds: 1, maxTokens: 0, maxWallMs: 600_000 })
        .ok,
    ).toBe(true);
    expect(loopNow().budget).toMatchObject({
      maxRounds: 1,
      maxTokens: 0,
      maxWallMs: 600_000,
    });

    // Item 1 ends; everything is finished, one of them skipped
    const ran = loopNow();
    commitLoop({
      ...ran,
      current: ran.current && {
        ...ran.current,
        report: { outcome: "done", summary: "One checked" },
      },
    });
    expect(nextTurn(history().length)).toBeUndefined();
    expect(loopNow()).toMatchObject({
      status: "stopped",
      stopReason: "done",
      stopDetail: "All 3 items are done (1 skipped).",
    });
  });

  describe("checks and dependencies (L6)", () => {
    const PASS = 'node -e "process.exit(0)"';
    const FAIL = "node -e \"console.log('1 test failed'); process.exit(3)\"";

    async function planWith(
      todos: {
        text: string;
        check?: string;
        after?: number[];
        model?: string;
      }[],
    ) {
      await savePlan({ title: "Work", plan: "The work.", todos }, cwd);
    }

    /** The next step, which must be the given item's check; runs it. */
    async function runCheck(itemId: string) {
      const step = nextLoopTurn(history().length);
      expect(step).toMatchObject({ kind: "check", itemId });
      if (step?.kind !== "check") throw new Error("no check step");
      await runLoopCheck(step);
    }

    it("runs an item's check after it reports done: pass means done", async () => {
      await planWith([{ text: "One", check: PASS }, { text: "Two" }]);
      startLoopFromPlan("normal");
      services.toolPermissions.switchMode("auto");
      const turn = runItem("done");
      expect(turn.prompt).toContain(`its check runs: \`${PASS}\``);
      await runCheck("1");
      expect(loopNow().items[0]).toMatchObject({
        status: "done",
        check: { status: "passed", exitCode: 0 },
      });
      expect(nextTurn(history().length)?.prompt).toContain(
        "only this item: Two",
      );
    });

    it("holds an item with no check of its own to the fallback check, when one is set", async () => {
      const FALLBACK_FAIL = 'node -e "process.exit(4)"';
      await planWith([{ text: "One" }, { text: "Two", check: PASS }]);
      startLoopFromPlan("normal");
      expect(setRunningLoopFallbackCheck(FALLBACK_FAIL)).toBe(true);
      services.toolPermissions.switchMode("auto");
      const turn = runItem("done");
      expect(turn.prompt).toContain(`its check runs: \`${FALLBACK_FAIL}\``);
      await runCheck("1");
      expect(loopNow().items[0]).toMatchObject({
        status: "pending",
        check: { status: "failed" },
      });
      // The fallback is the loop's: a fix that makes it pass finishes the item
      expect(setRunningLoopFallbackCheck(PASS)).toBe(true);
      runItem("done");
      await runCheck("1");
      expect(loopNow().items[0].status).toBe("done");
    });

    it("without the setting an item with no check is done on its own report", async () => {
      await planWith([{ text: "One" }]);
      startLoopFromPlan("normal");
      expect(loopNow().fallbackCheck).toBeUndefined();
      runItem("done");
      // No check step: the next step goes straight past the finished item
      expect(nextLoopTurn(history().length)).toBeUndefined();
      expect(loopNow().items[0].status).toBe("done");
    });

    it("a loop started with CONTINUOUS_LOOP_FALLBACK_CHECK set carries it", async () => {
      await planWith([{ text: "One" }]);
      process.env.CONTINUOUS_LOOP_FALLBACK_CHECK = ` ${PASS} `;
      try {
        startLoopFromPlan("normal");
      } finally {
        delete process.env.CONTINUOUS_LOOP_FALLBACK_CHECK;
      }
      expect(loopNow().fallbackCheck).toBe(PASS);
    });

    it("a failing check sends the item back with what it printed", async () => {
      await planWith([{ text: "One", check: FAIL }]);
      startLoopFromPlan("normal");
      services.toolPermissions.switchMode("auto");
      runItem("done");
      await runCheck("1");
      // The code the check chose, on every platform: under PowerShell the
      // check runs through withRealExitCode (core/util/shell.ts).
      const code = 3;
      expect(loopNow().items[0]).toMatchObject({
        status: "pending",
        check: { status: "failed", exitCode: code },
      });
      const again = nextTurn(history().length);
      expect(again?.prompt).toContain(
        `failed (exit ${code}). Fix what it reports:`,
      );
      expect(again?.prompt).toContain("1 test failed");
    });

    it("a check a rule excludes fails the item and does not count it done", async () => {
      await planWith([{ text: "One", check: PASS }, { text: "Two" }]);
      startLoopFromPlan("normal");
      services.toolPermissions.initializeSync({
        mode: "normal",
        exclude: ["Bash"],
      });
      runItem("done");
      await runCheck("1");
      expect(loopNow().items[0]).toMatchObject({
        status: "failed",
        check: { status: "refused" },
      });
      expect(loopNow().items[0].summary).toContain("check not run");
      expect(loopNow().items[1].status).toBe("pending");
      expect(loopNow().doneThisRound).toBe(0);
      expect(loopNow().stopReason).not.toBe("done");
      // The item failed its check, so the loop does not go on as if it were done
      const next = nextLoopTurn(history().length);
      const prompt = next && "prompt" in next ? next.prompt : "";
      expect(prompt).toContain("check not run");
      expect(prompt).not.toContain("All 2 items are done");
    });

    it("not allowing a held check leaves the item failed, not done", async () => {
      await planWith([{ text: "One", check: PASS }]);
      startLoopFromPlan("normal");
      runItem("done");
      await runCheck("1");
      const q = loopNow().questions.find((x) => x.kind === "approval")!;
      answerLoopQuestion({ questionId: q.id, text: "", approve: false });
      expect(loopNow().items[0]).toMatchObject({
        status: "failed",
        check: { status: "refused" },
      });
      expect(loopNow().items[0].summary).toContain("check not run");
      expect(loopNow().doneThisRound).toBe(0);
      expect(loopNow().stopReason).not.toBe("done");
    });

    it("a check that would ask is held in the inbox; Allow once runs it", async () => {
      await planWith([{ text: "One", check: PASS }]);
      startLoopFromPlan("normal");
      runItem("done");
      // Normal mode asks before Bash: the check is held, not run
      await runCheck("1");
      const q = loopNow().questions.find((x) => x.kind === "approval")!;
      expect(q.question).toContain(`Allow this call? Bash: ${PASS}`);
      expect(loopNow().items[0].status).toBe("checking");
      expect(nextLoopTurn(history().length)).toBeUndefined();
      expect(loopNow().status).toBe("waiting");

      answerLoopQuestion({ questionId: q.id, text: "", approve: true });
      await runCheck("1");
      expect(loopNow().items[0]).toMatchObject({
        status: "done",
        check: { status: "passed" },
      });
    });

    it("an item runs only after what it comes after, written as after: in the plan file", async () => {
      await planWith([{ text: "Docs", after: [2] }, { text: "Helper" }]);
      expect(getSessionTaskPlan()?.items[0].after).toEqual(["2"]);
      startLoopFromPlan("normal");
      expect(runItem("done").prompt).toContain("only this item: Helper");
      expect(runItem("done").prompt).toContain("only this item: Docs");
      expect(loopPlanBlockForRequest()).toContain("[x] 2. Helper");
    });

    it("an item's turn names the item, and a model: line that is not configured is noted on its run", async () => {
      await planWith([
        { text: "Hard", model: "Claude Opus" },
        { text: "Easy" },
      ]);
      const file = fs.readFileSync(
        path.join(cwd, ".continuous", "plans", "work.md"),
        "utf-8",
      );
      expect(file).toContain(
        ["- [ ] Hard <!-- id: 1 -->", "  model: Claude Opus", ""].join("\n"),
      );
      expect(getSessionTaskPlan()?.items[0].model).toBe("Claude Opus");
      startLoopFromPlan("normal");
      const turn = runItem("done");
      expect(turn.itemId).toBe("1");
      // The harness has one model, test-model: the item falls back to it
      expect(loopNow().items[0].model).toMatchObject({
        fallbackReason: expect.stringContaining(
          '"Claude Opus" is not configured',
        ),
      });
      await prepareLoopTurn(turn);
      expect(loopNow().modelBefore).toBeUndefined();
      expect(runItem("done")).toMatchObject({ itemId: "2" });
      expect(loopNow().items[1].model).toBeUndefined();
    });
  });
});
