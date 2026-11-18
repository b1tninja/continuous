import type {
  ChatHistoryItem,
  LoopState,
  ModelDescription,
  SessionPromptCache,
} from "core";
import { findModelPricing } from "core/llm/utils/calculateRequestCost";
import { renderChatMessage } from "core/util/messageContent";
import { entryInputTokens, type CacheLedgerEntry } from "./cacheLedger";
import { warmCacheLoss } from "./cacheSafeguards";
import { formatRereadCost, formatTokens, formatUsd } from "./cacheNotices";
import {
  formatTimeLeft,
  modelSupportsOneHourCache,
  modelSupportsPromptCacheControl,
  modelUsesLocalPrefixCache,
  promptCacheStatus,
  PROMPT_CACHE_TTL_MS,
  type PromptCacheSessionState,
  type PromptCacheSetting,
  type PromptCacheTtl,
} from "./promptCache";

/**
 * What the first request of a fork pays for the conversation it copies, before
 * the fork is made. Design: plans/research/session-forking-and-cache.md,
 * sections 3 and 6.2.
 *
 * A fork that keeps the parent's model, mode, tools and history unchanged
 * sends the same prefix, so it reads whatever cache entry the parent left at
 * the fork point. Entries are written only where a request put a breakpoint
 * (ours end each request's prompt), and an entry expires one lifetime after a
 * request last read it. Whether reading a longer prefix also keeps the
 * entries at earlier boundaries alive is not documented, so an entry at an
 * earlier point is taken to have been read last by the request after the one
 * that wrote it (it may over-warn, never under-warn), and the price of an
 * earlier point is labelled an estimate until it is measured (phase F0).
 */
export interface ForkCost {
  /** Tokens of the conversation up to the fork point, as the fork resends it. */
  tokens: number;
  /** `tokens` is a local count (no request of this session ended there). */
  tokensEstimated: boolean;
  /** Of `tokens`, how many a request sent now would read from the cache. */
  warmTokens: number;
  /** When that cache entry expires (ms since epoch), when there is one. */
  warmUntil?: number;
  /**
   * The request that last read the entry at the fork point, warm or not:
   * when it started and its lifetime. Becomes the fork's cache record.
   */
  point?: { lastReadAt: number; ttl: PromptCacheTtl };
  /** Cost if nothing is cached: every token written (or sent at full price). */
  coldUsd?: number;
  /** Cost within the cache window: the warm part read, the rest written. */
  warmUsd?: number;
  /**
   * The warm part is an entry at an earlier point than the parent's last
   * request, whose lifetime rests on the undocumented refresh rule.
   */
  partlyWarmEstimate: boolean;
  /** Caching is off for this model and setting: everything at the input price. */
  cachingOff?: boolean;
  /** The model runs on the user's own server: the cost is time, not money. */
  local?: boolean;
  /** For a local server whose read speed is known: how long a re-read takes. */
  seconds?: number;
}

/**
 * How many of `history`'s items a request sends, counting from the first:
 * everything but the empty reply the request is about to fill. Undefined for
 * a Loop run in a fresh context, whose prompt starts later in the history.
 */
export function sentHistoryItems(
  history: ChatHistoryItem[],
  loop?: LoopState,
): number | undefined {
  if (loop?.current && loop.freshContext !== false) return undefined;
  const last = history[history.length - 1];
  const placeholder =
    !!last &&
    last.message.role === "assistant" &&
    !renderChatMessage(last.message) &&
    !last.toolCallStates?.length &&
    !last.reasoning?.text;
  return placeholder ? history.length - 1 : history.length;
}

const CHARS_PER_TOKEN = 4;

/** A rough size of what an item puts in the prompt. */
function itemChars(item: ChatHistoryItem): number {
  let chars = renderChatMessage(item.message).length;
  for (const ctx of item.contextItems ?? []) chars += ctx.content?.length ?? 0;
  const calls = (item.message as { toolCalls?: unknown[] }).toolCalls;
  if (calls?.length) chars += JSON.stringify(calls).length;
  return chars;
}

function historyChars(items: ChatHistoryItem[]): number {
  return items.reduce((sum, item) => sum + itemChars(item), 0);
}

/** The ledger entries a fork of this model and mode can read. */
function usableEntries(
  ledger: CacheLedgerEntry[],
  model: ModelDescription,
  mode: string | undefined,
): Array<{ e: CacheLedgerEntry; next?: CacheLedgerEntry }> {
  const out: Array<{ e: CacheLedgerEntry; next?: CacheLedgerEntry }> = [];
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i];
    if (
      e.historyItems === undefined ||
      e.pruned ||
      e.model !== model.model ||
      (mode !== undefined && e.mode !== undefined && e.mode !== mode)
    ) {
      continue;
    }
    out.push({ e, next: ledger[i + 1] });
  }
  return out;
}

