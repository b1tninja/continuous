/**
 * What "Compact now" costs, and what not compacting costs (C107,
 * plans/research/cache-friendly-context-trimming.md section 7).
 *
 * A compaction plan splits the prompt in three: the head (system message and
 * tools, kept byte for byte, C104), the span (the turns the summary replaces)
 * and the tail (the turns kept verbatim after the summary). From their sizes,
 * the cache state and either the prices (cloud, dollars) or the server's
 * speeds (local, seconds), this estimates:
 *
 * - the summary request: the conversation plus the summary instruction, read
 *   from the cache when it is warm, then the summary written out;
 * - the switch-over: the first request after the summary, which reads the
 *   summary and the tail once (the head is still cached); nothing in the
 *   foreground when a local server was pre-warmed while the person was away;
 * - what each later turn saves, and after how many turns compacting has paid
 *   for itself;
 * - the alternatives: doing nothing (the next forced drop re-reads everything
 *   after the head) and dropping the oldest turns instead.
 *
 * Every figure is an estimate. Where the cache state is not known (a cloud
 * cache near the end of its lifetime), a figure is a range from warm to cold.
 *
 * Pure and with no node imports: the GUI and the CLI can share it. The sizes
 * are inputs; the planner that produces them (C103) is adapted to them with
 * `planSizesFrom`.
 */
import type { ModelPricing } from "../llm/utils/calculateRequestCost";
import { formatCost, formatTokens } from "../llm/utils/sessionUsage";

/** Token counts of the three parts of a compaction plan, as the provider counts them. */
export interface CompactionPlanSizes {
  /** System message and tools: unchanged by the compaction, still cached after it */
  head: number;
  /** The turns the summary replaces */
  span: number;
  /** The turns kept verbatim after the summary */
  tail: number;
}

/**
 * The cache state when the summary request is sent: `unknown` when it may
 * have expired (a cloud cache near the end of its lifetime), which gives a
 * range from warm to cold.
 */
export type CompactionCacheState = "warm" | "cold" | "unknown";

/** Dollars per million tokens. `findModelPricing` gives these for Claude and Nova. */
export interface CompactionPrices {
  input: number;
  output: number;
  cacheRead: number;
  /**
   * A cache write (5-minute). Providers that charge no write premium
   * (OpenAI, Gemini's implicit cache) pass the input price.
   */
  cacheWrite: number;
}

/** A local server's speeds, tokens per second. */
export interface LocalSpeeds {
  prefillTokS: number;
  decodeTokS: number;
}

export interface CompactionEstimateInput {
  plan: CompactionPlanSizes;
  /** The expected summary length; default 6,000 tokens */
  summaryTokens?: number;
  /** The summary instruction appended to the conversation; default 500 tokens */
  instructionTokens?: number;
  cache: CompactionCacheState;
  /**
   * Local servers: `[head][summary][tail]` was read while the person was
   * idle (C106), so the switch-over costs nothing in the foreground. On a
   * cloud provider a pre-warm moves the same write earlier and changes no
   * dollar figure.
   */
  prewarmed?: boolean;
  /** Tokens a forced drop of the oldest turns would remove; without it there is no drop-oldest comparison */
  dropTokens?: number;
  /**
   * Local servers: how many forced re-reads of the conversation a turn costs
   * when nothing is done (0.43 in the owner's session before C101; about one
   * per block of growth after it). Without it there is no per-turn saving or
   * break-even in seconds.
   */
  forcedRereadsPerTurn?: number;
  /** Dollars: give `prices` (cloud). Seconds: give `speeds` (local). */
  prices?: CompactionPrices;
  speeds?: LocalSpeeds;
}

/** An estimate that is one value when the cache state is known, a range otherwise. */
export interface EstimateRange {
  low: number;
  high: number;
}

export interface EstimatePart {
  /** Dollars or seconds */
  value: EstimateRange;
  /** Tokens read from the cache */
  cachedTokens: EstimateRange;
  /** Tokens read fresh (written to the cache on a provider that caches) */
  freshTokens: EstimateRange;
  /** Tokens generated */
  outputTokens: number;
}

