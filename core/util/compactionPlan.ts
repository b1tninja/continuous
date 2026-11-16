import type { ChatHistoryItem } from "..";
import {
  CONTEXT_THRESHOLDS,
  type ContextClass,
  type ContextThresholdShares,
} from "../llm/contextThresholds";

/**
 * Planned compaction (plans/research/cache-friendly-context-trimming.md,
 * section 6.1, row C103). Pure: no I/O, no clock, so the GUI and later the CLI
 * (C111) compute the same plan from the same history.
 *
 * A plan splits the conversation into
 *
 *  - the head: the system message and the tools. Implicit: they are not
 *    history items, only their size counts;
 *  - the span, history items `[spanStart, spanEnd)`, which become the summary
 *    (stored on item `spanEnd - 1`, as "Compact" does today);
 *  - the tail, items `[spanEnd, now)`, kept verbatim.
 *
 * The first user request is not kept in the head: it is summarised with the
 * span and quoted verbatim at the top of the summary when it is under
 * `FIRST_USER_QUOTE_MAX_TOKENS` (the note's section 6.1).
 *
 * Once chosen, `spanEnd` does not move as the tail grows: a plan passed back as
 * `previous` is kept while its span is unchanged, so a summary prepared for it
 * stays valid. It is recomputed only when the span is edited, the model or its
 * window changes, a newer summary is applied (which moves `spanStart`), or the
 * conversation falls back below the prepare threshold.
 */

/**
 * When to prepare and force a compaction, as shares of the real window: the
 * planner's columns of decision D3 (`prepare`, `force`, `tailShare`,
 * `tailMaxTokens`).
 */
export type CompactionThresholds = Pick<
  ContextThresholdShares,
  "prepare" | "force" | "tailShare" | "tailMaxTokens"
>;

/**
 * Decision D3. Local is a server on this machine or network (`isLocalApiBase`,
 * or a server that answered `/props`); cloud is everything else. The table is
 * `core/llm/contextThresholds.ts`'s (C101), the one source for the block drop
 * and the planner, so the two cannot disagree on where "force" is.
 */
export const COMPACTION_THRESHOLDS: Readonly<
  Record<ContextClass, Readonly<CompactionThresholds>>
> = CONTEXT_THRESHOLDS;

/** The first user request is quoted verbatim in the summary below this size. */
export const FIRST_USER_QUOTE_MAX_TOKENS = 2_000;

export interface CompactionPlanTokens {
  head: number;
  span: number;
  tail: number;
  /** head + span + tail: what the next request carries. */
  total: number;
}

export interface CompactionPlan {
  /**
   * Stable for the same boundary and span content: computing the plan again
   * from the same history gives the same id, and any edit to the span, a
   * different boundary or window gives a new one. A prepared summary is used
   * only while its plan id is the current one.
   */
  id: string;
  /** Hash of the span's content (what the summary is made from). */
  hash: string;
  /** "prepare": summarise in the background; "force": the summary is due now. */
  state: "prepare" | "force";
  window: number;
  modelKey: string;
  /** First item summarised: the one after the newest existing summary. */
  spanStart: number;
  /** End of the span, exclusive; the verbatim tail starts here. */
  spanEnd: number;
  /** The first user request's index, when it is quoted verbatim. */
  quoteFirstUser?: number;
  tokens: CompactionPlanTokens;
}

export type NoCompactionPlan = {
  state: "idle";
  reason:
    | "no-window"
    | "below-threshold"
    // Everything after the newest summary fits in the tail: nothing to summarise
    | "nothing-to-summarise";
  tokens: CompactionPlanTokens;
};

export type CompactionPlanResult = CompactionPlan | NoCompactionPlan;

export interface PlanCompactionInput {
  history: readonly ChatHistoryItem[];
  /**
   * Each item's tokens as the provider counts them: measured, or estimated and
   * scaled. Missing entries count as 0, and so do items removed with "Choose
   * what to keep", which are not sent.
   */
  itemTokens: readonly number[];
  /** The system message and the tools. */
  headTokens: number;
  /** The real context window. */
  window: number;
  thresholds: CompactionThresholds;
  /** Provider and model: a plan made for another model is not reused. */
  modelKey?: string;
  /** The plan returned last time, so the boundary stays where it was. */
  previous?: CompactionPlan;
}

export function isCompactionPlan(
  result: CompactionPlanResult | undefined,
): result is CompactionPlan {
  return !!result && result.state !== "idle";
}

/** The plan for the conversation as it stands; see the module comment. */
export function planCompaction(
  input: PlanCompactionInput,
): CompactionPlanResult {
  const { history, window, thresholds, previous } = input;
  const modelKey = input.modelKey ?? "";
  const tokensAt = (i: number) =>
    history[i]?.removedByUser?.turn ? 0 : Math.max(0, input.itemTokens[i] ?? 0);
  const spanStart = firstAfterSummary(history);
  const head = Math.max(0, input.headTokens);
  const after = sum(spanStart, history.length, tokensAt);
  const totals = (spanEnd: number): CompactionPlanTokens => {
    const span = sum(spanStart, spanEnd, tokensAt);
    return { head, span, tail: after - span, total: head + after };
  };
  const idle = (reason: NoCompactionPlan["reason"]): NoCompactionPlan => ({
    state: "idle",
    reason,
    tokens: totals(spanStart),
  });

  if (!(window > 0)) return idle("no-window");
  const share = (head + after) / window;
  if (share < thresholds.prepare) return idle("below-threshold");
  const state = share >= thresholds.force ? "force" : "prepare";

  const kept =
    previous && stillValid(previous, history, spanStart, window, modelKey);
  const spanEnd = kept
    ? previous.spanEnd
    : chooseBoundary(history, spanStart, tokensAt, tailBudget(input));
  if (spanEnd === undefined) return idle("nothing-to-summarise");

  const hash = kept ? previous.hash : spanHash(history, spanStart, spanEnd);
  const quote = firstUserQuote(history, spanEnd, tokensAt);
  return {
    id: planId(spanStart, spanEnd, window, modelKey, hash),
    hash,
    state,
    window,
    modelKey,
    spanStart,
    spanEnd,
    ...(quote !== undefined && { quoteFirstUser: quote }),
    tokens: totals(spanEnd),
  };
}

