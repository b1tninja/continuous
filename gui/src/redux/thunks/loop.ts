import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  IDE,
  LoopAutonomy,
  LoopBudget,
  LoopState,
  LoopStrategy,
  MessageModes,
  ModelDescription,
  ModelUse,
  TaskItem,
  TaskPlan,
} from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  policyLevelLabel,
  questionsAutoAnswer,
} from "core/tools/permissions/policy";
import { autoAnsweredLine } from "core/util/autoAnswer";
import { autoAnswerPlanFile } from "../../util/planDecisions";
import { finishItemNudge, presentPlanNudge } from "core/util/turnEnd";
import type { PlanBudgetSetup } from "core/util/planBudget";
import { applyBudgetStep, applyLimitAfterRun } from "./loopBudget";
import { applyModeModel } from "./applyModeModel";
import {
  acceptReplan,
  answerLoop,
  answersToDeliver,
  createLoop,
  decideNext,
  endReplan,
  finishItemRun,
  finishParallelRun,
  holdCheck,
  interruptLoop,
  isLoopPaused,
  LEFT_LOOP_DETAIL,
  LOOP_LIMITS,
  openLoopItems,
  pauseLoop,
  itemCheck,
  loopItemPrompt,
  loopPlanBlock,
  loopReplanTurnPrompt,
  markDelivered,
  enterWait,
  loopDecidesAlone,
  loopPolicyOf,
  loopTokensFromUsage,
  proceedUnanswered,
  reconcileLoop,
  releaseEmptyWait,
  replanDecision,
  setLoopPolicy,
  setLoopParallel,
  setLoopStrategy,
  requestStop,
  resumeLoop,
  runItemAgain,
  setLoopBudget,
  settleSteeredAnswers,
  skipItem,
  type LoopControlResult,
  startItemRun,
  startParallelRun,
  standingInstructions,
  startReplan,
  stopLoop,
  withLoopPlanBlock,
  addAutoDecision,
} from "core/util/loopMode";
import { costMarkOf } from "core/util/loopCost";
import {
  reminderFilePaths,
  reminderPathsDue,
  replanReminderTarget,
  saveLaterReminder,
  saveReminder,
  takeReminders,
} from "core/util/loopReminders";
import { planHandoff } from "core/tools/permissions/policy";
import { modelForLoopItem } from "core/util/modelUse";
import { parsePlanFile, taskPlanFromPlanFile } from "core/util/planFile";
import type { WorktreeInfo } from "core/util/worktree";
import { findUriInDirs } from "core/util/uri";
import {
  selectLoopPolicy,
  selectPolicySettings,
} from "../selectors/selectAutoApproval";
import {
  enqueueMessage,
  removeQueuedMessage,
  setLoop,
  setLoopRequested,
  setMode,
  setModeAfterLoop,
  setTaskPlan,
} from "../slices/sessionSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { getModeModelTitle } from "../../util/modeModels";
import { commitLoop } from "../util/loopCommit";
import { stampLoopFiles } from "../util/loopReminderFiles";
import { loopWorktreeOps } from "../../util/loopWorktrees";
import { abortLoopWorkers } from "../../util/subagents/loopWorkers";
import {
  LoopWorkerResult,
  runLoopItemSubagent,
} from "../../util/subagents/runLoopItemSubagent";
import { IIdeMessenger } from "../../context/IdeMessenger";

import { runLoopCheck, workspacePath } from "./loopChecks";
import { streamResponseThunk } from "./streamResponse";

/**
 * Loop mode in the gui: the thunks that start, advance, answer and stop the
 * loop. The decisions are core's (core/util/loopMode.ts); these apply them to
 * the session and send the turns. useLoopDriver calls advanceLoop whenever
 * nothing is running. Design: plans/loop-mode.md.
 */

function doc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function sessionCostMark(state: RootState) {
  return costMarkOf(state.session.usage);
}

function sessionTokens(state: RootState): number {
  const usage = state.session.usage;
  return usage ? loopTokensFromUsage(usage) : 0;
}

async function displayPath(
  fileUri: string | undefined,
  getWorkspaceDirs: () => Promise<string[]>,
): Promise<string | undefined> {
  if (!fileUri) return undefined;
  try {
    const { relativePathOrBasename, foundInDir } = findUriInDirs(
      fileUri,
      await getWorkspaceDirs(),
    );
    return foundInDir ? relativePathOrBasename : fileUri;
  } catch {
    return fileUri;
  }
}

/**
 * Sends a Loop turn. The model is switched first to the one `modeModels` gives
 * this kind of turn (`loop` for an item, `replan` otherwise, with the agent and
 * plan entries as fallbacks), or to `title`, an item's own model: the mode's
 * own effect runs after a render, which may be later than the request.
 */
