import type { ServerTimings, Usage } from "../index.js";

/**
 * The server's own clock for one request, read into `Usage.serverTimings`
 * (J16, plans/research/throughput-latency-display.md section 3).
 *
 * - llama.cpp and Strata send `timings` in llama.cpp's names. `prompt_n` is
 *   the part of the prompt they read and `cache_n` the part their cache
 *   already held, so `prompt_per_second` is already over the uncached tokens.
 * - Ollama's OpenAI-compatible endpoint sends `timings` in the same names but
 *   without `cache_n`: its `prompt_n` is the whole prompt, cached tokens
 *   included, and its `prompt_per_second` is `prompt_n / prompt_ms`. After a
 *   cache hit that rate is too high, so the read speed is recomputed from
 *   `prompt_n - cached_tokens` when the usage gives the cached count (as
 *   Ollama's own `--verbose` summary does).
 * - Ollama's native `/api/chat` sends counts and nanosecond durations on its
 *   `done: true` line; `ollamaUsage` maps them.
 */

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** Tokens per second for `n` tokens over `ms`, or undefined when either is zero. */
const perSecond = (n: number | undefined, ms: number | undefined) =>
  n && ms && ms > 0 ? (n * 1000) / ms : undefined;

function compact(t: ServerTimings): ServerTimings | undefined {
  const out = Object.fromEntries(
    Object.entries(t).filter(([, v]) => v !== undefined),
  ) as ServerTimings;
  return Object.keys(out).length ? out : undefined;
}

/**
 * `timings` of an OpenAI-style chunk, in llama.cpp's names. `cachedTokens` is
 * the usage's `prompt_tokens_details.cached_tokens`, used only when the
 * timings do not say how much came from the cache (Ollama).
 */
export function serverTimingsOf(
  timings: unknown,
  cachedTokens?: number,
): ServerTimings | undefined {
  if (!timings || typeof timings !== "object") return undefined;
  const t = timings as Record<string, unknown>;
  const promptNRaw = num(t.prompt_n);
  const cacheNRaw = num(t.cache_n);
  const promptMs = num(t.prompt_ms);
  let promptN = promptNRaw;
  let cacheN = cacheNRaw;
  let promptPerSecond = num(t.prompt_per_second);
  if (cacheNRaw === undefined && cachedTokens && promptNRaw !== undefined) {
    // Ollama: prompt_n includes the cached tokens; take them out
    cacheN = Math.min(cachedTokens, promptNRaw);
    promptN = promptNRaw - cacheN;
    promptPerSecond = perSecond(promptN, promptMs);
  }
  return compact({
    promptN,
    cacheN,
    promptMs,
    promptPerSecond: promptPerSecond || undefined,
    predictedN: num(t.predicted_n),
    predictedMs: num(t.predicted_ms),
    predictedPerSecond: num(t.predicted_per_second) || undefined,
    draftN: num(t.draft_n),
    draftNAccepted: num(t.draft_n_accepted),
  });
}

/**
 * The usage with the server's timings: `serverTimings`, the read speed in
 * `promptTokensPerSecond`, and `cache_n` as the cached count when the usage
 * has none (a llama.cpp that does not put it in `cached_tokens`).
 */
export function withServerTimings(usage: Usage, timings: unknown): Usage {
  const cachedTokens = usage.promptTokensDetails?.cachedTokens;
  const server = serverTimingsOf(timings, cachedTokens);
  if (!server) return usage;
  const out: Usage = { ...usage, serverTimings: server };
  if (server.promptPerSecond) {
    out.promptTokensPerSecond = server.promptPerSecond;
  }
  if (
    cachedTokens === undefined &&
    server.cacheN !== undefined &&
    server.cacheN > 0
  ) {
    out.promptTokensDetails = {
      ...usage.promptTokensDetails,
      cachedTokens: server.cacheN,
    };
  }
  return out;
}

/** The fields of Ollama's native `done: true` line that carry counts and times. */
export interface OllamaDoneMetrics {
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

const nsToMs = (ns: number | undefined) =>
  ns === undefined ? undefined : ns / 1e6;

/**
 * The usage of a native Ollama `/api/chat` or `/api/generate` reply, from its
 * `done: true` line. Durations are in nanoseconds ("All durations are returned
 * in nanoseconds"); `prompt_eval_count` includes `prompt_eval_cached_count`,
 * which is left out of the read speed. Undefined when the line carries no
 * counts.
 */
export function ollamaUsage(done: OllamaDoneMetrics): Usage | undefined {
  const promptTokens = num(done.prompt_eval_count);
  const completionTokens = num(done.eval_count);
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined;
  }
  const cached = num(done.prompt_eval_cached_count);
  const cacheN =
    cached === undefined ? undefined : Math.min(cached, promptTokens ?? 0);
  const promptN =
    promptTokens === undefined ? undefined : promptTokens - (cacheN ?? 0);
  const promptMs = nsToMs(num(done.prompt_eval_duration));
  const predictedMs = nsToMs(num(done.eval_duration));
  const server = compact({
    promptN,
    cacheN,
    promptMs,
    promptPerSecond: perSecond(promptN, promptMs),
    predictedN: completionTokens,
    predictedMs,
    predictedPerSecond: perSecond(completionTokens, predictedMs),
    loadMs: nsToMs(num(done.load_duration)),
    totalMs: nsToMs(num(done.total_duration)),
  });
  return {
    promptTokens: promptTokens ?? 0,
    completionTokens: completionTokens ?? 0,
    ...(cacheN !== undefined && {
      promptTokensDetails: { cachedTokens: cacheN },
    }),
    ...(server?.promptPerSecond && {
      promptTokensPerSecond: server.promptPerSecond,
    }),
    ...(server && { serverTimings: server }),
  };
}
