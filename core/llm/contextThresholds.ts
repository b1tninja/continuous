import { isLocalApiBase } from "./localServers.js";

/**
 * When a long conversation is trimmed, and by how much
 * (plans/research/cache-friendly-context-trimming.md, decisions D1 and D3).
 *
 * A prompt cache reuses only the longest shared start of two prompts, so every
 * time the oldest messages are dropped the whole conversation after the system
 * prompt and tools is read again: about 85 s for 394k tokens on a local
 * server. Trimming a little on every turn therefore costs that on most turns.
 * Instead, nothing is dropped until the prompt passes the force threshold;
 * then a whole block goes at once, down to the block-drop target, and the
 * prompt grows append-only (every request a cache hit) until it reaches the
 * force threshold again.
 *
 * Every number is a share of the context window, so the block is a constant
 * of the window and the reply limit, never of the size of the latest turn.
 */

/** Local servers (this machine or the network) and hosted providers. */
export type ContextClass = "local" | "cloud";

export interface ContextThresholdShares {
  /** Prepare a compaction plan and its summary (C103 to C105). */
  prepare: number;
  /** Past this, a block of the oldest messages is dropped. */
  force: number;
  /** A block drop brings the prompt down to this. */
  dropTo: number;
  /** A compaction keeps this share of the window verbatim at the end... */
  tailShare: number;
  /** ...but no more than this many tokens. */
  tailMaxTokens: number;
}

/** Decision D3, as shares of the window. One table for every consumer. */
export const CONTEXT_THRESHOLDS: Readonly<
  Record<ContextClass, Readonly<ContextThresholdShares>>
> = {
  local: {
    prepare: 0.7,
    force: 0.85,
    dropTo: 0.6,
    tailShare: 0.15,
    tailMaxTokens: 65_536,
  },
  cloud: {
    prepare: 0.75,
    force: 0.9,
    dropTo: 0.65,
    tailShare: 0.1,
    tailMaxTokens: 65_536,
  },
};

/** The class of a model's endpoint: local when its address is local. */
export function contextClassFor(apiBase: string | undefined): ContextClass {
  return apiBase && isLocalApiBase(apiBase) ? "local" : "cloud";
}

/** Counting error allowance: 2% of the window, at most 1,000 tokens. */
export const SAFETY_BUFFER_MAX = 1000;
export const SAFETY_BUFFER_FRACTION = 0.02;
/** The least room kept for the reply, when the reply limit allows that much. */
export const MIN_RESPONSE_TOKENS = 1000;
/** The configured reply limit is reserved up to this share of the window. */
export const MAX_RESERVE_FRACTION = 0.1;

export function countingSafetyBuffer(window: number): number {
  return Math.min(SAFETY_BUFFER_MAX, window * SAFETY_BUFFER_FRACTION);
}

/**
 * Room kept for the reply: the configured limit, up to 10% of the window, and
 * at least 1,000 tokens (D3). A limit below 1,000 is reserved as it is, since
 * the reply can never use more.
 */
export function outputReserve(window: number, maxTokens?: number): number {
  const limit = maxTokens ?? MIN_RESPONSE_TOKENS;
  return Math.min(
    limit,
    Math.max(MIN_RESPONSE_TOKENS, Math.floor(window * MAX_RESERVE_FRACTION)),
  );
}

export interface ContextLimits {
  window: number;
  /** Counting error allowance. */
  safety: number;
  /** Kept for the reply. */
  reserve: number;
  /** The most the prompt may hold: the window less the safety and the reserve. */
  hardLimit: number;
  /** When the plan and the summary are prepared. */
  prepareAt: number;
  /** Past this the oldest block is dropped. Never above `hardLimit`. */
  forceAt: number;
  /** Where a block drop leaves the prompt. */
  dropTo: number;
  /** How much one drop removes: `forceAt - dropTo`, a constant of the window. */
  block: number;
}

/** The token limits for one window, reply limit and class. */
export function contextLimits(
  window: number,
  maxTokens: number | undefined,
  cls: ContextClass,
): ContextLimits {
  const shares = CONTEXT_THRESHOLDS[cls];
  const safety = countingSafetyBuffer(window);
  const reserve = outputReserve(window, maxTokens);
  const hardLimit = window - safety - reserve;
  // A small window can leave less than the force share once the reserve is
  // out; the thresholds then scale down together, keeping their proportions
  const forceAt = Math.max(
    0,
    Math.min(Math.floor(window * shares.force), hardLimit),
  );
  const scale = forceAt / (window * shares.force || 1);
  const dropTo = Math.floor(window * shares.dropTo * scale);
  const prepareAt = Math.floor(window * shares.prepare * scale);
  return {
    window,
    safety,
    reserve,
    hardLimit,
    prepareAt,
    forceAt,
    dropTo,
    block: Math.max(1, forceAt - dropTo),
  };
}

/**
 * How many blocks of the oldest history to drop for a prompt of `total`
 * tokens: none up to the force threshold, then one more for every block past
 * it. It only grows as the conversation grows, so the cut only moves forward,
 * and it moves once per block of growth.
 */
export function blocksToDrop(total: number, limits: ContextLimits): number {
  if (total <= limits.forceAt) return 0;
  return Math.ceil((total - limits.forceAt) / limits.block);
}
