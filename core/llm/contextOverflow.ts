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
  // Bedrock Converse, other families: "Input is too long for requested model"
  {
    re: /input is too long|too many input tokens|context[_ ]length[_ ]exceeded|exceeds? the (?:model'?s )?(?:maximum )?context (?:window|length)/i,
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

/** Learned corrections, by model, for the life of the process. */
const corrections = new Map<string, number>();

export function contextCorrectionFor(model: string): number {
  return corrections.get(model) ?? MIN_CORRECTION;
}

export function learnContextCorrection(model: string, factor: number): void {
  corrections.set(
    model,
    Math.min(MAX_CORRECTION, Math.max(contextCorrectionFor(model), factor)),
  );
}

export function resetContextCorrections(): void {
  corrections.clear();
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