export interface CompactionEstimate {
  /** Always "estimate": every figure here is one */
  label: "estimate";
  unit: "usd" | "seconds";
  cache: CompactionCacheState;
  prewarmed: boolean;
  plan: CompactionPlanSizes;
  summaryTokens: number;
  /** The summary request. On a local server it runs in the background. */
  summary: EstimatePart;
  /** The first request after the summary is applied (foreground) */
  switchOver: EstimatePart;
  /** Summary plus switch-over */
  compactNow: EstimateRange;
  /** What each later turn saves; undefined when it cannot be told */
  perTurnSaving?: EstimateRange;
  /** Turns until the saving has paid for the compaction; undefined when it never does or cannot be told */
  breakEvenTurns?: EstimateRange;
  /** The next forced drop: everything after the head read again */
  doNothing: EstimatePart;
  /** Dropping the oldest `tokensLost` tokens instead of summarising them */
  dropOldest?: EstimatePart & { tokensLost: number };
}

export const DEFAULT_SUMMARY_TOKENS = 6_000;
export const DEFAULT_INSTRUCTION_TOKENS = 500;

const PER_MILLION = 1_000_000;

const fixed = (n: number): EstimateRange => ({ low: n, high: n });

function range(
  cache: CompactionCacheState,
  warm: number,
  cold: number,
): EstimateRange {
  if (cache === "warm") return fixed(warm);
  if (cache === "cold") return fixed(cold);
  return { low: Math.min(warm, cold), high: Math.max(warm, cold) };
}

const add = (a: EstimateRange, b: EstimateRange): EstimateRange => ({
  low: a.low + b.low,
  high: a.high + b.high,
});

/** The price per token of each kind, or the time per token. */
interface Rates {
  cached: number;
  fresh: number;
  output: number;
}

function ratesOf(input: CompactionEstimateInput): {
  unit: "usd" | "seconds";
  rates: Rates;
} {
  if (input.speeds) {
    const { prefillTokS, decodeTokS } = input.speeds;
    if (!(prefillTokS > 0) || !(decodeTokS > 0)) {
      throw new Error("compaction estimate: speeds must be positive");
    }
    // A cached token is not read again: it costs no time
    return {
      unit: "seconds",
      rates: { cached: 0, fresh: 1 / prefillTokS, output: 1 / decodeTokS },
    };
  }
  if (input.prices) {
    const p = input.prices;
    return {
      unit: "usd",
      rates: {
        cached: p.cacheRead / PER_MILLION,
        fresh: p.cacheWrite / PER_MILLION,
        output: p.output / PER_MILLION,
      },
    };
  }
  throw new Error("compaction estimate: give prices or speeds");
}

function part(
  rates: Rates,
  cachedTokens: EstimateRange,
  freshTokens: EstimateRange,
  outputTokens: number,
): EstimatePart {
  // The cheap end pairs the fewest fresh tokens with the most cached ones
  const value = (cached: number, fresh: number) =>
    cached * rates.cached + fresh * rates.fresh + outputTokens * rates.output;
  const a = value(cachedTokens.high, freshTokens.low);
  const b = value(cachedTokens.low, freshTokens.high);
  return {
    value: { low: Math.min(a, b), high: Math.max(a, b) },
    cachedTokens,
    freshTokens,
    outputTokens,
  };
}

