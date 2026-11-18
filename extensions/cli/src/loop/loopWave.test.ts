import fs from "fs";
import os from "os";
import path from "path";

import { agentRegistry } from "core/agents/registry.js";
import type { LoopState } from "core/index.js";
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
  updateSessionLoop,
} from "../session.js";
import { savePlan } from "../tools/presentPlan.js";
import {
  registerFlowServices,
  resetFlowState,
  ScriptedLlm,
  waitUntil,
} from "../ui/__tests__/TUIChat.flowHarness.js";

import { loopWakeDelay, nextLoopTurn, type LoopStep } from "./loopDriver.js";
import {
  interruptRunningLoop,
  resetLoopMemory,
  setRunningLoopParallel,
  startLoopFromPlan,
} from "./loopSession.js";
import {
  resetLoopWaveDeps,
  setLoopWaveDeps,
  startWave,
  type LoopWorktreeOps,
} from "./loopWave.js";
import type { LoopWorkerInput, LoopWorkerOutput } from "./loopWorker.js";
import { resetWorkerIdentities } from "./workerIdentity.js";

/**
 * Parallel waves in the CLI (L4 P3): the driver asks for a wave, startWave
 * gives each item a worktree and a worker, and each worker's end is merged
 * into the main checkout and the loop in finish order. The worktrees and
 * the workers are faked: the real ones fork `cn` and run git.
 */
