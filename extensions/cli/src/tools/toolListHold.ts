import type { ChatHistoryItem, Usage } from "core/index.js";
import { cacheTtlForcedTo5m } from "core/llm/llms/anthropicCache.js";
import { totalInputTokens } from "core/llm/utils/cacheStats.js";
import { findModelPricing } from "core/llm/utils/calculateRequestCost.js";
import {
  countToolChanges,
  describeToolChanges,
  functionFingerprint,
  type HeldToolList,
  NO_TOOL_CHANGES,
  type PendingToolChanges,
  pendingToolChangesText,
  resolveToolList,
  sameToolList,
  thinkingCutAfterToolChange,
  toolChangeDropsThinking,
  toolChangesId,
  toolChangeTiming,
  toolChangeWarning,
  withheldToolRefusal,
} from "core/tools/toolListHold.js";
import { resolveToolSearchMode } from "core/tools/toolSearch.js";
import type { ChatCompletionFunctionTool } from "openai/resources.mjs";

/**
 * The CLI's side of core/tools/toolListHold.ts (C80, C88). The tool list is
 * built again for every request; while the prompt cache is warm and
 * re-reading the conversation is significant, a change to it (an MCP server
 * toggled in /mcp, a server that connects late or changes its tools, a
 * permission change that offers or hides a tool) waits: the request offers
 * the list the previous one did, a tool turned off is refused when called,
 * and a one-line notice says what is waiting and how to apply it now
 * (`/tools apply`). It applies on the first request after the cache goes
 * cold, after compaction, and in a new session.
 *
 * In memory only, for this process's session.
 */

/** The same bars as the GUI's NOTICE_MIN_EXTRA_USD and NOTICE_MIN_TOKENS_UNPRICED. */
export const TOOL_HOLD_MIN_EXTRA_USD = 0.25;
export const TOOL_HOLD_MIN_TOKENS_UNPRICED = 100_000;
/** The CLI does not learn which lifetime Auto picked; 5 minutes is the safe guess. */
export const TOOL_HOLD_DEFAULT_LIFETIME_MS = 5 * 60_000;

/**
 * The cache lifetime the hold assumes for a model's `cacheBehavior.ttl`: 1 hour
 * only for a fixed "1h", and never while CONTINUOUS_FORCE_CACHE_5M=1 keeps
 * every entry on 5 minutes. Undefined means TOOL_HOLD_DEFAULT_LIFETIME_MS.
 */
export function heldToolsLifetimeMs(ttl: unknown): number | undefined {
  return ttl === "1h" && !cacheTtlForcedTo5m() ? 60 * 60_000 : undefined;
}

interface HoldState {
  warm?: { at: number; tokens: number; model: string; lifetimeMs: number };
  sent?: HeldToolList<ChatCompletionFunctionTool>;
  applyNext: boolean;
  /** What is waiting as of the last request */
  pending: PendingToolChanges;
  /** The pending set the transcript was already told about */
  announced?: string;
  /** Reasoning from history items before this index is not sent back */
  thinkingCut?: number;
  /** The last request's cost of a re-read, for /tools */
  lastLoss?: { tokens: number; extraUsd?: number };
  lastModel?: string;
}

let hold: HoldState = { applyNext: false, pending: NO_TOOL_CHANGES };

/** A new session, /clear, /compact or a resumed session: nothing waits. */
export function resetCliToolListHold(): void {
  hold = { applyNext: false, pending: NO_TOOL_CHANGES };
}

/** A finished request: the cache now holds its prompt, written or read. */
export function noteToolHoldRequest(args: {
  provider: string;
  model: string;
  usage: Usage;
  at?: number;
  lifetimeMs?: number;
}): void {
  const tokens = totalInputTokens(args.provider, args.model, args.usage);
  if (!(tokens > 0)) return;
  hold.warm = {
    at: args.at ?? Date.now(),
    tokens,
    model: args.model,
    lifetimeMs: args.lifetimeMs ?? TOOL_HOLD_DEFAULT_LIFETIME_MS,
  };
}

/** What writing `tokens` again costs over reading them, as the GUI prices it. */
export function rereadLoss(
  model: string,
  tokens: number,
): { tokens: number; extraUsd?: number } {
  const pricing = findModelPricing(model, tokens);
  return {
    tokens,
    ...(pricing && {
      extraUsd: (tokens / 1_000_000) * (pricing.cacheWrite - pricing.cacheRead),
    }),
  };
}

export function isSignificantReread(loss: {
  tokens: number;
  extraUsd?: number;
}): boolean {
  return loss.extraUsd === undefined
    ? loss.tokens >= TOOL_HOLD_MIN_TOKENS_UNPRICED
    : loss.extraUsd >= TOOL_HOLD_MIN_EXTRA_USD;
}

/** "366k tokens at full price (about $1.10 more)", as the GUI words it. */
export function formatCliRereadCost(loss: {
  tokens: number;
  extraUsd?: number;
}): string {
  const k =
    loss.tokens >= 1000
      ? `${Math.round(loss.tokens / 1000)}k`
      : `${loss.tokens}`;
  const usd =
    loss.extraUsd === undefined
      ? ""
      : loss.extraUsd < 0.01
        ? " (about under $0.01 more)"
        : ` (about $${loss.extraUsd.toFixed(2)} more)`;
  return `${k} tokens at full price${usd}`;
}

