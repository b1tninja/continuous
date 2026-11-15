/**
 * When a provider refuses a prompt as too long, how long it really was, and
 * what to learn from that.
 *
 * The prompt is pruned with an estimate (a GPT tokenizer times a per-family
 * factor, getAdjustedTokenCount.ts). For Claude the factor is 1.23; a
 * conversation of tool output and code came out at least 7% above that and
 * Bedrock refused it: "prompt is too long: 1067710 tokens > 1000000 maximum"
 * (Sonnet 5.5, 2026-11-14). The provider's count is the truth, so a refusal
 * that states it gives a correction for the next try.
 *
 * Two things are learned, and kept apart:
 *
 * - the overflow correction, from a refused request: it only ever shrinks the
 *   budget (`MIN_CORRECTION` is 1), for every provider;
 * - the usage calibration, from every answered request to a local server:
 *   the provider's `prompt_tokens` over our estimate of the same prompt, which
 *   may go below 1. A Qwen model is counted with the Llama 2 tokenizer and
 *   over-counted by about 23% (a ratio of 0.81), so without it pruning starts
 *   about 97k tokens early on a 524k window (decision D2 of
 *   plans/research/cache-friendly-context-trimming.md).
 *
 * Both live for the life of the process, by model.
 */

export interface ContextOverflow {
  /** The prompt's length as the provider counted it, when it said. */
  actualTokens?: number;
  /** The provider's limit, when it said. */
  maxTokens?: number;
}