/** The estimate of section 7 for one plan. */
export function estimateCompaction(
  input: CompactionEstimateInput,
): CompactionEstimate {
  const { unit, rates } = ratesOf(input);
  const { head, span, tail } = input.plan;
  const summaryTokens = input.summaryTokens ?? DEFAULT_SUMMARY_TOKENS;
  const instruction = input.instructionTokens ?? DEFAULT_INSTRUCTION_TOKENS;
  const cache = input.cache;
  const prewarmed = !!input.prewarmed;
  const conversation = head + span + tail;
  const afterHead = span + tail;

  // The summary request: the conversation as last sent, then the instruction
  const summary = part(
    rates,
    range(cache, conversation, 0),
    range(cache, instruction, conversation + instruction),
    summaryTokens,
  );

  // The switch-over: the head is cached (it did not change, C104); the
  // summary and the tail are read once. A local pre-warm did that already.
  // With the cache possibly cold, the head may be read again too.
  const switchFresh = summaryTokens + tail;
  const switchOver =
    prewarmed && unit === "seconds"
      ? part(rates, fixed(head + switchFresh), fixed(0), 0)
      : part(
          rates,
          range(cache, head, 0),
          range(cache, switchFresh, head + switchFresh),
          0,
        );

  // Doing nothing: the next forced drop changes the prompt right after the
  // head, so everything after it is read (and written) again
  const doNothing = part(
    rates,
    range(cache, head, 0),
    range(cache, afterHead, conversation),
    0,
  );

  const dropTokens = input.dropTokens;
  const dropOldest =
    dropTokens !== undefined && dropTokens > 0
      ? {
          ...part(
            rates,
            range(cache, head, 0),
            range(
              cache,
              Math.max(0, afterHead - dropTokens),
              Math.max(0, conversation - dropTokens),
            ),
            0,
          ),
          tokensLost: Math.min(dropTokens, afterHead),
        }
      : undefined;

  const compactNow = add(summary.value, switchOver.value);

  // What a later turn saves. Cloud: the span, less the summary, is no longer
  // read from the cache on every turn. Local: a cached token costs no time,
  // so the saving is the forced re-reads that no longer happen.
  let perTurnSaving: EstimateRange | undefined;
  if (unit === "usd") {
    const saved = (span - summaryTokens) * rates.cached;
    perTurnSaving = saved > 0 ? fixed(saved) : undefined;
  } else if (
    input.forcedRereadsPerTurn !== undefined &&
    input.forcedRereadsPerTurn > 0
  ) {
    // A forced re-read is of the warm-head kind: the turn before it ran
    perTurnSaving = fixed(input.forcedRereadsPerTurn * afterHead * rates.fresh);
  }
  const breakEvenTurns = perTurnSaving
    ? {
        low: compactNow.low / perTurnSaving.high,
        high: compactNow.high / perTurnSaving.low,
      }
    : undefined;

  return {
    label: "estimate",
    unit,
    cache,
    prewarmed,
    plan: { head, span, tail },
    summaryTokens,
    summary,
    switchOver,
    compactNow,
    ...(perTurnSaving && { perTurnSaving }),
    ...(breakEvenTurns && { breakEvenTurns }),
    doNothing,
    ...(dropOldest && { dropOldest }),
  };
}

/**
 * The prices `findModelPricing` gives, as the estimate takes them.
 * `writePremium: false` for a provider that charges a cache write as plain
 * input (OpenAI, Gemini's implicit cache).
 */
export function compactionPricesFrom(
  pricing: ModelPricing,
  opts: { writePremium?: boolean } = {},
): CompactionPrices {
  return {
    input: pricing.input,
    output: pricing.output,
    cacheRead: pricing.cacheRead,
    cacheWrite:
      opts.writePremium === false ? pricing.input : pricing.cacheWrite,
  };
}

