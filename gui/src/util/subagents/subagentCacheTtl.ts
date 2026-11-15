import type { ModelDescription } from "core";
import {
  INITIAL_PROMPT_CACHE_STATE,
  type PromptCacheSessionState,
  type PromptCacheTtl,
  resolvePromptCache,
} from "../promptCache";

/**
 * `cacheBehavior.subagentTtl` (C85): the lifetime of a subagent run's cache
 * entries, read from the model the run uses.
 *
 * - "5m" (the default): a run's requests come seconds apart, so a 1-hour
 *   entry, which costs more to write, would rarely be read after the
 *   five minutes a cheaper entry already covers.
 * - "1h": every request of the run asks for 1 hour.
 * - "auto": the chat window's Auto policy on the run's own requests:
 *   5 minutes, then 1 hour from the run's fifth model call or after a pause
 *   a 1-hour entry would have covered (a run waiting for an approval).
 * - "inherit": what the chat toolbar and `cacheBehavior.ttl` say, as before
 *   this setting existed.
 *
 * It never turns caching on or off, and CONTINUOUS_FORCE_CACHE_5M=1 (applied
 * by the providers in core) overrides it.
 */
export type SubagentTtlPolicy = "5m" | "1h" | "auto" | "inherit";

export const DEFAULT_SUBAGENT_TTL: SubagentTtlPolicy = "5m";

export function subagentTtlPolicy(model: ModelDescription): SubagentTtlPolicy {
  const value: unknown = model.cacheBehavior?.subagentTtl;
  return value === "5m" ||
    value === "1h" ||
    value === "auto" ||
    value === "inherit"
    ? value
    : DEFAULT_SUBAGENT_TTL;
}

/**
 * The lifetime the run's first request asks for, or undefined for "inherit"
 * (the parent's options stay as they are).
 */
export function subagentFirstCacheTtl(
  policy: SubagentTtlPolicy,
): PromptCacheTtl | undefined {
  switch (policy) {
    case "inherit":
      return undefined;
    case "1h":
      return "1h";
    default:
      return "5m";
  }
}

/**
 * Auto for one run: the lifetime of the request being sent now and the run's
 * state after it. Uses the chat window's own rules (resolvePromptCache with
 * the "auto" setting in an agent-style mode), so the two cannot drift.
 */
export function nextSubagentAutoTtl(
  model: ModelDescription,
  state: PromptCacheSessionState = INITIAL_PROMPT_CACHE_STATE,
  now: number = Date.now(),
): { ttl: PromptCacheTtl; nextState: PromptCacheSessionState } {
  const { options, nextState } = resolvePromptCache(
    model,
    "auto",
    state,
    now,
    "agent",
  );
  return { ttl: options.promptCacheTtl ?? "5m", nextState };
}