describe("Loop mode's parallel waves in the CLI", () => {
  let cwd: string;
  const created: string[] = [];
  const applied: string[] = [];
  const removed: string[] = [];
  /** Workers waiting for the test to end them, by item */
  const workers = new Map<
    string,
    { input: LoopWorkerInput; end: (output: LoopWorkerOutput) => void }
  >();
  let kicks = 0;

  const worktrees: LoopWorktreeOps = {
    async create(itemId) {
      const p = `/wt/${itemId}`;
      created.push(p);
      return p;
    },
    async apply(patch) {
      applied.push(patch);
      return patch.includes("CONFLICT")
        ? { ok: false, reason: "a.ts changed in the main checkout" }
        : { ok: true };
    },
    async remove(p) {
      removed.push(p);
    },
  };

  const output = (
    partial: Partial<LoopWorkerOutput> = {},
  ): LoopWorkerOutput => ({
    questions: [],
    reminders: [],
    patch: "",
    usage: { promptTokens: 100, completionTokens: 20 },
    duration: 1,
    ...partial,
  });

  const loopNow = (): LoopState => getSessionLoop()!;
  const status = (id: string) =>
    loopNow().items.find((i) => i.id === id)?.status;
  const history = () => services.chatHistory.getHistory();
  const kick = () => {
    kicks++;
  };
  /** Waits for the wave's workers to be settled into the loop. */
  const until = (predicate: () => boolean, what: string) =>
    waitUntil(predicate, what, () => undefined);

  beforeEach(async () => {
    await resetFlowState();
    // The levels are process-wide; an earlier test's must not carry over
    resetPolicyLevels();
    updateSessionLoop(undefined);
    resetLoopMemory();
    agentRegistry.reset();
    resetWorkerIdentities();
    created.length = 0;
    applied.length = 0;
    removed.length = 0;
    workers.clear();
    kicks = 0;
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cn-loop-wave-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    await registerFlowServices({ llm: new ScriptedLlm([]), mode: "auto" });
    createSession([]);
    await services.chatHistory.initialize(getCurrentSession(), false);
    setLoopWaveDeps({
      worktrees,
      runWorker: (input, signal) =>
        new Promise<LoopWorkerOutput>((resolve) => {
          const itemId = input.loop.current!.itemId!;
          workers.set(itemId, { input, end: resolve });
          signal.addEventListener("abort", () =>
            resolve(output({ error: "The worker was stopped." })),
          );
        }),
    });
  });

  afterEach(async () => {
    resetLoopWaveDeps();
    updateSessionLoop(undefined);
    resetLoopMemory();
    await resetFlowState();
    vi.restoreAllMocks();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function planWith(
    todos: { text: string; files?: string[]; check?: string }[],
  ) {
    await savePlan({ title: "Work", plan: "The work.", todos }, cwd);
    // `auto` mode: the level does not ask, so a wave may run
    startLoopFromPlan("auto");
    setRunningLoopParallel(true);
  }

  /** The driver's next step, which must be a wave; starts it. */
  async function startNextWave(): Promise<string[]> {
    const step = nextLoopTurn(history().length) as LoopStep | undefined;
    expect(step?.kind).toBe("wave");
    if (step?.kind !== "wave") throw new Error("no wave");
    await startWave(step.itemIds, kick);
    return step.itemIds;
  }

  it("runs items with disjoint files as workers at once and merges them in finish order; the rest run inline after", async () => {
    await planWith([
      { text: "Lexer", files: ["src/lexer.ts"], check: "npm test -- lexer" },
      { text: "Parser", files: ["src/parser.ts"] },
      { text: "Docs" },
    ]);
    expect(await startNextWave()).toEqual(["1", "2"]);

    // Both run, each in its own worktree, and nothing else starts
    expect(created).toEqual(["/wt/1", "/wt/2"]);
    expect(loopNow().parallel?.map((r) => r.itemId)).toEqual(["1", "2"]);
    expect(status("1")).toBe("running");
    expect(status("2")).toBe("running");
    expect(nextLoopTurn(history().length)).toBeUndefined();
    // Each worker gets the parent's loop naming its own item, and a prompt
    // that says where it runs and what it may touch
    const parser = workers.get("2")!;
    expect(parser.input.loop.current).toMatchObject({
      kind: "item",
      itemId: "2",
    });
    expect(parser.input.worktree).toBe("/wt/2");
    expect(parser.input.prompt).toContain("only this item: Parser");
    expect(parser.input.prompt).toContain(
      "its own copy of the repository at /wt/2",
    );
    expect(parser.input.prompt).toContain("src/parser.ts");
    expect(parser.input.plan.items).toHaveLength(3);

    // The parser finishes first: its patch is applied and it is done
    parser.end(
      output({
        report: { outcome: "done", summary: "parsed", notes: "use LL(1)" },
        patch: "diff --git a/src/parser.ts",
      }),
    );
    await until(() => status("2") === "done", "status 2     done");
    expect(applied).toEqual(["diff --git a/src/parser.ts"]);
    expect(removed).toEqual(["/wt/2"]);
    expect(loopNow().notes).toEqual(["use LL(1)"]);
    expect(loopNow().parallel?.map((r) => r.itemId)).toEqual(["1"]);
    expect(kicks).toBe(1);
    // The loop's budget counts the worker's tokens
    expect(getCurrentSession().usage?.promptTokens).toBe(100);

    // The lexer reports done with a check: it waits for the check, in the
    // main checkout, once its patch is in
    workers.get("1")!.end(
      output({
        report: { outcome: "done", summary: "lexed" },
        patch: "diff --git a/src/lexer.ts",
      }),
    );
    await until(() => status("1") === "checking", "status 1     checking");
    expect(applied).toHaveLength(2);
    expect(loopNow().parallel).toBeUndefined();
    const check = nextLoopTurn(history().length);
    expect(check).toMatchObject({ kind: "check", itemId: "1" });
    // Docs has no files: it runs inline, after the wave
    updateSessionLoop({
      ...loopNow(),
      current: undefined,
      items: loopNow().items.map((i) =>
        i.id === "1" ? { ...i, status: "done" } : i,
      ),
    });
    const inline = nextLoopTurn(history().length);
    expect(inline).toMatchObject({ kind: "item", itemId: "3" });
    expect(getSessionTaskPlan()?.items[0].files).toEqual(["src/lexer.ts"]);
  });

  it("a patch that does not merge sends the item back to run inline, with the reason in its prompt", async () => {
    await planWith([
      { text: "A", files: ["a.ts"] },
      { text: "B", files: ["b.ts"] },
    ]);
    await startNextWave();
    workers.get("1")!.end(
      output({
        report: { outcome: "done", summary: "a done" },
        patch: "CONFLICT diff --git a/a.ts",
      }),
    );
    await until(() => status("1") === "pending", "status 1     pending");
    expect(loopNow().items[0]).toMatchObject({
      runInline: true,
      mergeFailed: "a.ts changed in the main checkout",
    });
    workers.get("2")!.end(output({ report: { outcome: "done" } }));
    await until(
      () => loopNow().parallel === undefined,
      "loopNow parallel   undefined",
    );
    // Alone and marked inline, A runs as an ordinary turn on the merged tree
    const step = nextLoopTurn(history().length);
    expect(step).toMatchObject({ kind: "item", itemId: "1" });
    expect((step as { prompt: string }).prompt).toContain(
      "could not be merged: a.ts changed in the main checkout",
    );
  });

  it("a worker that dies counts as an attempt with the error as the summary; Stop now ends the others", async () => {
    await planWith([
      { text: "A", files: ["a.ts"] },
      { text: "B", files: ["b.ts"] },
    ]);
    await startNextWave();
    workers.get("1")!.end(output({ error: "The worker exited with code 1." }));
    await until(() => status("1") === "pending", "status 1     pending");
    expect(loopNow().items[0].summary).toBe(
      "The worker ended without reporting: The worker exited with code 1.",
    );
    expect(loopNow().items[0].attempts).toBe(1);
    expect(applied).toEqual([]);

    // Stop now: the remaining worker is aborted and its item comes back
    interruptRunningLoop();
    await until(
      () => loopNow().status === "stopped",
      "loopNow status    stopped",
    );
    expect(status("2")).toBe("pending");
    expect(loopNow().parallel).toBeUndefined();
    await until(() => removed.includes("/wt/2"), "removed includes wt 2");
    expect(loopWakeDelay(loopNow())).toBeUndefined();
  });

  it("shows each worker in the agent map and ends it as done, failed or stopped", async () => {
    const SECRET = "AKIAIOSFODNN7CANARY0";
    await planWith([
      { text: "A", files: ["a.ts"] },
      { text: "B", files: ["b.ts"] },
    ]);
    await startNextWave();
    const workersNow = () =>
      agentRegistry.list().filter((n) => n.kind === "loop-worker");
    expect(workersNow().map((n) => [n.role, n.state])).toEqual([
      ["item 1", "running"],
      ["item 2", "running"],
    ]);
    const main = agentRegistry.list().find((n) => n.kind === "main");
    expect(workersNow().every((n) => n.parentId === main?.id)).toBe(true);
    expect(workersNow()[0].workspace).toEqual({ kind: "worktree", name: "1" });
    // The node and the audit record name the worker the same way: the item's
    // id and the mode every host uses, and the worker is told who it is
    expect(workersNow().map((n) => [n.id, n.mode])).toEqual([
      ["worker-1", "agent"],
      ["worker-2", "agent"],
    ]);
    expect(workers.get("1")!.input.agent).toMatchObject({
      id: "worker-1",
      kind: "loop-worker",
      mode: "agent",
      role: "item 1",
    });

    workers.get("1")!.end(
      output({
        report: { outcome: "done", summary: `parsed ${SECRET}` },
        patch: `diff ${SECRET}`,
      }),
    );
    await until(() => status("1") === "done", "status 1     done");
    workers.get("2")!.end(output({ error: `exit ${SECRET}` }));
    await until(() => status("2") === "pending", "status 2     pending");

    const ended = workersNow();
    expect(ended.map((n) => n.state)).toEqual(["done", "failed"]);
    expect(ended[0]).toMatchObject({
      returnedLength: `parsed ${SECRET}`.length,
      tokens: { input: 100, output: 20 },
    });
    expect(JSON.stringify(agentRegistry.list())).not.toContain(SECRET);
  });

  it("without the switch, or under Supervised, items run one at a time as before", async () => {
    await savePlan(
      {
        title: "Work",
        plan: "The work.",
        todos: [
          { text: "A", files: ["a.ts"] },
          { text: "B", files: ["b.ts"] },
        ],
      },
      cwd,
    );
    startLoopFromPlan("auto");
    expect(nextLoopTurn(history().length)).toMatchObject({
      kind: "item",
      itemId: "1",
    });
    updateSessionLoop(undefined);
    resetPolicyLevels();
    // Supervised is the Plan edits and Questions levels at manual
    setPolicyLevels({
      ...getPolicyLevels(),
      plan: "manual",
      questions: "manual",
    });
    startLoopFromPlan("normal");
    setRunningLoopParallel(true);
    expect(loopNow().autonomy).toBe("supervised");
    expect(nextLoopTurn(history().length)).toMatchObject({
      kind: "item",
      itemId: "1",
    });
    expect(created).toEqual([]);
  });
});