async function sendLoopTurn(
  dispatch: AppThunkDispatch,
  text: string,
  use?: ModelUse,
  title?: string,
) {
  if (use) await dispatch(applyModeModel({ mode: use, title }));
  await dispatch(
    streamResponseThunk({
      editorState: doc(text),
      modifiers: { noContext: true, useCodebase: false },
    }),
  );
}

/** Reads the plan file back (the person may have edited it) into the task list. */
async function readPlanIntoTaskList(
  planFile: string,
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  readFile: (uri: string) => Promise<string>,
): Promise<{ title?: string }> {
  try {
    const markdown = await readFile(planFile);
    const result = taskPlanFromPlanFile(markdown, getState().session.taskPlan);
    if (result.ok) {
      dispatch(setTaskPlan(result.plan));
      return { title: result.title };
    }
    console.warn(`Plan file to-dos not used: ${result.error}`);
  } catch (e) {
    console.warn("Could not read the plan file", e);
  }
  return {};
}

/**
 * "Build in a loop" on a plan card: seed the loop from the plan's to-dos.
 * `parallel` starts it with parallel waves on (the inbox's switch).
 */
export const startLoopFromPlan = createAsyncThunk<
  void,
  {
    planFile: string;
    parallel?: boolean;
    budget?: PlanBudgetSetup;
    /** The check an item without its own is held to (LoopState.fallbackCheck) */
    fallbackCheck?: string;
  },
  ThunkApiType
>(
  "loop/start",
  async (
    { planFile, parallel, budget, fallbackCheck },
    { dispatch, getState, extra },
  ) => {
    const { title } = await readPlanIntoTaskList(
      planFile,
      dispatch,
      getState,
      (uri) => extra.ideMessenger.ide.readFile(uri),
    );
    const plan = getState().session.taskPlan;
    if (!plan) return;
    let loop = createLoop(plan, {
      ...(title ? { title } : {}),
      now: new Date(),
      sessionTokens: sessionTokens(getState()),
      costMark: sessionCostMark(getState()),
      // Plans and questions follow the levels chosen for them
      policy: selectLoopPolicy(getState()),
      fallbackCheck,
    });
    if (parallel) loop = setLoopParallel(loop, true);
    loop = await autoAnswerPlanDecisions(
      loop,
      planFile,
      extra.ideMessenger.ide,
    );
    // The plan card's budget step; without it the strategy is None
    loop = applyBudgetStep(dispatch, getState, loop, budget);
    dispatch(setMode("agent"));
    commitLoop(dispatch, getState, loop);
  },
);

/**
 * Questions is permissive (Automatic, Permissive, IDGAF): the plan's open
 * decisions are answered from its own options and recorded on the loop as
 * the system's, so nothing waits for the person.
 */
async function autoAnswerPlanDecisions(
  loop: LoopState,
  planFile: string | undefined,
  ide: Pick<IDE, "readFile" | "writeFile">,
): Promise<LoopState> {
  if (
    !planFile ||
    !loop.policy ||
    !questionsAutoAnswer(loop.policy.questions)
  ) {
    return loop;
  }
  const source = `Questions: ${policyLevelLabel("questions", loop.policy.questions)}`;
  try {
    return (await autoAnswerPlanFile(ide, planFile)).reduce(
      (l, a) =>
        addAutoDecision(l, {
          kind: "question",
          source,
          text: autoAnsweredLine(a.question, a.answer),
        }),
      loop,
    );
  } catch (e) {
    console.warn("Could not answer the plan's decisions", e);
    return loop;
  }
}

/** The loop's re-plan card: accept it and start the next round. */
export const acceptLoopPlan = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/acceptPlan",
  async (_, { dispatch, getState, extra }) => {
    const { loop, planFile } = getState().session;
    if (!loop || loop.status !== "awaiting_plan") return;
    if (planFile) {
      await readPlanIntoTaskList(planFile, dispatch, getState, (uri) =>
        extra.ideMessenger.ide.readFile(uri),
      );
    }
    const plan = getState().session.taskPlan;
    if (!plan) return;
    dispatch(setMode("agent"));
    const answered = await autoAnswerPlanDecisions(
      loop,
      planFile,
      extra.ideMessenger.ide,
    );
    commitLoop(
      dispatch,
      getState,
      acceptReplan(answered, plan, {
        now: new Date(),
        sessionTokens: sessionTokens(getState()),
      }),
    );
  },
);

