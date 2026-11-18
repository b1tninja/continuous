import type {
  ContextItem,
  ModelDescription,
  SubagentRunState,
  ToolCallState,
} from "core";
import type { SubagentRunStatus } from "core/subagents/result";
import { resolveSubagentTools } from "core/subagents/tools";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import {
  LOOP_WORKER_MODE,
  loopWorkerAuditAgent,
} from "core/tools/permissions/audit/identity";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ideToolRef } from "core/tools/roleToolRefs";
import { filterToolsForRole } from "core/tools/roleTools";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import {
  DEFAULT_LOOP_BUDGET,
  finishItemReport,
  finishItemResult,
  FinishOutcome,
  itemTurnLimitReport,
  LOOP_ITEM_TURN_GRACE,
  LOOP_LIMITS,
} from "core/util/loopMode";
import { selectActiveTools } from "../../redux/selectors/selectActiveTools";
import type { ClientToolExtras } from "../clientTools/callClientTool";
import { localPathUri } from "../loopWorktrees";
import { registerLoopWorker, WORKERS_STOPPED_WITH_LOOP } from "./loopWorkers";
import {
  acquireSubagentSlots,
  driveSubagent,
  HandledCall,
  newLocalSession,
  prepareSubagentRequests,
} from "./runSubagent";

/**
 * A worker of a Loop parallel wave (plans/loop-mode.md, L4 P4): one item of
 * the plan run as a subagent in its own worktree, beside the other items of
 * the wave. It reuses the subagent runner's request loop without a parent
 * tool call: its own conversation, its own abort controller (the loop's Stop
 * and the row's Stop abort it), the item prompt with its plan block as the
 * first message. The three loop tools are answered here, bound to this item:
 * finish_item ends the run; hold_question and remind_me are collected and
 * reach the loop with the result, which advanceLoop hands to
 * finishParallelRun once the worker's patch is merged.
 */

export interface LoopWorkerInput {
  itemId: string;
  /** The item prompt, with its plan block (loopItemPrompt + loopPlanBlock) */
  prompt: string;
  /** The worktree's local path */
  worktree: string;
  /** The files the item declared (TaskItem.files) */
  files?: string[];
  model: ModelDescription;
  /** The loop's request limit per item (LoopBudget.maxItemTurns) */
  maxItemTurns?: number;
  /** Live state for the inbox row */
  onUpdate?: (patch: Partial<SubagentRunState>) => void;
}

export interface LoopWorkerResult {
  status: SubagentRunStatus;
  error?: string;
  /** What finish_item said; a run ended at its turn limit reports stuck */
  report?: { outcome: FinishOutcome; summary?: string; notes?: string };
  /** Outcome "later": the note for the item's return, and its files */
  later?: { note: string; files: string[] };
  /** hold_question calls, in order, for finishParallelRun */
  questions: {
    question: unknown;
    kind: unknown;
    assumption?: unknown;
    type?: unknown;
  }[];
  /** remind_me calls, in order, saved by the loop when the run is finished */
  reminders: {
    note: unknown;
    when: unknown;
    item?: unknown;
    files?: unknown;
  }[];
  /** The notes the report left (finish_item notes) */
  notes: string[];
  usage?: SubagentRunState["usage"];
  /** Everything the worker wrote, for the inbox */
  text: string;
}

/**
 * The worker's system prompt: what it is and how it reports. The same text
 * for every worker of a wave, so their requests share one cached prefix
 * (the prefix gate keys on it): the worktree and the item's files are in
 * the item prompt (loopItemPrompt's worker lines), not here.
 */
