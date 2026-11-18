import { execSync, fork } from "child_process";
import path from "node:path";

import type { LoopReminder, LoopState, TaskItem, Usage } from "core/index.js";
import type { AuditAgent } from "core/tools/permissions/audit/record.js";
import {
  finishParallelRun,
  itemCheck,
  loopBudgetStop,
  loopElapsedMs,
  loopTokensFromUsage,
  runItemInline,
  startParallelRun,
  stopLoop,
} from "core/util/loopMode.js";

import { emitAgent, ensureMainAgent, tokensOf } from "../agents/feed.js";
import { cliAuditSession } from "../audit/cliAudit.js";
import {
  cleanupWorktree,
  createWorktree,
} from "../commands/review/worktree.js";
import {
  effectiveLevels,
  getCommandPermissionFlags,
} from "../permissions/policyLevels.js";
import type { PermissionMode } from "../permissions/types.js";
import {
  getServiceSync,
  loopItemModelRecord,
  loopWorkerModelName,
  SERVICE_NAMES,
} from "../services/index.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";
import type { ConfigServiceState } from "../services/types.js";
import {
  getSessionLoop,
  getSessionTaskPlan,
  getSessionUsage,
  trackSessionUsage,
} from "../session.js";
import { logger } from "../util/logger.js";

import { usageSince } from "./loopBudget.js";
import { prepareItemRun } from "./loopItemRun.js";
import {
  commitLoop,
  planFileDisplayPath,
  sessionTokens,
  setWaveAbort,
} from "./loopSession.js";
import {
  LOOP_WORKER_FLAG,
  type LoopWorkerInput,
  type LoopWorkerMessage,
  type LoopWorkerOutput,
} from "./loopWorker.js";
import { nextWorkerAgent } from "./workerIdentity.js";

/**
 * A parallel wave in the CLI (L4): core's `run_parallel` action names items
 * with disjoint files; each gets a worktree and a worker process
 * (loopWorker.ts) with a fresh context. As each worker ends, its patch is
 * applied to the main checkout, the run is finished in the loop
 * (finishParallelRun: a refused patch sends the item back to run inline),
 * the worktree is removed and the host is told to look again. The person's
 * own messages keep going meanwhile; nothing else of the loop starts until
 * the wave is done (decideNext). Design: plans/loop-mode.md.
 */

/** The longest one worker may run before it is stopped and counts as an attempt. */
export const LOOP_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

/** A worker is never given less than this, so a nearly spent budget still gets a start. */
const LOOP_WORKER_MIN_TIMEOUT_MS = 1000;

/**
 * How long this worker may run: the fixed ceiling, or less when the item's
 * own time limit (what its earlier runs left of it) or the loop's time budget
 * (waiting on the person not counted) runs out sooner. The budgets stop the
 * loop or the item on their own; this keeps a worker from outliving them.
 */
export function workerTimeoutMs(
  input: Pick<LoopWorkerInput, "loop" | "plan">,
  now: Date = new Date(),
): number {
  const { loop, plan } = input;
  let timeout = LOOP_WORKER_TIMEOUT_MS;
  const itemId = loop.current?.itemId ?? loop.parallel?.[0]?.itemId;
  const minutes = plan.items.find((t) => t.id === itemId)?.budget?.minutes;
  if (itemId && minutes && minutes > 0) {
    const spent = loop.items.find((i) => i.id === itemId)?.usage?.ms ?? 0;
    timeout = Math.min(timeout, minutes * 60_000 - spent);
  }
  if (loop.budget.maxWallMs > 0) {
    timeout = Math.min(
      timeout,
      loop.budget.maxWallMs - loopElapsedMs(loop, now),
    );
  }
  return Math.max(LOOP_WORKER_MIN_TIMEOUT_MS, timeout);
}

