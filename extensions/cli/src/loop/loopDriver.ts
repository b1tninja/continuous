import fs from "fs";

import type { ChatHistoryItem, LoopState } from "core/index.js";
import { overBudgetReport } from "core/util/itemBudget.js";
import {
  decideNext,
  endReplan,
  enterWait,
  finishItemRun,
  itemCheck,
  LOOP_AUTONOMY,
  loopReplanTurnPrompt,
  proceedUnanswered,
  reconcileLoop,
  releaseEmptyWait,
  settleSteeredAnswers,
  startCheck,
  startItemRun,
  startReplan,
  stopLoop,
} from "core/util/loopMode.js";
import {
  reminderPathsDue,
  replanReminderTarget,
  takeReminders,
} from "core/util/loopReminders.js";
import {
  parsePlanFile,
  PRESENT_PLAN_CLI_TOOL_NAME,
} from "core/util/planFile.js";
import { finishItemNudge, presentPlanNudge } from "core/util/turnEnd.js";

import { loopItemModelRecord, services } from "../services/index.js";
import { getSessionLoop, getSessionTaskPlan } from "../session.js";
import { logger } from "../util/logger.js";

import { itemOverBudget } from "./loopBudget.js";
import { type LoopCheckStep, runLoopCheck } from "./loopChecks.js";
import { prepareItemRun } from "./loopItemRun.js";
import { stampFiles } from "./loopReminderFiles.js";
import {
  acceptLoopPlan,
  CLI_LOOP_TOOL_NAMES,
  commitLoop,
  dropPendingSteers,
  enterItemMode,
  enterReplanMode,
  pendingSteerIds,
  planFileDisplayPath,
  planFilePath,
  sessionCostMark,
  sessionTokens,
  prepareLoopTurn,
} from "./loopSession.js";
import { startWave } from "./loopWave.js";

/**
 * Loop mode's driver in the CLI, the counterpart of the IDE's advanceLoop
 * (gui/src/redux/thunks/loop.ts): when nothing is running, finish what ran,
 * decide what is next (core's decideNext) and say which turn to send. The
 * TUI (LoopRunner) and `cn serve` send it their own way.
 */

export interface LoopTurn {
  kind: "item" | "replan";
  /** The user message to send; it starts the run's fresh context */
  prompt: string;
  /** An item turn: the item that runs (its to-do may name its model) */
  itemId?: string;
}

/** A parallel wave to start (loopWave.ts): these items run as workers at once. */
export interface LoopWaveStep {
  kind: "wave";
  itemIds: string[];
}

/**
 * What the loop does next: a model turn to send, an item's check to run, or
 * a wave of workers to start.
 */
export type LoopStep = LoopTurn | LoopCheckStep | LoopWaveStep;

function historyNow(): ChatHistoryItem[] {
  try {
    return services.chatHistory.getHistory();
  } catch {
    return [];
  }
}

/** Whether PresentPlan ran to the end in the history since `index`. */
function presentedSince(index: number): boolean {
  return historyNow()
    .slice(index)
    .flatMap((item) => item.toolCallStates ?? [])
    .some(
      (tc) =>
        tc.toolCall.function.name === PRESENT_PLAN_CLI_TOOL_NAME &&
        tc.status === "done",
    );
}

/**
 * A run that ended over its item's own budget, with no report, is not nudged
 * to report: it ends as over budget, its work kept (core's finishItemRun).
 */
function markOverBudget(loop: LoopState): LoopState {
  const breach = loop.current ? itemOverBudget(loop) : undefined;
  if (!breach || !loop.current) return loop;
  return {
    ...loop,
    current: {
      ...loop.current,
      overBudget: breach,
      report: overBudgetReport(breach),
    },
  };
}

function planTitle(): string | undefined {
  const file = planFilePath();
  if (!file) return undefined;
  try {
    return parsePlanFile(fs.readFileSync(file, "utf-8")).title;
  } catch {
    return undefined;
  }
}

/**
 * A run that ended without what ends it (finish_item's report, a re-plan's
 * plan) is told once to call the tool, in the same run; only a second such
 * end counts. Returns the nudge turn, or undefined when the run was nudged
 * already (core/util/turnEnd.ts).
 */