/**
 * The last request that read the entry a request wrote: the request right
 * after it when that one read the cache, else itself. The entry expires one
 * lifetime after that request started.
 */
function lastReader(
  e: CacheLedgerEntry,
  next?: CacheLedgerEntry,
): { lastReadAt: number; ttl: PromptCacheTtl } {
  const reader =
    next &&
    next.cachingOn &&
    next.read > 0 &&
    next.model === e.model &&
    next.mode === e.mode &&
    !next.pruned
      ? next
      : e;
  return { lastReadAt: reader.at, ttl: reader.ttl ?? "5m" };
}

/** The lifetime the fork's first request would write with. */
function forkTtl(
  model: ModelDescription,
  setting: PromptCacheSetting | undefined,
  state: PromptCacheSessionState,
  now: number,
): PromptCacheTtl {
  const ttl = promptCacheStatus(model, setting, state, now).ttl;
  return ttl === "1h" && !modelSupportsOneHourCache(model) ? "5m" : ttl;
}

export interface ForkCostArgs {
  model: ModelDescription;
  setting: PromptCacheSetting | undefined;
  state: PromptCacheSessionState;
  history: ChatHistoryItem[];
  /** The last history item the fork keeps. */
  forkIndex: number;
  /** The session's mode, which picks the system prompt and tools. */
  mode?: string;
  now: number;
}

/**
 * What a fork at `forkIndex` costs to send its first message, for the line
 * shown before forking. Pure. Undefined when there is nothing to fork.
 */
export function forkCost(args: ForkCostArgs): ForkCost | undefined {
  const { model, setting, state, history, mode, now } = args;
  if (history.length === 0) return undefined;
  const forkIndex = Math.min(Math.max(args.forkIndex, 0), history.length - 1);
  const latest = forkIndex === history.length - 1;
  const entries = usableEntries(state.ledger ?? [], model, mode);

  // 1. Tokens to the fork point. The request whose prompt ended there, or the
  // one that wrote the fork point's last item (its input plus its output).
  let tokens: number | undefined;
  const exact = entries.filter((x) => x.e.historyItems === forkIndex + 1).pop();
  const producer = entries.filter((x) => x.e.historyItems! <= forkIndex).pop();
  if (exact) {
    tokens = entryInputTokens(exact.e);
  } else if (producer) {
    tokens = entryInputTokens(producer.e) + producer.e.output;
  }
  const tokensEstimated = tokens === undefined;
  if (tokens === undefined) {
    // A local count, scaled by the last request when one is known: what it
    // sent beyond the messages is the system prompt and the tools.
    const sent = sentHistoryItems(history) ?? history.length;
    const allChars = historyChars(history.slice(0, sent));
    const forkChars = historyChars(history.slice(0, forkIndex + 1));
    const overhead = state.lastInputTokens
      ? Math.max(0, state.lastInputTokens - allChars / CHARS_PER_TOKEN)
      : 0;
    tokens = Math.round(overhead + forkChars / CHARS_PER_TOKEN);
  }

  // A model on the user's own server: time, not money
  if (modelUsesLocalPrefixCache(model)) {
    const loss = latest ? warmCacheLoss(model, setting, state, now) : undefined;
    const speed = state.promptTokensPerSecond;
    return {
      tokens,
      tokensEstimated,
      warmTokens: loss ? Math.min(loss.tokens, tokens) : 0,
      partlyWarmEstimate: false,
      local: true,
      ...(speed && speed > 0 ? { seconds: tokens / speed } : {}),
    };
  }

  const pricing = findModelPricing(model.model, tokens);
  const per = (n: number, rate: number) => (n / 1_000_000) * rate;
  const status = modelSupportsPromptCacheControl(model)
    ? promptCacheStatus(model, setting, state, now)
    : undefined;
  if (!status?.on) {
    return {
      tokens,
      tokensEstimated,
      warmTokens: 0,
      partlyWarmEstimate: false,
      cachingOff: true,
      ...(pricing && { coldUsd: per(tokens, pricing.input) }),
    };
  }

  // 2. The warm part: the entry at the latest boundary at or before the fork
  // point, if it has not expired. Without a ledger (a reloaded session) only
  // the last request's entry is known, from the saved record.
  let warmTokens = 0;
  let warmUntil: number | undefined;
  let point: ForkCost["point"];
  const lastBoundary = Math.max(-1, ...entries.map((x) => x.e.historyItems!));
  const at = entries
    .filter((x) => x.e.cachingOn && x.e.historyItems! <= forkIndex + 1)
    .pop();
  if (at) {
    point = lastReader(at.e, at.next);
    const expires = point.lastReadAt + PROMPT_CACHE_TTL_MS[point.ttl];
    if (expires > now) {
      warmTokens = Math.min(entryInputTokens(at.e), tokens);
      warmUntil = expires;
    }
  }
  if (warmTokens === 0 && latest && entries.length === 0) {
    const loss = warmCacheLoss(model, setting, state, now);
    if (loss) {
      warmTokens = Math.min(loss.tokens, tokens);
      warmUntil = status.expiresAt;
    }
  }
  // An earlier point than the parent's last request rests on the refresh
  // rule that is not documented: say it is an estimate.
  const partlyWarmEstimate =
    warmTokens > 0 && !latest && lastBoundary > forkIndex + 1;

  // 3. Prices: written at the lifetime the fork would ask for. A model with
  // no write rate (Amazon Nova) bills written tokens as plain input.
  const ttl = forkTtl(model, setting, state, now);
  let coldUsd: number | undefined;
  let warmUsd: number | undefined;
  if (pricing) {
    const rate = ttl === "1h" ? pricing.cacheWrite1h : pricing.cacheWrite;
    const write = rate > 0 ? rate : pricing.input;
    coldUsd = per(tokens, write);
    if (warmTokens > 0) {
      warmUsd =
        per(warmTokens, pricing.cacheRead) + per(tokens - warmTokens, write);
    }
  }
  return {
    tokens,
    tokensEstimated,
    warmTokens,
    ...(warmUntil !== undefined && { warmUntil }),
    ...(point && { point }),
    ...(coldUsd !== undefined && { coldUsd }),
    ...(warmUsd !== undefined && { warmUsd }),
    partlyWarmEstimate,
  };
}

