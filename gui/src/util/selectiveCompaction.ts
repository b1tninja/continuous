import type {
  ChatHistoryItem,
  MessagePart,
  ModelDescription,
  RemovedByUser,
} from "core";
import {
  CONTEXT_CATEGORIES,
  computeContextBreakdown,
  describeToolCall,
  estimateTextTokens,
  IMAGE_TOKENS,
  type ContextBreakdown,
} from "core/llm/contextBreakdown";
import type { PromptSegment } from "core/llm/promptSegments";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  renderContextItems,
  renderContextItemsWithStatus,
  stripImages,
} from "core/util/messageContent";
import { warmCacheLoss, type CacheLoss } from "./cacheSafeguards";
import type {
  PromptCacheSessionState,
  PromptCacheSetting,
} from "./promptCache";

/**
 * The model behind "Choose what to keep" (selective compaction,
 * plans/research/context-usage-breakdown.md section 8): what can be taken out
 * of the context, the person's selection, the marks it becomes on the history
 * items, the totals before and after, and what the edit costs the prompt
 * cache. Pure; the dialog is `SelectiveCompactDialog`.
 *
 * A selection is the set of keys of the items to remove. Old turns can only be
 * removed from the start of the conversation, so the removed turns are always
 * the oldest ones; the latest turn is never offered. Your messages and replies
 * are not offered one by one: removing one changes what later turns refer to,
 * which is what Compact (a summary) is for.
 */

export type KeepGroupKey =
  "toolResults" | "terminal" | "context" | "images" | "turns";

const categoryLabel = (key: string) =>
  CONTEXT_CATEGORIES.find((c) => c.key === key)?.label ?? key;

export const KEEP_GROUPS: ReadonlyArray<{ key: KeepGroupKey; label: string }> =
  [
    { key: "toolResults", label: categoryLabel("toolResults") },
    { key: "terminal", label: categoryLabel("terminal") },
    { key: "context", label: categoryLabel("context") },
    { key: "images", label: categoryLabel("images") },
    { key: "turns", label: "Oldest turns" },
  ];

export interface RemovableItem {
  /** Stable key: the selection holds these. */
  key: string;
  group: KeepGroupKey;
  label: string;
  /** The original's size, four characters per token (images 1,024). */
  tokens: number;
  /** Index in the history of the item it is part of (a turn: its first item). */
  historyIndex: number;
  /** Removed now, by a mark on the history. */
  removed: boolean;
  toolCallId?: string;
  ctxIndex?: number;
  partIndex?: number;
  /** For a turn: the index of its last history item (inclusive). */
  turnEnd?: number;
}

export interface KeepModel {
  /** Tool results, terminal output, attached context and images. */
  items: RemovableItem[];
  /** Turns that can be removed, oldest first; never the latest. */
  turns: RemovableItem[];
  /** Index of the first history item the request carries (after a summary). */
  start: number;
}

export type Selection = ReadonlySet<string>;

/** How the marks and the undo name a history item: its message id. */
export function historyKey(item: ChatHistoryItem, index: number): string {
  return (item.message as { id?: string }).id ?? `#${index}`;
}

function shorten(s: string, max = 40): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function firstAfterSummary(history: ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) return i + 1;
  }
  return 0;
}

/** The tokens one stretch of history adds to the request, as it would be sent. */
export function historyTokens(history: ChatHistoryItem[]): number {
  return computeContextBreakdown({ segments: [], history }).estimatedTokens;
}