function nudgeRun(loop: LoopState, prompt: string): LoopTurn | undefined {
  const current = loop.current;
  if (!current || current.nudged) return undefined;
  commitLoop({ ...loop, current: { ...current, nudged: true } });
  return { kind: current.kind === "replan" ? "replan" : "item", prompt };
}

/**
 * Records the end of the run that was going: its report, or a re-plan's
 * plan. A LoopTurn means the run is not over: it is being told to report.
 */
function finishRun(
  loop: LoopState,
): LoopState | LoopTurn | "accepted" | "awaiting" {
  if (loop.current?.kind === "item") {
    if (!loop.current.report) {
      const nudge = nudgeRun(
        loop,
        finishItemNudge(CLI_LOOP_TOOL_NAMES.finishItem),
      );
      if (nudge) return nudge;
    }
    const pending = new Set(pendingSteerIds());
    dropPendingSteers();
    const delivered = loop.answers
      .filter((a) => a.route === "steer" && !a.delivered && !pending.has(a.id))
      .map((a) => a.id);
    // A done item with a check waits for it (core's "checking")
    const checked = getSessionTaskPlan()?.items.find(
      (t) => t.id === loop.current?.itemId,
    );
    const check = checked ? itemCheck(loop, checked) : undefined;
    const itemId = loop.current.itemId;
    const settled = settleSteeredAnswers(
      finishItemRun(loop, loop.current.report, {
        check,
        sessionTokens: sessionTokens(),
        costMark: sessionCostMark(),
        now: new Date(),
      }),
      delivered,
    );
    // Waiting with no question open would wait forever
    return itemId ? releaseEmptyWait(settled, itemId) : settled;
  }
  if (loop.current?.kind === "replan") {
    if (!presentedSince(loop.current.historyIndex)) {
      // One nudge first: a small model wrote the PresentPlan call as text
      // once in six runs, and one text reply must not end the whole loop
      const nudge = nudgeRun(
        loop,
        presentPlanNudge(CLI_LOOP_TOOL_NAMES.presentPlan),
      );
      if (nudge) return nudge;
      commitLoop(
        stopLoop(
          loop,
          "replan_failed",
          "The re-plan ended without presenting a plan.",
        ),
      );
      return "awaiting";
    }
    // The loop's level (and, for a repair, its scope) says which re-plans
    // start by themselves; anything else waits for "Continue the loop".
    const ended = endReplan(loop, getSessionTaskPlan());
    commitLoop(ended.loop);
    return ended.accept && acceptLoopPlan() ? "accepted" : "awaiting";
  }
  return loop;
}

/**
 * One step of the loop when nothing is running. `historyLength` is the
 * history's length now: the turn this returns starts there, so the run's
 * request can start at its own prompt. Returns undefined when there is
 * nothing to send (the loop stopped, waits, or waits on a plan).
 */
