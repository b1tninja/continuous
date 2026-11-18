import type {
  ChatHistoryItem,
  LoopItemState,
  LoopQuestion,
  LoopState,
  TaskItem,
  TaskPlan,
} from "core";
import { maskCommandForDisplay } from "core/tools/permissions/displayMask";
import { LOOP_MAX_REPAIRS_PER_ITEM, type ReplanDiff } from "core/util/loopMode";
import { formatDuration } from "core/util/loopUsage";
import { toolDetail, toolLabel } from "../a11y/toolCallAnnouncement";

/**
 * The plan tree's rows, derived from the loop's state and the task plan. Pure:
 * no React, no clock (the caller passes `now`), so the folds, the current
 * item and the auto-expand rules are tested without a DOM.
 *
 * This is an item-level status mapping of its own until the shared
 * loopVisualState module lands; the words and the order of the states are
 * the ones the design names (done, running, waiting for you, failed,
 * replaced, skipped, to do).
 */

export type TreeStatus =
  | "done"
  | "running"
  | "waiting"
  | "failed"
  | "pending"
  | "replaced"
  | "skipped"
  | "dropped";

/** The word a screen reader hears before the item, so state is never colour alone */
export const TREE_STATUS_WORD: Record<TreeStatus, string> = {
  done: "done",
  running: "running",
  waiting: "waiting for you",
  failed: "failed",
  pending: "to do",
  replaced: "replaced",
  skipped: "skipped",
  dropped: "dropped",
};

/** What the loop decided for the person under their policy (LoopState.autoDecisions) */
export interface TreeAutoDecision {
  kind: "plan" | "question";
  source?: string;
  text: string;
  at?: string;
}

/** The optional state that tells which round added a to-do and what replaced one */
export interface TreeExtras {
  /** The round a to-do came in with, by item id (items of round 1 have none) */
  addedInRound?: Record<string, number>;
  /** Replaced to-dos, by item id: the id of the item that took their place */
  replacedBy?: Record<string, string>;
}

export interface TreeLine {
  type: "line";
  id: string;
  /** What kind of line, for its style */
  tone: "live" | "tool" | "check" | "repair" | "wait" | "answer";
  label?: string;
  text: string;
}

export interface TreeItem {
  type: "item";
  /** Stable key: the task item's id, or `dropped:<index>` for a dropped to-do */
  id: string;
  /** Position in the plan, 1-based; undefined for a dropped to-do */
  number?: number;
  text: string;
  status: TreeStatus;
  /** The item the loop works on now (or waits on) */
  current: boolean;
  /** A waiting re-plan adds it (shown with the new chip) */
  isNew: boolean;
  /** The round that added it, for the R chip (round 2 and later) */
  round?: number;
  /** For a replaced item: the item that took its place */
  replacedById?: string;
  replacedByNumber?: number;
  /** Detail lines under the item, shown when it is open */
  lines: TreeLine[];
  /** Opens by default: the current item and a failed one */
  openByDefault: boolean;
}

export interface TreeFold {
  type: "fold";
  id: "done" | "upcoming" | "kept";
  label: string;
  status: TreeStatus;
  children: TreeItem[];
}

export interface TreeTrace {
  type: "trace";
  id: string;
  text: string;
}

export type TreeNode = TreeItem | TreeFold | TreeTrace;

export interface PlanTreeModel {
  /** "now item 3 · 2/12 done" */
  rootLabel: string;
  rootStatus: TreeStatus | "idle";
  /** Open the root without being asked: a plan waits, or an item failed */
  autoExpand: boolean;
  /** "Round 2 · 11 kept, 1 added, 1 dropped" */
  summary: string;
  nodes: TreeNode[];
  done: number;
  total: number;
  /** The id of the current item, if any */
  currentId?: string;
}

/** Upcoming to-dos shown one per line before the rest fold into "N more to do" */
export const UPCOMING_SHOWN = 4;

function itemOf(loop: LoopState, id: string): LoopItemState | undefined {
  return loop.items.find((i) => i.id === id);
}

/** The ids the loop works on: the running item, its check, a repair's item, a wave */
function workingIds(loop: LoopState): string[] {
  const ids: string[] = [];
  if (loop.current?.itemId) ids.push(loop.current.itemId);
  for (const run of loop.parallel ?? []) ids.push(run.itemId);
  return ids;
}