export interface LoopWorktreeOps {
  /** A worktree for the item, with the main checkout's uncommitted changes */
  create(itemId: string): Promise<string>;
  /** Applies a worker's patch to the main checkout; a refusal says why */
  apply(patch: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(path: string): Promise<void>;
}

export type LoopWorkerRunner = (
  input: LoopWorkerInput,
  signal: AbortSignal,
) => Promise<LoopWorkerOutput>;

const gitErrorText = (e: unknown): string => {
  const err = e as { stderr?: Buffer | string; message?: string };
  const stderr = err.stderr?.toString().trim();
  return stderr || err.message || String(e);
};

/**
 * The worktree helper `cn review` uses. The core helper
 * (`core/util/worktree.ts`, L4 P2) exists and the IDE uses it, but the CLI
 * has not moved to it: a detached worktree in the temp directory with the
 * uncommitted changes and a baseline commit, and a plain `git apply` to the
 * main checkout, checked first so a refusal changes nothing.
 */
const defaultWorktrees: LoopWorktreeOps = {
  create: (itemId) => createWorktree(Number.parseInt(itemId, 10) || 0),
  async apply(patch) {
    if (!patch.trim()) return { ok: true };
    const run = (args: string) =>
      execSync(`git apply ${args}`, {
        input: patch,
        stdio: ["pipe", "pipe", "pipe"],
      });
    try {
      run("--check -");
    } catch (e) {
      return { ok: false, reason: gitErrorText(e) };
    }
    try {
      run("-");
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: gitErrorText(e) };
    }
  },
  remove: cleanupWorktree,
};

const emptyOutput = (error: string): LoopWorkerOutput => ({
  questions: [],
  reminders: [],
  patch: "",
  usage: { promptTokens: 0, completionTokens: 0 },
  duration: 0,
  error,
});

/** Forks `cn --internal-loop-worker` and runs one item in it. */
const defaultRunWorker: LoopWorkerRunner = (input, signal) =>
  new Promise<LoopWorkerOutput>((resolve) => {
    const child = fork(process.argv[1], [LOOP_WORKER_FLAG], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || "" },
    });
    let settled = false;
    const settle = (output: LoopWorkerOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(output);
    };
    const timeoutMs = workerTimeoutMs(input);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(
        emptyOutput(
          `The worker ran for ${Math.max(1, Math.round(timeoutMs / 60000))} minutes and was stopped.`,
        ),
      );
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGTERM");
      settle(emptyOutput("The worker was stopped."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("message", (msg: LoopWorkerMessage) => {
      if (msg.type === "ready") {
        child.send({ type: "run-item", input } satisfies LoopWorkerMessage);
      } else if (msg.type === "usage") {
        const itemId = input.loop.current?.itemId;
        if (itemId) recordWorkerUsage(itemId, msg.usage);
      } else if (msg.type === "result") {
        settle(msg.result);
      }
    });
    child.on("error", (err) => settle(emptyOutput(err.message)));
    child.on("exit", (code) => {
      settle(
        emptyOutput(
          code === 0
            ? "The worker exited without a result."
            : `The worker exited with code ${code}.`,
        ),
      );
    });
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("exit", () => {
      if (stderr.trim()) logger.debug("Loop worker stderr", { stderr });
    });
  });

const deps = { worktrees: defaultWorktrees, runWorker: defaultRunWorker };

/** For tests: fake the worktrees and the worker. */
export function setLoopWaveDeps(
  overrides: Partial<{
    worktrees: LoopWorktreeOps;
    runWorker: LoopWorkerRunner;
  }>,
): void {
  Object.assign(deps, overrides);
}

export function resetLoopWaveDeps(): void {
  deps.worktrees = defaultWorktrees;
  deps.runWorker = defaultRunWorker;
}

/** The running wave's workers, by item, so Stop now can end them. */
const controllers = new Map<string, AbortController>();

/** The agent map's id for each running worker, by item. */
const workerAgents = new Map<string, string>();

function spawnWorkerAgent(
  itemId: string,
  worktree: string,
  model: string | undefined,
  agent: AuditAgent,
): void {
  const parent = ensureMainAgent();
  const id = agent.id;
  workerAgents.set(itemId, id);
  emitAgent({
    type: "spawned",
    id,
    parentId: parent,
    rootId: parent,
    kind: "loop-worker",
    role: agent.role ?? `item ${itemId}`,
    mode: agent.mode,
    model,
    workspace: { kind: "worktree", name: path.basename(worktree) },
    at: Date.now(),
  });
}

/** The worker's end for the agent map: its tokens, then how it ended. */
function endWorkerAgent(
  itemId: string,
  output: LoopWorkerOutput,
  stopped: boolean,
): void {
  const id = workerAgents.get(itemId);
  if (!id) return;
  workerAgents.delete(itemId);
  emitAgent({ type: "usage", id, tokens: tokensOf(output.usage) });
  emitAgent({
    type: "ended",
    id,
    state: output.error ? (stopped ? "stopped" : "failed") : "done",
    returnedLength: output.report?.summary?.length,
    at: Date.now(),
  });
}