/** One request of Strata's `/metrics` `requests` list, the fields the speeds need. */
interface MetricsRequest {
  prompt_read?: unknown;
  prompt_ms?: unknown;
  output_tokens?: unknown;
  decode_ms?: unknown;
  decode_tok_s?: unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A request that read at least this much measures the long-read speed; short reads are mostly overhead. */
export const MIN_MEASURED_READ = 8_192;

/**
 * Speeds from a Strata `/metrics` answer. Prefill: the median speed of the
 * last ten requests that read at least `MIN_MEASURED_READ` tokens (the
 * re-reads a compaction replaces), else `live.prefill_tok_s_mean`. Decode:
 * the median `decode_tok_s` of the last ten requests (or output over decode
 * time on a server that does not report it). Undefined when neither speed
 * can be told. `except` leaves one request out (tests).
 */
export function speedsFromStrataMetrics(
  body: unknown,
  opts: { except?: string } = {},
): LocalSpeeds | undefined {
  const b = body as {
    requests?: (MetricsRequest & { id?: unknown })[];
    live?: { prefill_tok_s_mean?: unknown };
  };
  const requests = (Array.isArray(b?.requests) ? b.requests : [])
    .filter((r) => !opts.except || r?.id !== opts.except)
    .slice(0, 10);
  const prefills: number[] = [];
  const decodes: number[] = [];
  for (const r of requests) {
    const read = num(r?.prompt_read);
    const ms = num(r?.prompt_ms);
    if (read !== undefined && ms && read >= MIN_MEASURED_READ) {
      prefills.push(read / (ms / 1000));
    }
    const reported = num(r?.decode_tok_s);
    const out = num(r?.output_tokens);
    const decodeMs = num(r?.decode_ms);
    if (reported && reported > 0) decodes.push(reported);
    else if (out && decodeMs) decodes.push(out / (decodeMs / 1000));
  }
  const prefillTokS = median(prefills) ?? num(b?.live?.prefill_tok_s_mean);
  const decodeTokS = median(decodes);
  if (!prefillTokS || !decodeTokS) return undefined;
  return { prefillTokS, decodeTokS };
}

/**
 * The adapter from a planner's output (C103) to the estimate's sizes: any
 * object that says how many tokens the head, the span and the tail hold.
 */
export function planSizesFrom(plan: {
  headTokens: number;
  spanTokens: number;
  tailTokens: number;
}): CompactionPlanSizes {
  return {
    head: Math.max(0, plan.headTokens),
    span: Math.max(0, plan.spanTokens),
    tail: Math.max(0, plan.tailTokens),
  };
}

/** "about 12 s", "about 5 min". */
function seconds(s: number): string {
  if (s < 0.5) return "0 s";
  if (s < 120) return `${Math.round(s)} s`;
  return `${Math.round(s / 60)} min`;
}

/** Whether a range is wide enough to show both ends. */
const spread = (r: EstimateRange) => r.high > r.low * 1.15 + 1e-9;

function money(r: EstimateRange): string {
  return spread(r)
    ? `${formatCost(r.low)} to ${formatCost(r.high)}`
    : formatCost(r.low);
}

function time(r: EstimateRange): string {
  return spread(r) ? `${seconds(r.low)} to ${seconds(r.high)}` : seconds(r.low);
}

function turns(r: EstimateRange): string {
  const lo = Math.max(1, Math.round(r.low));
  const hi = Math.max(1, Math.round(r.high));
  return lo === hi
    ? `${lo} turn${lo === 1 ? "" : "s"}`
    : `${lo} to ${hi} turns`;
}

/**
 * The one line the note proposes for Compact now. For example, on Opus 5.5:
 * "Compact now (estimate): about $0.20 for the summary and $0.29 to rewrite
 * the cache. Each later turn is about $0.07 cheaper, so it pays for itself
 * after about 7 turns. Not compacting: the next forced drop rewrites about
 * 391k tokens, about $1.96." On a local server: "Compact now (estimate):
 * about 87 s in the background, then about 13 s once (0 s if prepared while
 * you are away). Not compacting: about 87 s on each forced re-read."
 */
export function formatCompactionEstimate(e: CompactionEstimate): string {
  const lowEnd = (p: EstimatePart) => fixed(p.value.low);
  if (e.unit === "usd") {
    const parts = [
      `Compact now (estimate): about ${money(lowEnd(e.summary))} for the summary and ${money(lowEnd(e.switchOver))} to rewrite the cache`,
    ];
    if (e.cache === "unknown" && spread(e.compactNow)) {
      parts[0] += ` (${money(e.compactNow)} if the cache has expired)`;
    }
    let line = `${parts[0]}.`;
    if (e.perTurnSaving && e.breakEvenTurns) {
      line += ` Each later turn is about ${formatCost(e.perTurnSaving.low)} cheaper, so it pays for itself after about ${turns(e.breakEvenTurns)}.`;
    } else {
      line +=
        " Later turns are not cheaper: the summary is not shorter than what it replaces.";
    }
    const rewritten = e.doNothing.freshTokens.low;
    line += ` Not compacting: the next forced drop rewrites about ${formatTokens(rewritten)} tokens, about ${money(e.doNothing.value)}.`;
    return line;
  }
  let line = `Compact now (estimate): about ${time(e.summary.value)} in the background, then `;
  line += e.prewarmed
    ? "nothing more at your next message (prepared while you were away)."
    : `about ${time(e.switchOver.value)} once (0 s if prepared while you are away).`;
  line += ` Not compacting: about ${time(e.doNothing.value)} on each forced re-read`;
  if (e.breakEvenTurns) {
    line += `; compacting pays for itself after about ${turns(e.breakEvenTurns)}`;
  }
  return `${line}.`;
}