/** Everything in the conversation the dialog can offer, with its size. */
export function listRemovable(history: ChatHistoryItem[]): KeepModel {
  const start = firstAfterSummary(history);
  const items: RemovableItem[] = [];

  // Turns start at each user message; anything before the first one joins it
  const turnStarts: number[] = [];
  for (let i = start; i < history.length; i++) {
    if (history[i].message.role === "user") turnStarts.push(i);
  }
  const turns: RemovableItem[] = [];
  for (let t = 0; t < turnStarts.length - 1; t++) {
    const first = t === 0 ? start : turnStarts[t];
    const end = turnStarts[t + 1] - 1;
    const slice = history
      .slice(first, end + 1)
      .map((item) =>
        item.removedByUser?.turn
          ? { ...item, removedByUser: { ...item.removedByUser, turn: false } }
          : item,
      );
    const text = stripImages(history[turnStarts[t]].message.content);
    turns.push({
      key: `turn:${historyKey(history[turnStarts[t]], turnStarts[t])}`,
      group: "turns",
      label: `Turn ${t + 1}: ${shorten(text) || "(no text)"}`,
      tokens: historyTokens(slice),
      historyIndex: first,
      turnEnd: end,
      removed: !!history[first].removedByUser?.turn,
    });
  }

  for (let i = start; i < history.length; i++) {
    const item = history[i];
    const mark = item.removedByUser;
    if (mark?.turn) continue;
    const id = historyKey(item, i);
    if (item.message.role === "user") {
      (item.contextItems ?? []).forEach((ctx, ctxIndex) => {
        if (!ctx.content?.trim()) return;
        items.push({
          key: `ctx:${id}:${ctxIndex}`,
          group: "context",
          label: shorten(ctx.description || ctx.name || "Attached context", 48),
          tokens: estimateTextTokens(`${ctx.content}\n`),
          historyIndex: i,
          ctxIndex,
          removed: !!mark?.contextItems?.includes(ctxIndex),
        });
      });
      const content = item.message.content;
      if (Array.isArray(content)) {
        (content as MessagePart[]).forEach((part, partIndex) => {
          if (part.type !== "imageUrl" && !mark?.images?.includes(partIndex)) {
            return;
          }
          items.push({
            key: `img:${id}:${partIndex}`,
            group: "images",
            label: `Image in turn ${turnStarts.filter((s) => s <= i).length}`,
            tokens: IMAGE_TOKENS,
            historyIndex: i,
            partIndex,
            removed: !!mark?.images?.includes(partIndex),
          });
        });
      }
    }
    if (item.message.role === "assistant") {
      for (const state of item.toolCallStates ?? []) {
        if (!state.output?.length) continue;
        const name = state.toolCall?.function?.name ?? "tool";
        const terminal = name === BuiltInToolNames.RunTerminalCommand;
        const body = terminal
          ? renderContextItemsWithStatus(state.output)
          : renderContextItems(state.output);
        if (!body) continue;
        items.push({
          key: `tool:${state.toolCallId}`,
          group: terminal ? "terminal" : "toolResults",
          label: describeToolCall(
            name,
            state.parsedArgs ?? state.toolCall?.function?.arguments,
          ),
          tokens: estimateTextTokens(body),
          historyIndex: i,
          toolCallId: state.toolCallId,
          removed: !!mark?.toolResults?.includes(state.toolCallId),
        });
      }
    }
  }
  items.sort((a, b) => b.tokens - a.tokens);
  return { items, turns, start };
}

/** What is removed now: the dialog opens on this. */
export function initialSelection(model: KeepModel): Set<string> {
  return new Set(
    [...model.items, ...model.turns].filter((i) => i.removed).map((i) => i.key),
  );
}

/** Turns removed by this selection: always the oldest ones. */
export function removedTurnCount(model: KeepModel, selection: Selection) {
  let n = 0;
  while (n < model.turns.length && selection.has(model.turns[n].key)) n++;
  return n;
}

/** Whether an item is inside a turn this selection removes whole. */
export function inRemovedTurn(
  model: KeepModel,
  selection: Selection,
  item: RemovableItem,
): boolean {
  const n = removedTurnCount(model, selection);
  return n > 0 && item.historyIndex <= model.turns[n - 1].turnEnd!;
}

/** Keep or remove one item. A turn takes the older (remove) or newer (keep) ones with it. */
export function setKept(
  model: KeepModel,
  selection: Selection,
  key: string,
  keep: boolean,
): Set<string> {
  const next = new Set(selection);
  const turn = model.turns.findIndex((t) => t.key === key);
  if (turn >= 0) {
    const range = keep
      ? model.turns.slice(turn)
      : model.turns.slice(0, turn + 1);
    for (const t of range) {
      if (keep) next.delete(t.key);
      else next.add(t.key);
    }
    return next;
  }
  if (keep) next.delete(key);
  else next.add(key);
  return next;
}