/** Whether the session's loop is going (any status but stopped). */
function loopActive(state: RootState): boolean {
  const { loop } = state.session;
  return !!loop && loop.status !== "stopped";
}

/**
 * Loop in the mode picker. It is not a mode: the first message is a Plan
 * turn, and the plan it presents starts the loop (presentPlanImpl). A loop
 * already going keeps the mode it runs in.
 */
export const chooseLoopMode = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/chooseMode",
  async (_, { dispatch, getState }) => {
    dispatch(setModeAfterLoop(undefined));
    dispatch(setLoopRequested(true));
    const state = getState();
    // A loop paused by leaving Loop and still holding open items goes on at
    // once when Plan edits would start a plan by itself (Permissive and
    // IDGAF); otherwise the inbox offers Resume and Start fresh
    if (
      isLoopPaused(state.session.loop) &&
      openLoopItems(state.session.loop!) > 0 &&
      planHandoff({
        policy: selectPolicySettings(state),
        first: true,
        added: 0,
      }).decision === "go"
    ) {
      await dispatch(resumeLoopThunk());
    }
    if (!loopActive(getState())) dispatch(setMode("plan"));
  },
);

/**
 * Chat, Plan or Agent picked while in Loop: a running loop is paused after
 * the running item (pauseLoop: its items, plan file, budgets and usage stay),
 * and the mode is taken when it pauses (setLoop), so the item finishes in
 * its own mode. Otherwise the mode is taken at once. Choosing Loop again
 * resumes it (chooseLoopMode, resumeLoopThunk).
 */
export const leaveLoopMode = createAsyncThunk<void, MessageModes, ThunkApiType>(
  "loop/leaveMode",
  async (mode, { dispatch, getState }) => {
    dispatch(setLoopRequested(false));
    if (loopActive(getState())) {
      dispatch(setModeAfterLoop(mode));
      await dispatch(pauseLoopThunk());
      return;
    }
    dispatch(setModeAfterLoop(undefined));
    dispatch(setMode(mode));
  },
);

/**
 * A plan presented while the person is in Loop is the first plan of the run,
 * and Plan edits decides whether it goes on by itself: Automatic, Permissive
 * and IDGAF start the loop (no reviewer for plans exists yet, so Automatic
 * works as Permissive, its cap on new to-dos included), and Manual and
 * Cautious leave the plan card for the person (Build or Build in a loop). A
 * loop already going is left alone: its own re-plan is accepted as before.
 */
export const startLoopIfRequested = createAsyncThunk<
  boolean,
  { planFile: string },
  ThunkApiType
>("loop/startIfRequested", async ({ planFile }, { dispatch, getState }) => {
  const state = getState();
  if (!state.session.loopRequested || loopActive(state)) return false;
  const handoff = planHandoff({
    policy: selectPolicySettings(state),
    first: true,
    added: state.session.taskPlan?.items.length ?? 0,
  });
  if (handoff.decision !== "go") return false;
  await dispatch(startLoopFromPlan({ planFile }));
  return loopActive(getState());
});

/** Leaving Loop: stop after the running item, as a pause that can resume. */
export const pauseLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/pause",
  async (_, { dispatch, getState }) => {
    const { loop } = getState().session;
    if (!loop || loop.status === "stopped") return;
    if (loop.parallel?.length) {
      abortLoopWorkers();
      commitLoop(
        dispatch,
        getState,
        stopLoop(loop, "left_loop", LEFT_LOOP_DETAIL),
      );
      return;
    }
    commitLoop(dispatch, getState, pauseLoop(loop));
  },
);

export const stopLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/stop",
  async (_, { dispatch, getState }) => {
    const { loop } = getState().session;
    if (!loop || loop.status === "stopped") return;
    // A wave's workers are ended now: their items go back to pending
    // (stopLoop), and their worktrees go when each worker settles
    if (loop.parallel?.length) {
      abortLoopWorkers();
      commitLoop(dispatch, getState, interruptLoop(loop));
      return;
    }
    commitLoop(dispatch, getState, requestStop(loop));
  },
);

/** The inbox's switch: run items with disjoint files at the same time. */
export const setLoopParallelThunk = createAsyncThunk<
  void,
  boolean,
  ThunkApiType
>("loop/setParallel", async (on, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (!loop) return;
  commitLoop(dispatch, getState, setLoopParallel(loop, on));
});

export const resumeLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/resume",
  async (_, { dispatch, getState }) => {
    const { loop } = getState().session;
    if (!loop || loop.status !== "stopped") return;
    commitLoop(
      dispatch,
      getState,
      resumeLoop(
        loop,
        {
          now: new Date(),
          sessionTokens: sessionTokens(getState()),
          costMark: sessionCostMark(getState()),
        },
        // Paused by leaving Loop: the person may have changed files since
        { workedOutside: loop.stopReason === "left_loop" },
      ),
    );
  },
);