function abortWave(): void {
  for (const controller of controllers.values()) controller.abort();
}

/**
 * The parent's permission choices for a worker. The levels are the ones in
 * force (`--auto` raises the tool areas to IDGAF): the worker never runs in
 * auto mode, so without them a worker of an `--auto` parent asked, and was
 * held, where its parent would have run the call.
 */
export function workerOptions(): LoopWorkerInput["options"] {
  let mode: PermissionMode = "normal";
  // Unknown counts as interactive: the stricter default lists, whose asks
  // the worker holds as questions rather than running
  let parentHeadless = false;
  try {
    const permissions = getServiceSync<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );
    mode = permissions.value?.currentMode ?? "normal";
    parentHeadless = permissions.value?.isHeadless ?? false;
  } catch {
    // The worker still loads the settings file.
  }
  const policy = {
    mode,
    parentHeadless,
    ...getCommandPermissionFlags(),
    levels: effectiveLevels(mode),
  };
  try {
    const config = getServiceSync<ConfigServiceState>(SERVICE_NAMES.CONFIG);
    return { config: config.value?.configPath, policy };
  } catch {
    return { policy };
  }
}

/**
 * Starts the wave core asked for: for each item, a worktree, the run in the
 * loop (startParallelRun) and a worker. Resolves once every worker has
 * started, not when they end: `onSettled` runs after each worker's result
 * is in the loop, for the host to look at the loop again. An item that
 * cannot get a worktree runs inline on a later step instead.
 */
export async function startWave(
  itemIds: string[],
  onSettled: () => void,
  now = new Date(),
): Promise<void> {
  const plan = getSessionTaskPlan();
  const saved = getSessionLoop();
  if (!plan || !saved) return;
  let loop: LoopState = saved;
  const planFile = planFileDisplayPath();
  const baselineUsage = getSessionUsage();
  const started: {
    item: TaskItem;
    worktree: string;
    input: LoopWorkerInput;
  }[] = [];
  for (const itemId of itemIds) {
    const item = plan.items.find((t) => t.id === itemId);
    if (!item) continue;
    let worktree: string;
    try {
      worktree = await deps.worktrees.create(itemId);
    } catch (error) {
      const reason = `could not create a worktree: ${gitErrorText(error)}`;
      logger.error("Loop wave: no worktree for the item", { itemId, error });
      loop = runItemInline(loop, itemId, reason);
      commitLoop(loop);
      continue;
    }
    const prepared = prepareItemRun(loop, plan, item, now, {
      planFile,
      worker: { worktree, files: item.files },
    });
    loop = startParallelRun(prepared.loop, itemId, now, {
      worktree,
      model: loopItemModelRecord(item.model),
    });
    commitLoop(loop);
    const run = loop.parallel?.find((r) => r.itemId === itemId);
    started.push({
      item,
      worktree,
      input: {
        worktree,
        options: workerOptions(),
        model: loopWorkerModelName(item.model),
        plan,
        prompt: prepared.prompt,
        baselineUsage,
        agent: nextWorkerAgent(cliAuditSession(), itemId),
        // The worker's loop names this item as its run; the others of the
        // wave show as running beside it
        loop: {
          ...loop,
          current: {
            kind: "item",
            itemId,
            historyIndex: 0,
            startedAt: run?.startedAt ?? now.toISOString(),
          },
        },
      },
    });
  }
  if (started.length === 0) return;
  setWaveAbort(abortWave);
  for (const entry of started) {
    const controller = new AbortController();
    controllers.set(entry.item.id, controller);
    spawnWorkerAgent(
      entry.item.id,
      entry.worktree,
      entry.input.model,
      entry.input.agent!,
    );
    void runOne(entry, controller.signal).finally(() => {
      controllers.delete(entry.item.id);
      if (controllers.size === 0) setWaveAbort(undefined);
      onSettled();
    });
  }
}

const reportedUsage = new Map<string, Usage>();