export function groupItems(model: KeepModel, group: KeepGroupKey) {
  return group === "turns"
    ? model.turns
    : model.items.filter((i) => i.group === group);
}

/** "all" kept, "none" kept or "some": the group's checkbox (mixed for some). */
export function groupState(
  model: KeepModel,
  selection: Selection,
  group: KeepGroupKey,
): "all" | "none" | "some" {
  const items = groupItems(model, group).filter(
    (i) => group === "turns" || !inRemovedTurn(model, selection, i),
  );
  const kept = items.filter((i) => !selection.has(i.key)).length;
  if (kept === items.length) return "all";
  return kept === 0 ? "none" : "some";
}

export function setGroupKept(
  model: KeepModel,
  selection: Selection,
  group: KeepGroupKey,
  keep: boolean,
): Set<string> {
  const next = new Set(selection);
  for (const i of groupItems(model, group)) {
    if (keep) next.delete(i.key);
    else next.add(i.key);
  }
  return next;
}

function normalize(mark: RemovedByUser | undefined): RemovedByUser | null {
  if (!mark) return null;
  const out: RemovedByUser = {};
  if (mark.turn) out.turn = true;
  if (mark.toolResults?.length) out.toolResults = [...mark.toolResults].sort();
  if (mark.contextItems?.length) {
    out.contextItems = [...mark.contextItems].sort((a, b) => a - b);
  }
  if (mark.images?.length) out.images = [...mark.images].sort((a, b) => a - b);
  return Object.keys(out).length ? out : null;
}

const sameMark = (a: RemovedByUser | null, b: RemovedByUser | null) =>
  JSON.stringify(a) === JSON.stringify(b);

export interface MarkChanges {
  /** New marks by message id, only for the items that change; null clears. */
  marks: Record<string, RemovedByUser | null>;
  /** History index of the first item that changes, if any. */
  firstChanged?: number;
}

/** The marks a selection puts on the history, as changes to the current ones. */
export function marksFor(
  history: ChatHistoryItem[],
  model: KeepModel,
  selection: Selection,
): MarkChanges {
  const wanted = new Map<number, RemovedByUser>();
  const at = (i: number) => {
    let m = wanted.get(i);
    if (!m) wanted.set(i, (m = {}));
    return m;
  };
  const turns = removedTurnCount(model, selection);
  if (turns > 0) {
    for (let i = model.start; i <= model.turns[turns - 1].turnEnd!; i++) {
      at(i).turn = true;
    }
  }
  for (const item of model.items) {
    if (!selection.has(item.key)) continue;
    const m = at(item.historyIndex);
    if (item.toolCallId !== undefined) {
      (m.toolResults ??= []).push(item.toolCallId);
    } else if (item.ctxIndex !== undefined) {
      (m.contextItems ??= []).push(item.ctxIndex);
    } else if (item.partIndex !== undefined) {
      (m.images ??= []).push(item.partIndex);
    }
  }
  // Items inside a turn removed now are not listed: their own marks stay as
  // they are, and come back with the turn when it is put back
  const hidden = (i: number) => !!history[i].removedByUser?.turn;

  const marks: Record<string, RemovedByUser | null> = {};
  let firstChanged: number | undefined;
  for (let i = model.start; i < history.length; i++) {
    const current = normalize(history[i].removedByUser);
    let next = normalize(wanted.get(i));
    if (hidden(i) && current) {
      next = normalize({ ...current, turn: !!next?.turn });
    }
    if (sameMark(current, next)) continue;
    marks[historyKey(history[i], i)] = next;
    firstChanged ??= i;
  }
  return { marks, firstChanged };
}

/** The history with the changes applied, for the estimates. */
export function withMarks(
  history: ChatHistoryItem[],
  changes: MarkChanges,
): ChatHistoryItem[] {
  return history.map((item, i) => {
    const id = historyKey(item, i);
    if (!(id in changes.marks)) return item;
    return { ...item, removedByUser: changes.marks[id] ?? undefined };
  });
}