/** "Start fresh" on a paused loop: drop it; the next message plans again. */
export const startFreshThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/startFresh",
  async (_, { dispatch, getState }) => {
    if (!isLoopPaused(getState().session.loop)) return;
    dispatch(setLoop(undefined));
    dispatch(setLoopRequested(true));
    dispatch(setMode("plan"));
  },
);

/**
 * Brings the running loop's Plan edits and Questions levels up to date with
 * the levels the person has set, so changing them in the toolbar takes effect
 * on the loop at once.
 */
export const syncLoopPolicy = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/syncPolicy",
  async (_, { dispatch, getState }) => {
    const { loop } = getState().session;
    if (!loop) return;
    const policy = selectLoopPolicy(getState());
    if (JSON.stringify(loop.policy) === JSON.stringify(policy)) return;
    commitLoop(dispatch, getState, setLoopPolicy(loop, policy));
  },
);

type LoopControlOutcome = { ok: boolean; error?: string };

/** Applies one of core's controls to the session's loop. */
function control(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  apply: (loop: LoopState) => LoopControlResult,
): LoopControlOutcome {
  const { loop } = getState().session;
  if (!loop) return { ok: false, error: "No loop is running" };
  const result = apply(loop);
  if (!result.ok) return result;
  commitLoop(dispatch, getState, result.loop);
  return { ok: true };
}

/** Skip an item that is not running: it counts as finished, shown cancelled. */
export const skipLoopItemThunk = createAsyncThunk<
  LoopControlOutcome,
  string,
  ThunkApiType
>("loop/skipItem", async (itemId, { dispatch, getState }) =>
  control(dispatch, getState, (loop) => skipItem(loop, itemId)),
);

/** Run a done, failed or skipped item again. */
export const runLoopItemAgainThunk = createAsyncThunk<
  LoopControlOutcome,
  string,
  ThunkApiType
>("loop/runItemAgain", async (itemId, { dispatch, getState }) =>
  control(dispatch, getState, (loop) => runItemAgain(loop, itemId)),
);

/** The inbox's limits editor and re-plan picker: core checks the bounds. */
export const setLoopBudgetThunk = createAsyncThunk<
  LoopControlOutcome,
  Partial<LoopBudget>,
  ThunkApiType
>("loop/setBudget", async (budget, { dispatch, getState }) =>
  control(dispatch, getState, (loop) => setLoopBudget(loop, budget)),
);

/** The inbox's strategy picker: how the running loop moves through the plan. */
export const setLoopStrategyThunk = createAsyncThunk<
  void,
  LoopStrategy,
  ThunkApiType
>("loop/setStrategy", async (strategy, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (!loop) return;
  commitLoop(dispatch, getState, setLoopStrategy(loop, strategy));
});

export const endLoopThunk = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/end",
  async (_, { dispatch }) => {
    dispatch(setLoop(undefined));
  },
);

export interface LoopAnswerInput {
  questionId?: string;
  itemId?: string;
  text: string;
  confirm?: boolean;
  approve?: boolean;
  replanNow?: boolean;
  standing?: boolean;
}

/**
 * The person answered from the inbox. Core routes it by the item's state; an
 * answer for the running item is queued as a steered message, so it reaches
 * the model at its next tool boundary without stopping the turn.
 */
export const answerLoopQuestion = createAsyncThunk<
  { ok: boolean; error?: string },
  LoopAnswerInput,
  ThunkApiType
>("loop/answer", async (input, { dispatch, getState }) => {
  const { loop } = getState().session;
  if (!loop) return { ok: false, error: "No loop is running" };
  const result = answerLoop(loop, input, new Date());
  if (!result.ok) return result;
  const { answer } = result;
  commitLoop(dispatch, getState, result.loop);
  if (answer.route === "steer") {
    const question = result.loop.questions.find(
      (q) => q.id === answer.questionId,
    );
    const text = question
      ? `The person answered your question ${question.id} ("${question.question}"): ${answer.text}`
      : `A note from the person about this item: ${answer.text}`;
    dispatch(
      enqueueMessage({
        editorState: doc(text),
        modifiers: { noContext: true, useCodebase: false },
        steer: true,
        loopAnswerId: answer.id,
      }),
    );
  }
  return { ok: true };
});