export function nextLoopTurn(
  historyLength: number,
  now = new Date(),
): LoopStep | undefined {
  for (let guard = 0; guard < 4; guard++) {
    const saved = getSessionLoop();
    if (
      !saved ||
      saved.status === "stopped" ||
      saved.status === "awaiting_plan"
    ) {
      return undefined;
    }
    let loop: LoopState = saved;

    // 1. Finish what ran.
    if (loop.current) {
      const finished = finishRun(markOverBudget(loop));
      if (finished === "awaiting") return undefined;
      if (finished === "accepted") continue;
      // The run is not over: it is being told to call its finishing tool
      if ("prompt" in finished) return finished;
      loop = finished;
    }

    // 2. Decide what is next.
    const plan = getSessionTaskPlan();
    if (!plan) {
      commitLoop(stopLoop(loop, "done", "The task list is empty."));
      return undefined;
    }
    loop = reconcileLoop(loop, plan);
    const action = decideNext(loop, plan, {
      now,
      sessionTokens: sessionTokens(),
    });
    const planFile = planFileDisplayPath();
    logger.debug("Loop step", { action });

    switch (action.kind) {
      case "none":
        commitLoop(loop);
        return undefined;
      case "wait":
        commitLoop(enterWait(loop, now));
        return undefined;
      case "proceed":
        // Unattended and nobody answered in time: the items go on
        commitLoop(proceedUnanswered(loop, now));
        continue;
      case "stop":
        commitLoop(stopLoop(loop, action.reason, action.detail, action.budget));
        return undefined;
      case "check":
        // The harness runs the item's check (runLoopCheck); no model turn
        loop = startCheck(loop, action.itemId, historyLength, now);
        commitLoop(loop);
        return {
          kind: "check",
          itemId: action.itemId,
          command: action.command,
        };
      case "run": {
        const item = plan.items.find((i) => i.id === action.itemId)!;
        const prepared = prepareItemRun(loop, plan, item, now, { planFile });
        // The to-do's own model (TaskItem.model) wins over modeModels.loop;
        // one that is not configured falls back to it, noted on the run.
        // prepareLoopTurn makes the switch before the turn is sent.
        loop = startItemRun(prepared.loop, action.itemId, historyLength, now, {
          model: loopItemModelRecord(item.model),
          sessionTokens: sessionTokens(),
          costMark: sessionCostMark(),
        });
        enterItemMode();
        commitLoop(loop);
        return { kind: "item", prompt: prepared.prompt, itemId: action.itemId };
      }
      case "run_parallel":
        // The host starts the wave (loopWave.ts startWave); each worker's
        // end comes back through the loop, and the host looks again
        commitLoop(loop);
        return { kind: "wave", itemIds: action.itemIds };
      case "replan": {
        // A round's re-plan, a check-in, or a repair of one failed item
        const replanTarget = replanReminderTarget(action);
        const taken = takeReminders(
          loop,
          replanTarget,
          stampFiles(reminderPathsDue(loop, replanTarget)),
          now,
        );
        loop = taken.loop;
        const prompt = loopReplanTurnPrompt(action, {
          loop,
          plan,
          planFile,
          planTitle: planTitle(),
          toolNames: CLI_LOOP_TOOL_NAMES,
          reminders: taken.reminders,
        });
        loop = startReplan(loop, historyLength, now, {
          plan,
          checkIn: action.checkIn,
          itemId: action.itemId,
        });
        enterReplanMode();
        commitLoop(loop);
        return { kind: "replan", prompt };
      }
    }
  }
  return undefined;
}

/**
 * Milliseconds until an unattended loop that waits on the person goes on
 * without answers, or undefined when it does not wait or waits for as long
 * as it takes.
 */
export function loopWakeDelay(
  loop: LoopState | undefined,
  now = Date.now(),
): number | undefined {
  if (loop?.status !== "waiting" || !loop.waitingSince) return undefined;
  const wait = LOOP_AUTONOMY[loop.autonomy ?? "auto"].waitTimeoutMs;
  if (wait <= 0) return undefined;
  return Math.max(0, new Date(loop.waitingSince).getTime() + wait - now);
}

export interface LoopHost {
  /** Nothing is streaming and nothing of the person's is about to be sent */
  isIdle(): boolean;
  historyLength(): number;
  /** Sends the turn as a user message; resolves when the turn has ended */
  send(turn: LoopTurn): Promise<void>;
}

/**
 * Runs the loop for a host: one step at a time, only while the host is
 * idle. kick() is safe to call at any time (a turn's end, an answer, a loop
 * change); a kick while a step runs is ignored, as the step checks again
 * after its turn.
 */
export class LoopRunner {
  private stepping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly host: LoopHost) {}

  kick(): void {
    void this.step();
  }

  async step(): Promise<void> {
    if (this.stepping || this.disposed) return;
    this.stepping = true;
    try {
      while (!this.disposed && this.host.isIdle()) {
        const step = nextLoopTurn(this.host.historyLength());
        if (!step) break;
        if (step.kind === "check") {
          await runLoopCheck(step);
        } else if (step.kind === "wave") {
          // Resolves once the workers have started; each one's end kicks
          await startWave(step.itemIds, () => this.kick());
        } else {
          await prepareLoopTurn(step);
          await this.host.send(step);
        }
      }
    } catch (error) {
      logger.error("Loop step failed", { error });
    } finally {
      this.stepping = false;
      this.scheduleWake();
    }
  }

  /** Unattended: wake the loop when its wait for answers runs out. */
  private scheduleWake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const delay = loopWakeDelay(getSessionLoop());
    if (delay === undefined || this.disposed) return;
    this.timer = setTimeout(() => this.kick(), delay);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