export interface KeepTotals {
  /** The context now, as the meter shows it. */
  nowTokens: number;
  /** The context after applying the selection. */
  afterTokens: number;
  /** nowTokens - afterTokens (negative when items are put back). */
  removedTokens: number;
  /** The window, when known. */
  window?: number;
  /**
   * The factor from estimate to the provider's count (1 when there is none):
   * every item's size is shown scaled by it, as the meter's split is.
   */
  factor: number;
  /** 1-based turn of the first changed item, when anything changes. */
  fromTurn?: number;
  /** Tokens from the first changed item on, after the change: what the next request re-reads. */
  rereadTokens: number;
}

/** The factor the meter's split was scaled by (1 when it was not). */
export function scaleFactor(breakdown: ContextBreakdown): number {
  if (!breakdown.scaled || breakdown.estimatedTokens <= 0) return 1;
  if (breakdown.categories.some((c) => c.key === "other")) return 1;
  return breakdown.usedTokens / breakdown.estimatedTokens;
}

export function keepTotals(args: {
  history: ChatHistoryItem[];
  segments: PromptSegment[];
  now: ContextBreakdown;
  changes: MarkChanges;
}): KeepTotals {
  const { history, segments, now, changes } = args;
  const factor = scaleFactor(now);
  const after = withMarks(history, changes);
  const afterEstimate = computeContextBreakdown({
    segments,
    history: after,
  }).estimatedTokens;
  const removedTokens = Math.round(
    (now.estimatedTokens - afterEstimate) * factor,
  );
  const totals: KeepTotals = {
    nowTokens: now.usedTokens,
    afterTokens: Math.max(0, now.usedTokens - removedTokens),
    removedTokens,
    window: now.window,
    factor,
    rereadTokens: 0,
  };
  if (changes.firstChanged !== undefined) {
    const start = firstAfterSummary(history);
    totals.fromTurn = Math.max(
      1,
      history
        .slice(start, changes.firstChanged + 1)
        .filter((i) => i.message.role === "user").length,
    );
    totals.rereadTokens = Math.round(
      historyTokens(after.slice(changes.firstChanged)) * factor,
    );
  }
  return totals;
}

/**
 * What the edit costs the prompt cache: the next request reads the cached
 * prefix up to the first changed message and re-reads everything after it.
 * Undefined when nothing is at stake (caching off or cold, no change, the
 * size not known yet). Priced as `warmCacheLoss` prices a whole re-read, for
 * the share of the conversation after the first change; for a local server
 * the loss is time.
 */
export function editCacheLoss(
  model: ModelDescription,
  setting: PromptCacheSetting | undefined,
  state: PromptCacheSessionState,
  now: number,
  rereadTokens: number,
): CacheLoss | undefined {
  if (rereadTokens <= 0) return undefined;
  const whole = warmCacheLoss(model, setting, state, now);
  if (!whole || whole.tokens <= 0) return undefined;
  const tokens = Math.min(rereadTokens, whole.tokens);
  const share = tokens / whole.tokens;
  return {
    ...whole,
    tokens,
    ...(whole.extraUsd !== undefined && { extraUsd: whole.extraUsd * share }),
    ...(whole.seconds !== undefined && { seconds: whole.seconds * share }),
  };
}

/**
 * The context as it stands, when "Choose what to keep" has changed it since
 * the last request: the provider's count is for the history as it was sent
 * (`sent`), so the current one keeps that count less the estimated change,
 * scaled the same way. Without unsent changes it is `sent` itself.
 */
export function currentBreakdown(args: {
  segments: PromptSegment[];
  history: ChatHistoryItem[];
  /** Marks before the unsent changes, by message id (session.contextRemovalUndo). */
  previousMarks?: Record<string, RemovedByUser | null>;
  contextLength?: number;
  maxTokens?: number;
  reportedTokens?: number;
}): ContextBreakdown {
  const { previousMarks, ...input } = args;
  if (!previousMarks) return computeContextBreakdown(input);
  const sent = computeContextBreakdown({
    ...input,
    history: withMarks(input.history, { marks: previousMarks }),
  });
  if (!sent.scaled) return computeContextBreakdown(input);
  const estimate = computeContextBreakdown({
    segments: input.segments,
    history: input.history,
  }).estimatedTokens;
  return computeContextBreakdown({
    ...input,
    reportedTokens: Math.max(
      1,
      sent.usedTokens -
        Math.round((sent.estimatedTokens - estimate) * scaleFactor(sent)),
    ),
  });
}