function openQuestions(loop: LoopState, itemId: string): LoopQuestion[] {
  return loop.questions.filter(
    (q) => q.itemId === itemId && !q.decidedAlone && !q.answerId,
  );
}

/** The item's status in the tree's language */
export function treeStatusOf(
  state: LoopItemState | undefined,
  opts: { replaced?: boolean } = {},
): TreeStatus {
  if (!state) return "pending";
  if (opts.replaced) return "replaced";
  if (state.skipped) return "skipped";
  switch (state.status) {
    case "done":
      return "done";
    case "running":
    case "checking":
      return "running";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      // pending and redo
      return "pending";
  }
}

/** The steps of the running item so far and its last tool call, from the session history */
export function runProgress(
  history: ChatHistoryItem[],
  fromIndex: number,
): { steps: number; lastTool?: string } {
  let steps = 0;
  let lastTool: string | undefined;
  for (let i = Math.max(0, fromIndex); i < history.length; i++) {
    const calls = history[i].toolCallStates;
    if (history[i].message.role !== "assistant" || !calls?.length) continue;
    steps++;
    const last = calls[calls.length - 1];
    const detail = toolDetail(last);
    lastTool = detail ? `${toolLabel(last)} ${detail}` : toolLabel(last);
  }
  return { steps, lastTool };
}