/** The finish_item and present_plan calls made since a run started. */
function callsSince(state: RootState, historyIndex: number, name: string) {
  return state.session.history
    .slice(historyIndex)
    .flatMap((item) => item.toolCallStates ?? [])
    .filter((tc) => tc.toolCall.function.name === name);
}

/**
 * The model an item's run goes to. The to-do's own model (TaskItem.model)
 * wins over modeModels.loop; one that is not configured falls back to it,
 * noted on the run. Without a loop entry the loop model is the selected one,
 * or the one a previous item's own model switched away from.
 */
function chooseItemModel(state: RootState, loop: LoopState, item: TaskItem) {
  const chatModels = state.config.config.modelsByRole.chat;
  const configured = chatModels.find(
    (m) =>
      m.title ===
      getModeModelTitle(
        state.config.config,
        "loop",
        state.ui.modeModelOverrides,
      ),
  );
  const loopModel =
    configured ??
    chatModels.find((m) => m.title === loop.modelBefore) ??
    state.config.config.selectedModelByRole.chat ??
    undefined;
  return {
    configured,
    loopModel,
    chosen: modelForLoopItem(item, chatModels, loopModel),
  };
}

/**
 * The prompt of a run of `item` starting now, taking the reminders and the
 * answers due to it (the loop returned has them marked). The request carries
 * the plan block (loopPlanBlock), added by the request for an inline run and
 * here for a worker.
 */
async function itemRunPrompt(
  ide: IIdeMessenger["ide"],
  loop: LoopState,
  item: TaskItem,
  planFile: string | undefined,
  now: Date,
  worker?: { worktree: string; files?: string[] },
): Promise<{ prompt: string; loop: LoopState }> {
  const reminderTarget = { kind: "item", itemId: item.id } as const;
  const taken = takeReminders(
    loop,
    reminderTarget,
    await stampLoopFiles(ide, reminderPathsDue(loop, reminderTarget)),
    now,
  );
  loop = taken.loop;
  const itemState = loop.items.find((i) => i.id === item.id);
  const answers = answersToDeliver(loop, item.id);
  const prompt = loopItemPrompt({
    item,
    planFile,
    answers,
    questions: loop.questions,
    redo: itemState?.status === "redo",
    again: itemState?.again,
    attempt: (itemState?.attempts ?? 0) + 1,
    notes: loop.notes,
    standing: standingInstructions(loop),
    freshContext: loop.freshContext !== false,
    // A failed check's output, for the item to fix
    lastCheck: itemState?.check,
    planBlock: true,
    reminders: taken.reminders,
    returning: itemState?.setAside,
    decideAlone: loopDecidesAlone(loop),
    fallbackCheck: loop.fallbackCheck,
    unanswered: loop.questions.filter((q) =>
      itemState?.unanswered?.includes(q.id),
    ),
    worker,
    // Back inline after a refused patch: the prompt says what happened
    mergeFailed: worker ? undefined : itemState?.mergeFailed,
    workedOutside: loop.workedOutside,
  });
  loop = markDelivered(
    loop,
    answers.map((a) => a.id),
  );
  // Said once, on the first item after a resume
  if (loop.workedOutside) loop = { ...loop, workedOutside: undefined };
  return { prompt, loop };
}

/** An item of a wave that cannot run as a worker runs inline instead. */
function runInlineInstead(
  loop: LoopState,
  itemId: string,
  reason: string,
): LoopState {
  return {
    ...loop,
    items: loop.items.map((i) =>
      i.id === itemId
        ? {
            ...i,
            runInline: true,
            summary: reason.slice(0, LOOP_LIMITS.maxSummaryLength),
          }
        : i,
    ),
  };
}

interface StartedWorker {
  itemId: string;
  item: TaskItem;
  worktree: WorktreeInfo;
  startedAt: string;
  model: ModelDescription;
  prompt: string;
}

/** The plan's slug, for the worktree's branch and folder: its file's name. */
function planSlug(planFile: string | undefined): string {
  const base = planFile?.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.md$/i, "") || "plan";
}

/** Workers settle one at a time: each finish reads the loop the last one left. */
let settling: Promise<void> = Promise.resolve();

/**
 * A worker's run ended: its patch goes onto the checkout (or is refused),
 * its worktree goes, and the loop records the run (finishParallelRun) with
 * the reminders it saved. Each worker is finished in the order it ended; the
 * driver takes the next step once the wave is empty.
 */
