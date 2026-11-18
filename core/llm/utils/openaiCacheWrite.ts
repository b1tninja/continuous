/**
 * OpenAI cache write pricing, GPT-5.6 and later. Verified 2026-11-11 against
 * https://developers.openai.com/api/docs/guides/prompt-caching ("For GPT-5.6
 * and later, cache writes cost 1.25x the standard, uncached input-token rate
 * for the default 30-minute lifetime"; "12h" costs 2.5x) and the Standard
 * table of https://developers.openai.com/api/docs/pricing, which lists
 * "30m write" and "12h write" columns for exactly these models (earlier models
 * show "-"). Writes are not an extra fee on top of input: each token is
 * billed at one rate, so the written tokens come out of the plain input.
 */
export const OPENAI_WRITE_30M_MULTIPLIER = 1.25;
export const OPENAI_WRITE_12H_MULTIPLIER = 2.5;

export interface OpenAIWriteRates {
  /** Per MTok, 30-minute lifetime (the default). */
  cacheWrite: number;
  /** Per MTok, 12-hour lifetime. */
  cacheWrite12h: number;
}

/** Write rates for a model whose input price is `input`, per MTok. */
export function openAIWriteRates(input: number): OpenAIWriteRates {
  return {
    cacheWrite: input * OPENAI_WRITE_30M_MULTIPLIER,
    cacheWrite12h: input * OPENAI_WRITE_12H_MULTIPLIER,
  };
}

/**
 * The cost of the written part of a prompt and its breakdown lines. `written`
 * must already be capped at the uncached input; `written12h` is the part of
 * it that used the 12-hour lifetime (the rest is billed at the 30-minute
 * rate).
 */
export function openAIWriteCost(
  rates: OpenAIWriteRates,
  written: number,
  written12h: number,
): { tokens: number; cost: number; lines: string[] } {
  const w12 = Math.min(written12h, written);
  const w30 = written - w12;
  const lines: string[] = [];
  let cost = 0;
  for (const [label, n, rate] of [
    ["30m", w30, rates.cacheWrite],
    ["12h", w12, rates.cacheWrite12h],
  ] as const) {
    if (n <= 0) continue;
    const c = (n / 1_000_000) * rate;
    cost += c;
    lines.push(
      `Cache write (${label}): ${n.toLocaleString()} tokens × $${rate}/MTok = $${c.toFixed(6)}`,
    );
  }
  return { tokens: written, cost, lines };
}