function lastLine(output: string | undefined): string | undefined {
  const lines = (output ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function autoDecisionsOf(loop: LoopState): TreeAutoDecision[] {
  const raw = (loop as { autoDecisions?: TreeAutoDecision[] }).autoDecisions;
  return Array.isArray(raw) ? raw : [];
}

function itemLines(
  task: TaskItem,
  state: LoopItemState | undefined,
  ctx: {
    loop: LoopState;
    history: ChatHistoryItem[];
    now?: number;
    isCurrent: boolean;
    status: TreeStatus;
    answers: TreeAutoDecision[];
  },
): TreeLine[] {
  const { loop, status } = ctx;
  const lines: TreeLine[] = [];
  const add = (tone: TreeLine["tone"], text: string, label?: string) => {
    lines.push({
      type: "line",
      id: `${task.id}:${lines.length}`,
      tone,
      text,
      ...(label ? { label } : {}),
    });
  };
  const run = loop.current;
  if (ctx.isCurrent && run?.itemId === task.id && run.kind !== "replan") {
    const since = Date.parse(run.startedAt);
    const bits: string[] = [];
    if (ctx.now !== undefined && Number.isFinite(since)) {
      bits.push(formatDuration(Math.max(0, ctx.now - since)));
    }
    const progress = runProgress(ctx.history, run.historyIndex);
    if (progress.steps > 0) {
      const turns = task.budget?.turns;
      bits.push(
        turns
          ? `step ${progress.steps} of about ${turns}`
          : `step ${progress.steps}`,
      );
    }
    add(
      "live",
      bits.join(" · "),
      run.kind === "check" ? "Checking" : "Running",
    );
    if (progress.lastTool) {
      add(
        "tool",
        clip(maskCommandForDisplay(progress.lastTool), 160),
        "Last tool",
      );
    }
  }
  if (state?.check?.status === "failed" || state?.check?.status === "refused") {
    const c = state.check;
    const out = lastLine(c.output);
    const what = clip(maskCommandForDisplay(c.command), 80);
    const tail = out
      ? `: ${clip(maskCommandForDisplay(out), 100)}`
      : c.exitCode != null
        ? ` (exit ${c.exitCode})`
        : "";
    add(
      "check",
      `${what}${tail}${state.attempts > 1 ? ` (attempt ${state.attempts})` : ""}`,
      c.status === "refused" ? "Check refused" : "Check failed",
    );
  }
  if (state?.overBudget) {
    const b = state.overBudget;
    add("check", `${b.which} ${b.used} of ${b.limit}`, "Over its budget");
  }
  if (run?.kind === "replan" && run.itemId === task.id) {
    const n = Math.min((state?.repairs ?? 0) + 1, LOOP_MAX_REPAIRS_PER_ITEM);
    add(
      "repair",
      `repair re-plan running, ${n} of ${LOOP_MAX_REPAIRS_PER_ITEM} allowed`,
      "Fix forward",
    );
  } else if (state?.repairs && status !== "done") {
    add(
      "repair",
      `${state.repairs} of ${LOOP_MAX_REPAIRS_PER_ITEM} used`,
      "Fix forward",
    );
  }
  if (status === "waiting") {
    const asked = loop.questions.filter((q) => !q.decidedAlone);
    const open = openQuestions(loop, task.id);
    if (open.length > 0) {
      add(
        "wait",
        `question ${asked.indexOf(open[0]) + 1} of ${asked.length}${open.length > 1 ? `, ${open.length} for this item` : ""}`,
        "Waits on",
      );
    } else if (state?.blocker) {
      add("wait", state.blocker, "Waits on");
    } else {
      add("wait", "you", "Waits on");
    }
  }
  if (ctx.isCurrent) {
    for (const d of ctx.answers) {
      add("answer", clip(maskCommandForDisplay(d.text), 200));
    }
  }
  return lines;
}

/** "Round 2 · 11 kept, 1 added, 1 dropped" */
export function treeSummary(loop: LoopState, diff?: ReplanDiff): string {
  const bits = [`Round ${loop.round}`];
  if (diff) {
    bits.push(
      `${diff.kept.length} kept, ${diff.added.length} added, ${diff.dropped.length} dropped`,
    );
  }
  return bits.join(" · ");
}

function foldLabel(items: TreeItem[]): string {
  const replaced = items.filter((i) => i.status === "replaced").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const dropped = items.filter((i) => i.status === "dropped").length;
  const done = items.length - replaced - skipped - dropped;
  const parts: string[] = [];
  if (done > 0) parts.push(`${done} done`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (replaced > 0) parts.push(`${replaced} replaced`);
  if (dropped > 0) parts.push(`${dropped} dropped`);
  return parts.join(" · ");
}

export interface PlanTreeInput {
  loop: LoopState;
  plan: TaskPlan;
  /** The re-plan waiting to be accepted, when one is (replanDiff) */
  diff?: ReplanDiff;
  history?: ChatHistoryItem[];
  now?: number;
  extras?: TreeExtras;
}

export function planTreeModel(input: PlanTreeInput): PlanTreeModel {
  const { loop, plan, diff } = input;
  const history = input.history ?? [];
  const extras = input.extras ?? {};
  const addedTexts = new Set(diff?.added ?? []);
  const decisions = autoDecisionsOf(loop);
  const questionDecisions = decisions
    .filter((d) => d.kind === "question")
    .slice(-2);
  const lastPlanDecision = [...decisions]
    .reverse()
    .find((d) => d.kind === "plan");
  const numberOf = new Map(plan.items.map((t, i) => [t.id, i + 1] as const));
  const replacedIds = extras.replacedBy ?? {};
  const planIds = new Set(plan.items.map((t) => t.id));

  // The current item: the one the loop works on, else one that waits or failed
  let currentId = workingIds(loop).find((id) => {
    const s = itemOf(loop, id);
    return s && s.status !== "done" && numberOf.has(id);
  });
  currentId ??= plan.items.find((t) => {
    const s = itemOf(loop, t.id)?.status;
    return s === "waiting" || s === "failed";
  })?.id;

  const items: TreeItem[] = plan.items.map((task, i) => {
    const state = itemOf(loop, task.id);
    const replacedBy = replacedIds[task.id];
    const status = treeStatusOf(state, { replaced: !!replacedBy });
    const isCurrent = task.id === currentId;
    const lines = itemLines(task, state, {
      loop,
      history,
      now: input.now,
      isCurrent,
      status,
      answers: questionDecisions,
    });
    const round = state?.addedInRound ?? extras.addedInRound?.[task.id];
    const target = replacedBy ? numberOf.get(replacedBy) : undefined;
    return {
      type: "item",
      id: task.id,
      number: i + 1,
      text: task.text,
      status,
      current: isCurrent,
      isNew: !state && addedTexts.has(task.text),
      ...(round && round > 1 ? { round } : {}),
      ...(replacedBy ? { replacedById: replacedBy } : {}),
      ...(target ? { replacedByNumber: target } : {}),
      lines,
      openByDefault: lines.length > 0 && (isCurrent || status === "failed"),
    };
  });

  // To-dos accepted re-plans took out (LoopState.replacedItems), struck through:
  // "replaced by N" when a repair left exactly one new to-do, else "dropped"
  const taken: TreeItem[] = (loop.replacedItems ?? [])
    .filter((r) => !planIds.has(r.id))
    .map((r) => {
      const target = r.replacedBy ? numberOf.get(r.replacedBy) : undefined;
      return {
        type: "item" as const,
        id: `replaced:${r.id}`,
        text: r.text ?? `To-do ${r.id}`,
        status: r.replacedBy ? ("replaced" as const) : ("dropped" as const),
        current: false,
        isNew: false,
        ...(r.replacedBy && target
          ? { replacedById: r.replacedBy, replacedByNumber: target }
          : {}),
        lines: [],
        openByDefault: false,
      };
    });

  const done = items.filter((i) => i.status === "done").length;
  const total = items.length;

  // The to-dos a waiting re-plan drops: struck through, in front
  const dropped: TreeItem[] = (diff?.dropped ?? []).map((d, i) => ({
    type: "item",
    id: `dropped:${i}`,
    text: d.text,
    status: "dropped",
    current: false,
    isNew: false,
    lines: [],
    openByDefault: false,
  }));

  const nodes: TreeNode[] = [];
  if (lastPlanDecision && !diff) {
    nodes.push({
      type: "trace",
      id: "trace",
      text: maskCommandForDisplay(lastPlanDecision.text),
    });
  }
  nodes.push(...dropped);

  const finished = [
    ...taken,
    ...items.filter(
      (i) =>
        i.status === "done" ||
        i.status === "skipped" ||
        i.status === "replaced",
    ),
  ];
  if (finished.length > 0) {
    nodes.push({
      type: "fold",
      id: "done",
      status: "done",
      label: foldLabel(finished),
      children: finished,
    });
  }

  const rest = items.filter((i) => !finished.includes(i));
  const upcoming = rest.filter((i) => i.status === "pending" && !i.current);
  // A waiting re-plan: what the loop kept as it was folds, new items stay in view
  const keptUnchanged = diff ? upcoming.filter((i) => !i.isNew) : [];
  const shown = diff
    ? []
    : upcoming.slice(
        0,
        upcoming.length > UPCOMING_SHOWN + 1 ? UPCOMING_SHOWN : upcoming.length,
      );
  const folded = diff ? [] : upcoming.filter((i) => !shown.includes(i));
  // Keep the plan's order among the items that stay in view
  nodes.push(
    ...rest.filter(
      (i) => !upcoming.includes(i) || shown.includes(i) || (!!diff && i.isNew),
    ),
  );
  if (folded.length > 0) {
    nodes.push({
      type: "fold",
      id: "upcoming",
      status: "pending",
      label: `${folded.length} more to do`,
      children: folded,
    });
  }
  if (keptUnchanged.length > 0) {
    nodes.push({
      type: "fold",
      id: "kept",
      status: "pending",
      label: `${keptUnchanged.length} kept, unchanged`,
      children: keptUnchanged,
    });
  }

  const failed = items.find((i) => i.status === "failed");
  const waiting = items.filter((i) => i.status === "waiting");
  const awaitingPlan = loop.status === "awaiting_plan" && !!diff;
  const current = items.find((i) => i.current);
  const progress = `${done}/${total} done`;

  let rootLabel: string;
  let rootStatus: PlanTreeModel["rootStatus"];
  if (awaitingPlan) {
    rootLabel = `plan waiting for you · ${progress}`;
    rootStatus = "waiting";
  } else if (failed) {
    rootLabel = `item ${failed.number} failed · ${progress}`;
    rootStatus = "failed";
  } else if (waiting.length > 0) {
    rootLabel =
      waiting.length === 1
        ? `item ${waiting[0].number} waits on you · ${progress}`
        : `${waiting.length} wait on you · ${progress}`;
    rootStatus = "waiting";
  } else if (total > 0 && done === total) {
    rootLabel = progress;
    rootStatus = "done";
  } else if (current?.status === "running") {
    rootLabel = `now item ${current.number} · ${progress}`;
    rootStatus = "running";
  } else {
    rootLabel = progress;
    rootStatus = "idle";
  }

  return {
    rootLabel,
    rootStatus,
    autoExpand: awaitingPlan || !!failed,
    summary: treeSummary(loop, diff),
    nodes,
    done,
    total,
    ...(currentId ? { currentId } : {}),
  };
}