/**
 * The wait is off with CONTINUE_TOOL_CHANGES=now, and under tool search
 * (CONTINUE_TOOL_SEARCH=auto), where the model itself adds tools to the list.
 */
function waitDisabled(): boolean {
  return (
    process.env.CONTINUE_TOOL_CHANGES === "now" ||
    resolveToolSearchMode() === "auto"
  );
}

function noticeFor(
  pending: PendingToolChanges,
  loss: { tokens: number; extraUsd?: number },
  model: string,
): string {
  return (
    `${pendingToolChangesText(countToolChanges(pending))} (${describeToolChanges(pending)}). ` +
    `${toolChangeWarning(formatCliRereadCost(loss), toolChangeDropsThinking(model))} ` +
    "It applies when the cache goes cold, at /compact or /clear; /tools apply applies it now."
  );
}

/**
 * The tool list for this request, and a notice for the transcript the first
 * time a given set of changes starts to wait. Call once per request.
 */
export function cliToolListForRequest(args: {
  live: ChatCompletionFunctionTool[];
  /** Mode, model, Loop item, task list: a change here rebuilds on purpose */
  key: string;
  model: string;
  historyLength: number;
  now?: number;
}): {
  tools: ChatCompletionFunctionTool[];
  notice?: string;
  thinkingCut?: number;
} {
  const now = args.now ?? Date.now();
  const w = hold.warm;
  const warm =
    !!w && w.model === args.model && now - w.at <= w.lifetimeMs ? w : undefined;
  const loss = warm ? rereadLoss(args.model, warm.tokens) : undefined;
  const holdOn =
    !hold.applyNext &&
    toolChangeTiming({
      warm: !!warm,
      significant: !!loss && isSignificantReread(loss),
      applyAtOnce: waitDisabled(),
    }) === "queue";
  const decision = resolveToolList({
    live: args.live,
    held: hold.sent,
    key: args.key,
    hold: holdOn,
    nameOf: (t) => t.function.name,
    fingerprintOf: functionFingerprint,
  });
  const before = hold.sent;
  const thinkingCut = thinkingCutAfterToolChange({
    modelId: args.model,
    listChanged:
      !!before &&
      before.key === args.key &&
      !sameToolList(before.tools, decision.tools, functionFingerprint),
    historyLength: args.historyLength,
    previous: hold.thinkingCut,
  });
  hold.sent = { key: args.key, tools: decision.tools };
  hold.applyNext = false;
  hold.thinkingCut = thinkingCut;
  hold.pending = decision.held ? decision.pending : NO_TOOL_CHANGES;
  hold.lastLoss = loss;
  hold.lastModel = args.model;
  let notice: string | undefined;
  if (decision.held && loss) {
    const id = toolChangesId(decision.pending);
    if (hold.announced !== id) {
      hold.announced = id;
      notice = noticeFor(decision.pending, loss, args.model);
    }
  }
  return { tools: decision.tools, notice, thinkingCut };
}

/**
 * The refusal for a call to a withheld tool (C88), or undefined. `available`
 * is whether any server still offers the tool.
 */
export function cliWithheldRefusal(
  name: string,
  available: boolean,
): string | undefined {
  if (!hold.pending.removed.includes(name)) return undefined;
  return withheldToolRefusal(name, !available);
}

/** `/tools apply`: the next request sends the current list. */
export function applyCliToolChangesNow(): string {
  const n = countToolChanges(hold.pending);
  if (n === 0) return "No tool changes are waiting.";
  hold.applyNext = true;
  const drops =
    hold.lastModel && toolChangeDropsThinking(hold.lastModel)
      ? "; it rebuilds the cache and drops earlier reasoning"
      : "";
  const cost = hold.lastLoss
    ? ` and re-reads ${formatCliRereadCost(hold.lastLoss)}`
    : "";
  return `${pendingToolChangesText(n).replace("waiting for the cache to cool", "will apply")} at the next request${cost}${drops}.`;
}

/** `/tools`: what is waiting. */
export function cliPendingToolChangesLine(): string {
  const n = countToolChanges(hold.pending);
  if (n === 0) return "No tool changes are waiting for the prompt cache.";
  return `${pendingToolChangesText(n)}: ${describeToolChanges(hold.pending)}. Run /tools apply to apply now.`;
}

/**
 * The history as sent: reasoning that Claude signed before the last change
 * to the tool list is left out, on the models whose preserved thinking
 * refuses it after such a change (core thinkingCutAfterToolChange). A copy;
 * the history itself keeps the reasoning for display.
 */
export function withoutReasoningBefore(
  history: ChatHistoryItem[],
  cut: number | undefined,
): ChatHistoryItem[] {
  if (cut === undefined) return history;
  return history.map((item, i) =>
    i < cut && item.reasoning?.details?.length
      ? { ...item, reasoning: { ...item.reasoning, details: undefined } }
      : item,
  );
}