async function settleWorker(
  dispatch: AppThunkDispatch,
  getState: () => RootState,
  ideMessenger: IIdeMessenger,
  worker: StartedWorker,
  workspace: string,
  /** What was uncommitted in the checkout when the wave started */
  dirtyBefore: string[],
  result: LoopWorkerResult,
): Promise<void> {
  const ide = ideMessenger.ide;
  const ops = loopWorktreeOps();
  const running = () => {
    const loop = getState().session.loop;
    return loop?.parallel?.some(
      (r) => r.itemId === worker.itemId && r.startedAt === worker.startedAt,
    )
      ? loop
      : undefined;
  };

  // A stopped worker's changes are dropped with its worktree: the item goes
  // back to pending and its next run checks what is already done
  let mergeFailed: string | undefined;
  try {
    if (running() && result.status !== "cancelled") {
      const patch = await ops.patch(ideMessenger, worker.worktree);
      if (patch.trim()) {
        // A file the person changed since the wave started is a conflict
        const before = new Set(dirtyBefore);
        const touchedSince = (await ops.dirty(ideMessenger, workspace)).filter(
          (f) => !before.has(f),
        );
        const applied = await ops.apply(
          ideMessenger,
          workspace,
          patch,
          touchedSince,
        );
        if (!applied.ok) mergeFailed = applied.reason;
      }
    }
  } catch (e) {
    mergeFailed = `The worker's changes could not be read or applied: ${
      e instanceof Error ? e.message : String(e)
    }`;
  } finally {
    await ops
      .remove(ideMessenger, workspace, worker.worktree)
      .catch((e) => console.warn("Could not remove a loop worktree", e));
  }

  const finish = async () => {
    const loop = running();
    // The loop was stopped meanwhile (stopLoop emptied the wave)
    if (!loop) return;
    const now = new Date();
    const plan = getState().session.taskPlan;
    const checked = plan?.items.find((t) => t.id === worker.itemId);
    const check = checked ? itemCheck(loop, checked) : undefined;
    let next = finishParallelRun(
      loop,
      worker.itemId,
      {
        report: result.report,
        questions: result.questions,
        mergeFailed,
      },
      now,
      { check },
    );
    if (!mergeFailed) {
      for (const r of result.reminders) {
        const paths = reminderFilePaths(r.files);
        const stamps = await stampLoopFiles(ide, paths);
        const saved = saveReminder(
          next,
          plan,
          {
            fromItemId: worker.itemId,
            note: r.note,
            when: r.when,
            item: r.item,
            files: paths.map((path) => ({ path, stamp: stamps[path] })),
          },
          now,
        );
        if (saved.ok) next = saved.loop;
      }
      if (result.later && result.report?.outcome === "later") {
        const stamps = await stampLoopFiles(ide, result.later.files);
        next = saveLaterReminder(
          next,
          worker.itemId,
          result.later.note,
          result.later.files.map((path) => ({ path, stamp: stamps[path] })),
          now,
        );
      }
      // A run that ended without its report for a reason of its own
      if (!result.report && result.error) {
        next = {
          ...next,
          items: next.items.map((i) =>
            i.id === worker.itemId
              ? {
                  ...i,
                  summary: `The worker ended: ${result.error}`.slice(
                    0,
                    LOOP_LIMITS.maxSummaryLength,
                  ),
                }
              : i,
          ),
        };
      }
    }
    commitLoop(dispatch, getState, next);
  };
  settling = settling.then(finish, finish);
  await settling;
}

/**
 * One step of the loop, run when nothing is streaming: finish what ran, then
 * decide what is next and start it. Resolves when the turn it started ends.
 */