/** The verbatim tail's budget: min(tailShare of the window, tailMaxTokens). */
export function tailBudget(
  input: Pick<PlanCompactionInput, "window" | "thresholds">,
): number {
  return Math.min(
    Math.floor(input.window * input.thresholds.tailShare),
    input.thresholds.tailMaxTokens,
  );
}

/** The item after the newest conversation summary (0 without one). */
export function firstAfterSummary(history: readonly ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) return i + 1;
  }
  return 0;
}

/**
 * The earliest turn start whose turns from there on fit in `budget`, or the
 * last turn when even it does not fit (a turn is never split). Undefined when
 * that leaves nothing before it to summarise.
 */
function chooseBoundary(
  history: readonly ChatHistoryItem[],
  spanStart: number,
  tokensAt: (i: number) => number,
  budget: number,
): number | undefined {
  const boundary = turnBoundaries(history);
  let suffix = 0;
  let chosen: number | undefined;
  for (let i = history.length - 1; i > spanStart; i--) {
    suffix += tokensAt(i);
    if (!boundary[i]) continue;
    if (suffix > budget && chosen !== undefined) break;
    chosen = i;
  }
  return chosen;
}

/**
 * Where a tail may start: at a user turn (not a tool result) that no later
 * item's tool result reaches back across, so a tool call is never split from
 * its result. One pass over the history.
 */
export function turnBoundaries(history: readonly ChatHistoryItem[]): boolean[] {
  const callAt = new Map<string, number>();
  // blocked[i] > 0: some tool result at or after i answers a call before i
  const delta = new Array<number>(history.length + 1).fill(0);
  history.forEach((item, j) => {
    const message = item.message;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        if (call.id) callAt.set(call.id, j);
      }
    } else if (message.role === "tool") {
      const c = callAt.get(message.toolCallId);
      if (c !== undefined && c + 1 <= j) {
        delta[c + 1] += 1;
        delta[j + 1] -= 1;
      }
    }
  });
  let blocked = 0;
  return history.map((item, i) => {
    blocked += delta[i];
    return item.message.role === "user" && blocked === 0;
  });
}

function stillValid(
  previous: CompactionPlan,
  history: readonly ChatHistoryItem[],
  spanStart: number,
  window: number,
  modelKey: string,
): boolean {
  return (
    previous.window === window &&
    previous.modelKey === modelKey &&
    previous.spanStart === spanStart &&
    previous.spanEnd > spanStart &&
    previous.spanEnd < history.length &&
    turnBoundaries(history)[previous.spanEnd] &&
    spanHash(history, spanStart, previous.spanEnd) === previous.hash
  );
}

function firstUserQuote(
  history: readonly ChatHistoryItem[],
  spanEnd: number,
  tokensAt: (i: number) => number,
): number | undefined {
  for (let i = 0; i < spanEnd; i++) {
    if (history[i].message.role !== "user") continue;
    if (history[i].removedByUser?.turn) return undefined;
    const tokens = tokensAt(i);
    return tokens > 0 && tokens < FIRST_USER_QUOTE_MAX_TOKENS ? i : undefined;
  }
  return undefined;
}

/**
 * What the summary is made from, for each span item: the message, the context
 * items and tool results it carries, and what "Choose what to keep" removed.
 * Ids, timestamps and UI state are left out, so only an edit to what is sent
 * changes the hash.
 */
function itemFingerprint(item: ChatHistoryItem): string {
  return JSON.stringify([
    item.message,
    (item.contextItems ?? []).map((c) => c.content),
    (item.toolCallStates ?? []).map((s) => [
      s.toolCallId,
      s.status,
      (s.output ?? []).map((o) => o.content),
    ]),
    item.removedByUser ?? null,
    item.conversationSummary ?? null,
  ]);
}

/** FNV-1a over the span items, two 32-bit lanes, as 16 hex digits. */
export function spanHash(
  history: readonly ChatHistoryItem[],
  start: number,
  end: number,
): string {
  const hasher = new Fnv();
  for (let i = start; i < end && i < history.length; i++) {
    hasher.add(itemFingerprint(history[i]) + " ");
  }
  return hasher.digest();
}

function planId(
  spanStart: number,
  spanEnd: number,
  window: number,
  modelKey: string,
  hash: string,
): string {
  const key = new Fnv()
    .add(`${spanStart}:${spanEnd}:${window}:${modelKey}:${hash}`)
    .digest();
  return `cp-${spanStart}-${spanEnd}-${key.slice(0, 12)}`;
}

/** FNV-1a, with a second differently seeded lane for 64 bits of digest. */
class Fnv {
  private a = 0x811c9dc5;
  private b = 0x050c5d1f;

  add(text: string): this {
    for (let k = 0; k < text.length; k++) {
      const c = text.charCodeAt(k);
      this.a = Math.imul(this.a ^ c, 0x01000193);
      this.b = Math.imul(this.b ^ c, 0x01000193) ^ (this.b >>> 15);
    }
    return this;
  }

  digest(): string {
    return hex(this.a) + hex(this.b);
  }
}

function hex(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

function sum(from: number, to: number, at: (i: number) => number): number {
  let total = 0;
  for (let i = from; i < to; i++) total += at(i);
  return total;
}