const PATTERNS: { re: RegExp; actual?: number; max?: number }[] = [
  // Anthropic and Bedrock: "prompt is too long: 1067710 tokens > 1000000 maximum"
  {
    re: /prompt is too long:\s*([\d,]+)\s*tokens?\s*>\s*([\d,]+)/i,
    actual: 1,
    max: 2,
  },
  // OpenAI: "This model's maximum context length is 128000 tokens. However,
  // your messages resulted in 130001 tokens"
  {
    re: /maximum context length is\s*([\d,]+)\s*tokens?[\s\S]*?resulted in\s*([\d,]+)\s*tokens?/i,
    max: 1,
    actual: 2,
  },
  // Gemini: "The input token count (1100000) exceeds the maximum number of
  // tokens allowed (1048576)"
  {
    re: /input token count\s*\(([\d,]+)\)\s*exceeds the maximum[^(]*\(([\d,]+)\)/i,
    actual: 1,
    max: 2,
  },
  // vLLM-served models, Bedrock GPT OSS among them: "Input length (515073)
  // exceeds model's maximum context length (131072)." (live, 2026-11-14)
  {
    re: /input length\s*\(([\d,]+)\)\s*exceeds[^(]*?maximum context length\s*\(([\d,]+)\)/i,
    actual: 1,
    max: 2,
  },
  // Bedrock Converse, other families: "Input is too long for requested model"
  {
    re: /input is too long|too many input tokens|context[_ ]length[_ ]exceeded|exceeds? (?:the )?(?:model'?s )?(?:maximum )?context (?:window|length)/i,
  },
];

function toNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The overflow a provider error describes, or undefined for any other error. */
export function parseContextOverflow(
  message: string,
): ContextOverflow | undefined {
  for (const { re, actual, max } of PATTERNS) {
    const m = re.exec(message);
    if (!m) continue;
    return {
      ...(actual && { actualTokens: toNumber(m[actual]) }),
      ...(max && { maxTokens: toNumber(m[max]) }),
    };
  }
  return undefined;
}

/** Corrections stay between these, so one odd count cannot run away. */
export const MIN_CORRECTION = 1;
export const MAX_CORRECTION = 2;
/** Headroom on top of the measured ratio, so the next try is not on the edge. */
export const CORRECTION_HEADROOM = 1.05;

/**
 * The factor to shrink the context budget by after an overflow: the
 * provider's count over our estimate of the same prompt, with headroom, never
 * below the current correction. Undefined when either count is missing.
 */
export function correctionFromOverflow(
  overflow: ContextOverflow,
  estimatedTokens: number,
  current = MIN_CORRECTION,
): number | undefined {
  if (!overflow.actualTokens || !(estimatedTokens > 0)) return undefined;
  const ratio = (overflow.actualTokens / estimatedTokens) * CORRECTION_HEADROOM;
  return Math.min(MAX_CORRECTION, Math.max(current, ratio, MIN_CORRECTION));
}

/** Overflow corrections learned from refusals, by model. */
const corrections = new Map<string, number>();

/** Usage calibrations: the smoothed ratio of the provider's count to ours. */
const calibrations = new Map<string, number>();

/** The usage calibration's bounds: it may give room back, within reason. */
export const MIN_CALIBRATION = 0.6;
export const MAX_CALIBRATION = 2;
/** Weight of the newest request in the smoothed ratio. */
export const CALIBRATION_SMOOTHING = 0.3;
/**
 * Once there is a ratio, a sample outside this range of it is ignored: one odd
 * request (a prompt counted differently, a server that answered from
 * elsewhere) must not swing the budget.
 */
export const MIN_SAMPLE_RELATIVE = 0.7;
export const MAX_SAMPLE_RELATIVE = 1.5;
/** Smaller prompts are mostly template overhead and say little about the ratio. */
export const MIN_CALIBRATION_SAMPLE_TOKENS = 1024;

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * The factor the context length is divided by: the usage calibration (with
 * headroom) when there is one, raised to the overflow correction when the
 * provider has refused a prompt. Neither: 1.
 */
export function contextCorrectionFor(model: string): number {
  const overflow = corrections.get(model);
  const ratio = calibrations.get(model);
  const calibrated =
    ratio === undefined
      ? undefined
      : clamp(ratio * CORRECTION_HEADROOM, MIN_CALIBRATION, MAX_CALIBRATION);
  if (overflow === undefined) return calibrated ?? MIN_CORRECTION;
  return Math.max(overflow, calibrated ?? MIN_CORRECTION);
}

/** The overflow path: a refusal's correction. Never lowers what was learned. */
export function learnContextCorrection(model: string, factor: number): void {
  corrections.set(
    model,
    clamp(
      Math.max(corrections.get(model) ?? MIN_CORRECTION, factor),
      MIN_CORRECTION,
      MAX_CORRECTION,
    ),
  );
}

/** The smoothed usage ratio for a model, undefined before any usage. */
export function tokenCalibrationFor(model: string): number | undefined {
  return calibrations.get(model);
}

/**
 * The usage path: fold one answered request into the model's ratio. The
 * first sample is taken as it is, later ones are smoothed, and the result is
 * clamped to [MIN_CALIBRATION, MAX_CALIBRATION]. A missing count, a prompt
 * too small to say anything, or a sample outside [0.7, 1.5] times the current
 * ratio is ignored. Returns the ratio after the sample.
 */
export function learnTokenCalibration(
  model: string,
  providerTokens: number | undefined,
  estimatedTokens: number,
): number | undefined {
  if (
    !providerTokens ||
    !(providerTokens > 0) ||
    !(estimatedTokens >= MIN_CALIBRATION_SAMPLE_TOKENS)
  ) {
    return calibrations.get(model);
  }
  const sample = providerTokens / estimatedTokens;
  const previous = calibrations.get(model);
  if (
    previous !== undefined &&
    (sample < previous * MIN_SAMPLE_RELATIVE ||
      sample > previous * MAX_SAMPLE_RELATIVE)
  ) {
    return previous;
  }
  const smoothed =
    previous === undefined
      ? sample
      : previous + CALIBRATION_SMOOTHING * (sample - previous);
  const ratio = clamp(smoothed, MIN_CALIBRATION, MAX_CALIBRATION);
  calibrations.set(model, ratio);
  return ratio;
}

export function resetContextCorrections(): void {
  corrections.clear();
  calibrations.clear();
}

/**
 * The context length to prune to: the configured one over the correction.
 * Undefined (the model's default applies downstream) stays undefined.
 */
export function correctedContextLength(
  contextLength: number | undefined,
  model: string,
): number | undefined {
  if (contextLength === undefined) return undefined;
  return Math.floor(contextLength / contextCorrectionFor(model));
}