export const advanceLoop = createAsyncThunk<void, undefined, ThunkApiType>(
  "loop/advance",
  async (_, { dispatch, getState, extra }) => {
    const ide = extra.ideMessenger.ide;
    let state = getState();
    let loop = state.session.loop;
    if (!loop || loop.status === "stopped" || loop.status === "awaiting_plan") {
      return;
    }
    const now = new Date();

    // 1. Finish what ran.
    if (loop.current?.kind === "item") {
      // A run that ended without its report is told once to call finish_item,
      // in the same run; only a second such end counts as an attempt
      // (core/util/turnEnd.ts)
      if (!loop.current.report && !loop.current.nudged) {
        commitLoop(dispatch, getState, {
          ...loop,
          current: { ...loop.current, nudged: true },
        });
        await sendLoopTurn(
          dispatch,
          finishItemNudge(BuiltInToolNames.FinishItem),
        );
        return;
      }
      const queuedIds = new Set(
        state.session.queuedMessages
          .map((m) => m.loopAnswerId)
          .filter((id): id is string => !!id),
      );
      // Steered answers still queued did not reach the run
      for (const m of state.session.queuedMessages) {
        if (m.loopAnswerId) dispatch(removeQueuedMessage(m.id));
      }
      const delivered = loop.answers
        .filter((a) => a.route === "steer" && !queuedIds.has(a.id))
        .map((a) => a.id);
      // An item with a check is not done until its check passes
      const itemId = loop.current.itemId;
      const checked = state.session.taskPlan?.items.find(
        (t) => t.id === itemId,
      );
      const check = checked ? itemCheck(loop, checked) : undefined;
      loop = finishItemRun(loop, loop.current.report, {
        check,
        sessionTokens: sessionTokens(state),
        costMark: sessionCostMark(state),
        now: new Date(),
      });
      loop = settleSteeredAnswers(loop, delivered);
      if (itemId) loop = releaseEmptyWait(loop, itemId);
      // An item over its own budget: the limit policy decides what follows
      if (itemId) loop = applyLimitAfterRun(dispatch, getState, loop, itemId);
    } else if (loop.current?.kind === "check") {
      // A check that did not finish (the gui reloaded while it ran): the
      // item stays checking, and its check runs again
      loop = holdCheck(loop);
    } else if (loop.current?.kind === "replan") {
      const presented = callsSince(
        state,
        loop.current.historyIndex,
        BuiltInToolNames.PresentPlan,
      ).some((tc) => tc.status === "done");
      if (!presented) {
        // One nudge first, in the same run: a small model wrote the
        // present_plan call as text once in six runs, and one text reply
        // must not end the whole loop (core/util/turnEnd.ts)
        if (!loop.current.nudged) {
          commitLoop(dispatch, getState, {
            ...loop,
            current: { ...loop.current, nudged: true },
          });
          await sendLoopTurn(
            dispatch,
            presentPlanNudge(BuiltInToolNames.PresentPlan),
          );
          return;
        }
        commitLoop(
          dispatch,
          getState,
          stopLoop(
            loop,
            "replan_failed",
            "The re-plan ended without presenting a plan.",
          ),
        );
        return;
      }
      // The loop's autonomy level (and, for a repair, its scope) says which
      // re-plans start by themselves; anything else waits on the plan card.
      const ended = endReplan(loop, getState().session.taskPlan);
      commitLoop(dispatch, getState, ended.loop);
      if (ended.accept) {
        await dispatch(acceptLoopPlan());
      }
      return;
    }

    // 2. Decide what is next.
    state = getState();
    const plan = state.session.taskPlan;
    if (!plan) {
      commitLoop(
        dispatch,
        getState,
        stopLoop(loop, "done", "The task list is empty."),
      );
      return;
    }
    loop = reconcileLoop(loop, plan);
    const action = decideNext(loop, plan, {
      now,
      sessionTokens: sessionTokens(state),
    });
    // A wave runs: its workers finish by themselves (settleWorker), and no
    // item starts meanwhile; a finished worker's check may run (in the
    // checkout, which has its patch). Nothing is committed, or the driver
    // would see a change and look again at once.
    if (action.kind === "none" && loop.parallel?.length) return;
    const planFile = await displayPath(state.session.planFile, () =>
      ide.getWorkspaceDirs(),
    );

    switch (action.kind) {
      case "none":
        commitLoop(dispatch, getState, loop);
        return;
      case "wait":
        // useLoopDriver wakes the loop at action.until (unattended)
        commitLoop(dispatch, getState, enterWait(loop, now));
        return;
      case "proceed":
        // Unattended and nobody answered in time: the items go on
        commitLoop(dispatch, getState, proceedUnanswered(loop));
        return;
      case "stop":
        commitLoop(
          dispatch,
          getState,
          stopLoop(loop, action.reason, action.detail),
        );
        return;
      case "run": {
        const item = plan.items.find((i) => i.id === action.itemId)!;
        const built = await itemRunPrompt(ide, loop, item, planFile, now);
        loop = built.loop;
        const { configured, loopModel, chosen } = chooseItemModel(
          state,
          loop,
          item,
        );
        loop = startItemRun(
          loop,
          action.itemId,
          state.session.history.length,
          now,
          {
            model: chosen.record,
            sessionTokens: sessionTokens(getState()),
            costMark: sessionCostMark(getState()),
          },
        );
        // An own model leaves the loop model; the next turn comes back to it
        const leaves =
          !configured &&
          !!item.model &&
          !!chosen.model &&
          chosen.model.title !== loopModel?.title;
        loop = { ...loop, modelBefore: leaves ? loopModel?.title : undefined };
        dispatch(setMode("agent"));
        commitLoop(dispatch, getState, loop);
        await sendLoopTurn(dispatch, built.prompt, "loop", chosen.model?.title);
        return;
      }
      case "run_parallel": {
        // A wave: each item as a worker in its own worktree, merged back one
        // at a time as they finish (settleWorker). An item that cannot get a
        // worktree runs inline at the next step instead.
        const workspace = workspacePath((await ide.getWorkspaceDirs())[0]);
        if (!workspace) {
          for (const itemId of action.itemIds) {
            loop = runInlineInstead(
              loop,
              itemId,
              "No local workspace folder for a worktree; runs inline.",
            );
          }
          commitLoop(dispatch, getState, loop);
          return;
        }
        const ops = loopWorktreeOps();
        const slug = planSlug(state.session.planFile);
        let dirtyBefore: string[] = [];
        try {
          dirtyBefore = await ops.dirty(extra.ideMessenger, workspace);
        } catch {
          // Unknown: every file the person has uncommitted counts as touched
        }
        const workers: StartedWorker[] = [];
        for (const itemId of action.itemIds) {
          const item = plan.items.find((i) => i.id === itemId)!;
          const { chosen } = chooseItemModel(state, loop, item);
          if (!chosen.model) {
            loop = runInlineInstead(loop, itemId, "No chat model selected.");
            continue;
          }
          let worktree: WorktreeInfo;
          try {
            worktree = await ops.create(
              extra.ideMessenger,
              workspace,
              slug,
              itemId,
            );
          } catch (e) {
            loop = runInlineInstead(
              loop,
              itemId,
              `Could not make a worktree: ${e instanceof Error ? e.message : String(e)}`,
            );
            continue;
          }
          loop = startParallelRun(loop, itemId, now, {
            worktree: worktree.path,
            model: chosen.record ?? { title: chosen.model.title },
          });
          const run = loop.parallel!.find((r) => r.itemId === itemId)!;
          workers.push({
            itemId,
            item,
            worktree,
            startedAt: run.startedAt,
            model: chosen.model,
            prompt: "",
          });
        }
        commitLoop(dispatch, getState, loop);
        // Every worker's plan block shows the whole wave running
        for (const worker of workers) {
          const built = await itemRunPrompt(
            ide,
            loop,
            worker.item,
            planFile,
            now,
            { worktree: worker.worktree.path, files: worker.item.files },
          );
          loop = built.loop;
          worker.prompt = withLoopPlanBlock(
            built.prompt,
            loopPlanBlock({ loop, plan, itemId: worker.itemId }),
          ) as string;
        }
        commitLoop(dispatch, getState, loop);
        const maxItemTurns = loop.budget.maxItemTurns;
        for (const worker of workers) {
          void runLoopItemSubagent(
            {
              itemId: worker.itemId,
              prompt: worker.prompt,
              worktree: worker.worktree.path,
              files: worker.item.files,
              model: worker.model,
              maxItemTurns,
            },
            { dispatch, getState, ideMessenger: extra.ideMessenger },
          ).then(
            (result) =>
              settleWorker(
                dispatch,
                getState,
                extra.ideMessenger,
                worker,
                workspace,
                dirtyBefore,
                result,
              ),
            (e) => console.warn("A loop worker could not be run", e),
          );
        }
        return;
      }
      case "check":
        // The harness runs the item's check; no model turn
        commitLoop(dispatch, getState, loop);
        await runLoopCheck(dispatch, getState, extra.ideMessenger, action, now);
        return;
      case "replan": {
        let planTitle: string | undefined;
        if (state.session.planFile) {
          try {
            planTitle = parsePlanFile(
              await ide.readFile(state.session.planFile),
            ).title;
          } catch {
            // the prompt goes without a title
          }
        }
        // A round's re-plan, a check-in, or a repair of one failed item
        const replanTarget = replanReminderTarget(action);
        const taken = takeReminders(
          loop,
          replanTarget,
          await stampLoopFiles(ide, reminderPathsDue(loop, replanTarget)),
          now,
        );
        loop = taken.loop;
        const prompt = loopReplanTurnPrompt(action, {
          loop,
          plan,
          planFile,
          planTitle,
          reminders: taken.reminders,
        });
        loop = startReplan(loop, state.session.history.length, now, {
          plan,
          checkIn: action.checkIn,
          itemId: action.itemId,
        });
        // Without a re-plan entry, come back from an item's own model
        const back = getModeModelTitle(
          state.config.config,
          "replan",
          state.ui.modeModelOverrides,
        )
          ? undefined
          : loop.modelBefore;
        if (back) loop = { ...loop, modelBefore: undefined };
        dispatch(setMode("plan"));
        commitLoop(dispatch, getState, loop);
        await sendLoopTurn(dispatch, prompt, "replan", back);
        return;
      }
    }
  },
);