export function buildLoopWorkerSystemMessage(input: {
  toolNames: string[];
}): string {
  const has = (name: string) => input.toolNames.includes(name);
  const edits: string[] = [
    BuiltInToolNames.SingleFindAndReplace,
    BuiltInToolNames.MultiEdit,
    BuiltInToolNames.CreateNewFile,
  ].filter(has);
  return [
    "You are a worker of a Loop plan: you run one item of the plan in your own copy of the repository while other items run in theirs. The harness reads your report and merges your changes; the person sees neither your tool calls nor their output.",
    "Your copy's folder is named in the task. Work there and only there: relative paths and commands resolve in it, and you may change only the files the task declares.",
    edits.length
      ? `To edit, use ${edits.join(" or ")}: exact text replacements, applied at once.`
      : undefined,
    `Nobody answers during this run. ${BuiltInToolNames.HoldQuestion} records a question for the person: with an assumption, go on; a blocking one is answered only after this run, so do what you can and then report the item as waiting. ${BuiltInToolNames.RemindMe} saves a note for a later run.`,
    `When you are done, call ${BuiltInToolNames.FinishItem}; that ends the run. Do not commit, push, or edit the plan file: the harness merges your changes.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function item(name: string, description: string, content: string): ContextItem {
  return { name, description, content, hidden: false };
}

/** The tools a worker runs with: Agent mode's, with the loop tools, as a subagent. */
export function loopWorkerTools(
  state: ReturnType<ClientToolExtras["getState"]>,
  model: ModelDescription,
) {
  // Agent mode's active tools with the loop's three, whether or not an
  // inline item is running in the session
  let parentTools = selectActiveTools.resultFunc(
    LOOP_WORKER_MODE,
    state.config.config.tools,
    state.ui.toolSettings,
    state.ui.toolGroupSettings,
    true,
    false,
    state.ui.policyExtras.planMcpTools,
    state.ui.policyExtras.trustedMcpServers,
    state.ui.policyExtras.backgroundMcpTools,
    state.ui.policyLevels.tools === "idgaf",
  );
  // Nobody watches a worker: it gets only the MCP tools the person listed
  // for unattended runs (`background.mcpTools`, TR1 and TR25)
  parentTools = filterToolsForRole("background", parentTools, ideToolRef, {
    unattendedMcpTools: state.ui.policyExtras.backgroundMcpTools,
    approvalWaived: state.ui.policyLevels.tools === "idgaf",
  });
  if (model.toolOverrides?.length) {
    parentTools = applyToolOverrides(parentTools, model.toolOverrides).tools;
  }
  return resolveSubagentTools({}, parentTools, { loopItem: true }).tools;
}

export async function runLoopItemSubagent(
  input: LoopWorkerInput,
  { dispatch, getState, ideMessenger }: ClientToolExtras,
  /** Aborted when the loop stops; the worker's own controller follows it */
  loopSignal?: AbortSignal,
): Promise<LoopWorkerResult> {
  const controller = new AbortController();
  const onLoopAbort = () =>
    controller.abort(new Error(WORKERS_STOPPED_WITH_LOOP));
  if (loopSignal?.aborted) onLoopAbort();
  else loopSignal?.addEventListener("abort", onLoopAbort, { once: true });
  const unregister = registerLoopWorker(input.itemId, controller);
  const signal = controller.signal;

  const questions: LoopWorkerResult["questions"] = [];
  const reminders: LoopWorkerResult["reminders"] = [];
  let report: LoopWorkerResult["report"];
  let later: LoopWorkerResult["later"];
  let text = "";
  let usage: SubagentRunState["usage"];
  const update = (patch: Partial<SubagentRunState>) => {
    if (patch.text !== undefined) text = patch.text;
    if (patch.usage) usage = patch.usage;
    input.onUpdate?.(patch);
  };

  /** The loop tools, bound to this item; anything else goes to core. */
  const handleCall = async (
    call: ToolCallState,
  ): Promise<HandledCall | undefined> => {
    const name = call.toolCall.function.name;
    const args = (call.parsedArgs ?? {}) as Record<string, unknown>;
    switch (name) {
      case BuiltInToolNames.FinishItem: {
        const parsed = finishItemReport(args);
        if (!parsed.ok) {
          throw new ContinueError(
            ContinueErrorReason.Unspecified,
            parsed.error,
          );
        }
        report = parsed.report;
        later = parsed.later;
        return {
          output: [
            item(
              "Item reported",
              parsed.report.outcome,
              `${finishItemResult(parsed.report.outcome)} This run ends here; the harness merges your changes.`,
            ),
          ],
          endRun: true,
        };
      }
      case BuiltInToolNames.HoldQuestion: {
        const question =
          typeof args.question === "string" ? args.question.trim() : "";
        const kind = args.kind;
        if (!question || (kind !== "blocking" && kind !== "assumption")) {
          throw new ContinueError(
            ContinueErrorReason.Unspecified,
            'hold_question needs a question and a kind of "blocking" or "assumption".',
          );
        }
        if (question.length > LOOP_LIMITS.maxQuestionLength) {
          throw new ContinueError(
            ContinueErrorReason.Unspecified,
            `The question is ${question.length} characters, over the limit of ${LOOP_LIMITS.maxQuestionLength}.`,
          );
        }
        questions.push({
          question,
          kind,
          assumption: args.assumption,
          type: args.type,
        });
        return {
          output: [
            item(
              "Question held",
              kind,
              kind === "assumption"
                ? "Noted; it reaches the person's inbox when this run ends. Keep working on your assumption; if they overrule it, the item will be redone."
                : `Noted; nobody can answer during this run. Do what you can without the answer, then call ${BuiltInToolNames.FinishItem} with outcome "waiting"; the item will run again once they answer.`,
            ),
          ],
        };
      }
      case BuiltInToolNames.RemindMe: {
        const note = typeof args.note === "string" ? args.note.trim() : "";
        if (!note) {
          throw new ContinueError(
            ContinueErrorReason.Unspecified,
            "remind_me needs a note.",
          );
        }
        reminders.push({
          note,
          when: args.when,
          item: args.item,
          files: args.files,
        });
        return {
          output: [
            item(
              "Reminder noted",
              String(args.when ?? ""),
              "Noted; the reminder is saved when this run ends.",
            ),
          ],
        };
      }
      default:
        return undefined;
    }
  };

  let release: (() => void) | undefined;
  let status: SubagentRunStatus = "queued";
  let error: string | undefined;
  try {
    const state = getState();
    const tools = loopWorkerTools(state, input.model);
    const prepared = prepareSubagentRequests(
      state,
      input.model,
      tools,
      buildLoopWorkerSystemMessage({
        toolNames: tools.map((t) => t.function.name),
      }),
    );
    update({ model: input.model.title });
    release = await acquireSubagentSlots(ideMessenger, input.model, signal);
    update({ status: "running", startedAt: Date.now() });
    const maxTurns =
      (input.maxItemTurns ?? DEFAULT_LOOP_BUDGET.maxItemTurns) +
      LOOP_ITEM_TURN_GRACE;
    const outcome = await driveSubagent({
      ideMessenger,
      dispatch,
      getState,
      controller,
      local: newLocalSession(
        input.prompt,
        state.session.environment?.strings?.firstMessageBlock,
      ),
      model: input.model,
      tools,
      ...prepared,
      maxTurns,
      onUpdate: update,
      approvalScope: `loop-item-${input.itemId}`,
      approvals: "refuse",
      handleCall,
      workspaceDirs: [localPathUri(input.worktree)],
      audit: {
        sessionId: getState().session.id,
        agent: loopWorkerAuditAgent(getState().session.id, input.itemId),
      },
    });
    status = outcome.status;
    error = outcome.error;
    usage = outcome.usage ?? usage;
    // Past the turn limit without a report: the run is ended as stuck, as
    // an inline run is
    if (status === "partial" && !report) report = itemTurnLimitReport(maxTurns);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    status = signal.aborted ? "cancelled" : "failed";
  } finally {
    release?.();
    unregister();
    loopSignal?.removeEventListener("abort", onLoopAbort);
  }
  update({ status, error, endedAt: Date.now() });
  return {
    status,
    error,
    report,
    later,
    questions,
    reminders,
    notes: report?.notes ? [report.notes] : [],
    usage,
    text,
  };
}