function usageToCount(usage: Usage): boolean {
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    (usage.promptTokensDetails?.cachedTokens ?? 0) > 0 ||
    (usage.promptTokensDetails?.cacheWriteTokens ?? 0) > 0
  );
}

/** Stop the loop when worker usage has spent the token or time budget. */
function stopWaveIfOverBudget(): void {
  const loop = getSessionLoop();
  if (!loop || loop.status === "stopped") return;
  const stop = loopBudgetStop(loop, {
    now: new Date(),
    sessionTokens: sessionTokens(),
  });
  if (!stop) return;
  commitLoop(stopLoop(loop, stop.reason, stop.detail, stop.budget));
  for (const id of workerAgents.values()) {
    emitAgent({ type: "ended", id, state: "over-budget", at: Date.now() });
  }
  workerAgents.clear();
  abortWave();
}

/**
 * Add a worker's cumulative usage to the session, counting only what was not
 * reported yet. `reported` is the worker's own usage since it started, cache
 * included, so the budget uses the same loopTokensFromUsage as an inline run.
 * Returns whether the loop is still running that item.
 */
export function recordWorkerUsage(itemId: string, reported: Usage): boolean {
  const delta = usageSince(
    reportedUsage.get(itemId) ?? { promptTokens: 0, completionTokens: 0 },
    reported,
  );
  reportedUsage.set(itemId, reported);
  const agentId = workerAgents.get(itemId);
  if (agentId)
    emitAgent({ type: "usage", id: agentId, tokens: tokensOf(reported) });
  if (usageToCount(delta)) trackSessionUsage(0, delta);
  stopWaveIfOverBudget();
  return !!getSessionLoop()?.parallel?.some((run) => run.itemId === itemId);
}

async function runOne(
  entry: { item: TaskItem; worktree: string; input: LoopWorkerInput },
  signal: AbortSignal,
): Promise<void> {
  let output: LoopWorkerOutput;
  try {
    output = await deps.runWorker(entry.input, signal);
  } catch (error) {
    output = emptyOutput(
      error instanceof Error ? error.message : String(error),
    );
  }
  endWorkerAgent(entry.item.id, output, signal.aborted);
  try {
    await settleRun(entry, output);
  } catch (error) {
    logger.error("Loop wave: could not finish the item's run", {
      itemId: entry.item.id,
      error,
    });
  }
  try {
    await deps.worktrees.remove(entry.worktree);
  } catch (error) {
    logger.debug("Loop wave: could not remove the worktree", {
      worktree: entry.worktree,
      error,
    });
  }
}

/**
 * A worker ended: its patch goes into the main checkout (a refusal sends
 * the item back to run inline), its report, questions and reminders into
 * the loop, and its tokens into the session's count, which the loop's
 * budget reads.
 */
async function settleRun(
  entry: { item: TaskItem; input: LoopWorkerInput },
  output: LoopWorkerOutput,
): Promise<void> {
  // Usage first, including a worker that already reported some of it: the
  // budget can stop the wave here, before the patch is applied.
  if (!recordWorkerUsage(entry.item.id, output.usage)) {
    reportedUsage.delete(entry.item.id);
    return;
  }
  reportedUsage.delete(entry.item.id);
  const loop = getSessionLoop();
  if (!loop) return;
  let mergeFailed: string | undefined;
  if (!output.error && output.patch.trim()) {
    const applied = await deps.worktrees.apply(output.patch);
    if (!applied.ok) mergeFailed = applied.reason;
  }
  const finished = finishParallelRun(
    loop,
    entry.item.id,
    {
      report: output.report,
      questions: output.questions,
      mergeFailed,
      error: output.error,
      tokens: loopTokensFromUsage(output.usage),
    },
    new Date(),
    { check: itemCheck(loop, entry.item) },
  );
  commitLoop(withWorkerReminders(finished, output.reminders));
}

/** The reminders a worker saved, numbered after the loop's own. */
function withWorkerReminders(
  loop: LoopState,
  reminders: LoopReminder[],
): LoopState {
  if (!reminders.length) return loop;
  const existing = loop.reminders ?? [];
  let max = 0;
  for (const { id } of existing) {
    const n = Number(id.replace(/^r/, ""));
    if (Number.isInteger(n) && n > max) max = n;
  }
  const added = reminders.map((r) => ({ ...r, id: `r${++max}` }));
  return { ...loop, reminders: [...existing, ...added] };
}