/** "Fork re-reads 200k tokens ≈ $1.00; within the cache window (4 min left) ≈ $0.04". */
export function formatForkCost(cost: ForkCost, now: number): string {
  const n = `${cost.tokensEstimated ? "about " : ""}${formatTokens(cost.tokens)} tokens`;
  if (cost.local) {
    const reread = formatRereadCost({
      tokens: cost.tokens,
      local: true,
      seconds: cost.seconds,
    });
    return cost.warmTokens > 0
      ? `Fork reads this conversation from the model server's cache while it still holds it; otherwise it re-reads ${reread}`
      : `Fork re-reads ${cost.tokensEstimated ? "about " : ""}${reread}`;
  }
  if (cost.cachingOff) {
    const usd =
      cost.coldUsd !== undefined ? ` ≈ ${formatUsd(cost.coldUsd)}` : "";
    return `Fork re-reads ${n}${usd} at full price (prompt caching is off)`;
  }
  const cold =
    cost.coldUsd !== undefined ? ` ≈ ${formatUsd(cost.coldUsd)}` : "";
  if (cost.warmTokens <= 0) {
    return `Fork re-reads ${n}${cold}; nothing is cached for this point now`;
  }
  const left =
    cost.warmUntil !== undefined && cost.warmUntil > now
      ? ` (${formatTimeLeft(cost.warmUntil - now)} left)`
      : "";
  const warm =
    cost.warmUsd !== undefined
      ? ` ≈ ${formatUsd(cost.warmUsd)}`
      : `, ${formatTokens(cost.warmTokens)} of them from the cache`;
  const estimate = cost.partlyWarmEstimate
    ? " (estimate: how long an earlier point stays cached is not measured yet)"
    : "";
  return `Fork re-reads ${n}${cold}; within the cache window${left}${warm}${estimate}`;
}

/**
 * The cache record the fork starts with: for a fork at the last item, the
 * parent's; for an earlier point, the entry at that point (when it was last
 * read and how big the prompt is), so the fork's notices say whether its own
 * cache is warm. Undefined when the parent's record is the right one.
 */
export function forkPromptCacheRecord(
  state: PromptCacheSessionState,
  cost: ForkCost | undefined,
  latest: boolean,
): SessionPromptCache | undefined {
  if (latest || !cost) return undefined;
  return {
    ...(cost.point && {
      lastRequestAt: cost.point.lastReadAt,
      lastTtl: cost.point.ttl,
    }),
    lastInputTokens: cost.tokens,
    ...(state.escalated && {
      escalated: true,
      ...(state.escalatedBy && { escalatedBy: state.escalatedBy }),
    }),
  };
}

/** The parent's ledger entries that end at or before the fork point. */
export function ledgerUpTo(
  ledger: CacheLedgerEntry[] | undefined,
  forkIndex: number,
): CacheLedgerEntry[] {
  return (ledger ?? []).filter(
    (e) => e.historyItems !== undefined && e.historyItems <= forkIndex + 1,
  );
}
