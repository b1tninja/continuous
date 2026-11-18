import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findModelPricing } from "../llm/utils/calculateRequestCost";
import {
  type CompactionPlanSizes,
  compactionPricesFrom,
  estimateCompaction,
  formatCompactionEstimate,
  planSizesFrom,
  speedsFromStrataMetrics,
} from "./compactionEstimate";

const fixture = (name: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "llm", "__fixtures__", "strata", name),
      "utf8",
    ),
  );

/** Strata /metrics at 14:06 on 2026-11-15: decode_tok_s and long re-reads. */
const LIVE = fixture("metrics-2026-11-15-live.trimmed.json");
/** The same server earlier that day, before it reported decode_tok_s. */
const EARLIER = fixture("metrics-2026-11-15.trimmed.json");

/**
 * The owner's case (plans/research/cache-friendly-context-trimming.md
 * section 5): a 407k prompt, a 16k head, a 52k tail kept verbatim, a 6k
 * summary.
 */
const OWNER: CompactionPlanSizes = {
  head: 16_000,
  span: 407_000 - 16_000 - 52_000,
  tail: 52_000,
};

const prices = (model: string) => {
  const pricing = findModelPricing(model);
  if (!pricing) throw new Error(`no price for ${model}`);
  return compactionPricesFrom(pricing);
};

const within = (actual: number, expected: number, share: number) => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * share,
  );
};

describe("estimateCompaction on a cloud provider (dollars)", () => {
  it("gives the section 5 figures on Opus 5.5", () => {
    const e = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: prices("claude-opus-5-5"),
    });
    expect(e.unit).toBe("usd");
    expect(e.label).toBe("estimate");
    // The summary reads 407k from the cache ($0.081) and writes 6k ($0.12)
    within(e.summary.value.low, 0.2, 0.05);
    expect(e.summary.cachedTokens.low).toBe(407_000);
    expect(e.summary.outputTokens).toBe(6_000);
    // The switch writes the summary and the tail, 58k ($0.29)
    within(e.switchOver.value.low, 0.29, 0.03);
    expect(e.switchOver.freshTokens.low).toBe(58_000);
    expect(e.switchOver.cachedTokens.low).toBe(16_000);
    // Each later turn reads 74k instead of 407k from the cache
    within(e.perTurnSaving!.low, 0.067, 0.02);
    // (0.20 + 0.29) / 0.067: about 7 turns
    expect(Math.round(e.breakEvenTurns!.low)).toBe(7);
    // Doing nothing: a forced drop rewrites everything after the head
    expect(e.doNothing.freshTokens.low).toBe(391_000);
    within(e.doNothing.value.low, 1.98, 0.02);
    // Known cache state: no range
    expect(e.compactNow.low).toBe(e.compactNow.high);
  });

  it("gives the section 5 figures on Sonnet 5.5", () => {
    const e = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: prices("claude-sonnet-5-5"),
    });
    within(e.compactNow.low, 0.25, 0.03);
    within(e.perTurnSaving!.low, 0.033, 0.02);
    within(e.breakEvenTurns!.low, 7.5, 0.03);
    within(e.doNothing.value.low, 0.99, 0.02);
  });

  it("gives a range from warm to cold when the cache may have expired", () => {
    const opus = prices("claude-opus-5-5");
    const warm = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: opus,
    });
    const cold = estimateCompaction({
      plan: OWNER,
      cache: "cold",
      prices: opus,
    });
    const unknown = estimateCompaction({
      plan: OWNER,
      cache: "unknown",
      prices: opus,
    });
    expect(unknown.compactNow).toEqual({
      low: warm.compactNow.low,
      high: cold.compactNow.high,
    });
    // Cold: the whole conversation is written for the summary request
    expect(cold.summary.freshTokens.low).toBe(407_500);
    expect(cold.summary.cachedTokens.low).toBe(0);
    expect(unknown.summary.freshTokens).toEqual({ low: 500, high: 407_500 });
    expect(unknown.breakEvenTurns!.high).toBeGreaterThan(
      unknown.breakEvenTurns!.low,
    );
  });

  it("prices a cache write as plain input where there is no write premium", () => {
    const pricing = findModelPricing("claude-opus-5-5")!;
    const withPremium = compactionPricesFrom(pricing);
    const without = compactionPricesFrom(pricing, { writePremium: false });
    expect(withPremium.cacheWrite).toBe(5);
    expect(without.cacheWrite).toBe(4);
    const e = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: without,
    });
    within(e.switchOver.value.low, (58_000 * 4 + 16_000 * 0.2) / 1e6, 1e-9);
  });

  it("a pre-warm on a cloud provider moves the write earlier and changes no figure", () => {
    const opus = prices("claude-opus-5-5");
    const plain = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: opus,
    });
    const prewarmed = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: opus,
      prewarmed: true,
    });
    expect(prewarmed.compactNow).toEqual(plain.compactNow);
  });

  it("compares with dropping the oldest turns", () => {
    const e = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      prices: prices("claude-opus-5-5"),
      dropTokens: 84_000,
    });
    expect(e.dropOldest!.tokensLost).toBe(84_000);
    expect(e.dropOldest!.freshTokens.low).toBe(391_000 - 84_000);
    within(e.dropOldest!.value.low, (307_000 * 5 + 16_000 * 0.2) / 1e6, 1e-9);
  });

  it("has no saving when the summary is not shorter than what it replaces", () => {
    const e = estimateCompaction({
      plan: { head: 16_000, span: 4_000, tail: 52_000 },
      cache: "warm",
      prices: prices("claude-opus-5-5"),
    });
    expect(e.perTurnSaving).toBeUndefined();
    expect(e.breakEvenTurns).toBeUndefined();
  });
});

describe("estimateCompaction on a local server (seconds)", () => {
  const speeds = speedsFromStrataMetrics(LIVE)!;

  it("reads the speeds from Strata's /metrics", () => {
    // The median of the long re-reads, not the live mean of a read in progress
    within(speeds.prefillTokS, 4_600, 0.02);
    within(speeds.decodeTokS, 70, 0.1);
    const earlier = speedsFromStrataMetrics(EARLIER)!;
    // No decode_tok_s there: output over decode time
    within(earlier.prefillTokS, 1_300, 0.05);
    expect(earlier.decodeTokS).toBeGreaterThan(10);
    expect(speedsFromStrataMetrics({})).toBeUndefined();
    // No long read: the live mean
    expect(
      speedsFromStrataMetrics({
        live: { prefill_tok_s_mean: 5_000 },
        requests: [{ prompt_read: 100, prompt_ms: 900, decode_tok_s: 60 }],
      }),
    ).toEqual({ prefillTokS: 5_000, decodeTokS: 60 });
  });

  it("gives the C107 row's figures: 85 ± 5 s for a 394,717-token re-read, 12.5 ± 1 s for a 58k switch", () => {
    const e = estimateCompaction({
      plan: { head: 16_384, span: 394_717 - 52_000, tail: 52_000 },
      cache: "warm",
      speeds,
    });
    expect(e.unit).toBe("seconds");
    expect(Math.abs(e.doNothing.value.low - 85)).toBeLessThanOrEqual(5);
    expect(Math.abs(e.switchOver.value.low - 12.5)).toBeLessThanOrEqual(1);
    // The summary: the instruction read, 6k tokens written out at ~70/s
    within(e.summary.value.low, 6_000 / speeds.decodeTokS, 0.02);
  });

  it("costs nothing in the foreground once pre-warmed", () => {
    const e = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      speeds,
      prewarmed: true,
    });
    expect(e.switchOver.value).toEqual({ low: 0, high: 0 });
    expect(e.compactNow).toEqual(e.summary.value);
  });

  it("breaks even against the forced re-reads it avoids", () => {
    const e = estimateCompaction({
      plan: OWNER,
      cache: "warm",
      speeds,
      // Today: 8 re-reads in 12 requests (the live fixture)
      forcedRereadsPerTurn: 8 / 12,
    });
    const reread = 391_000 / speeds.prefillTokS;
    within(e.perTurnSaving!.low, (8 / 12) * reread, 1e-9);
    // About 100 s of compaction against about 57 s saved per turn: 2 turns
    expect(Math.round(e.breakEvenTurns!.low)).toBe(2);
    // Without a re-read rate the seconds cannot be weighed
    expect(
      estimateCompaction({ plan: OWNER, cache: "warm", speeds }).breakEvenTurns,
    ).toBeUndefined();
  });
});

describe("the estimate against what Strata recorded (fixture)", () => {
  // Each recorded request is predicted from the speeds of the others. A
  // forced drop and a switch-over without a pre-warm are both a read of
  // everything after the cached head; a summary request on a warm cache is a
  // short read and a long reply.
  const requests: any[] = LIVE.requests;
  const rereads = requests.filter((r) => r.prompt_read >= 100_000);
  const replies = requests.filter(
    (r) => r.prompt_read < 1_000 && r.output_tokens >= 500,
  );

  it("has the recordings it needs", () => {
    expect(rereads.length).toBe(8);
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });

  it.each(rereads.map((r) => [r.id, r]))(
    "re-read %s: within 15% of the time and 5% of the tokens",
    (id, r) => {
      const speeds = speedsFromStrataMetrics(LIVE, { except: id })!;
      const afterHead = r.prompt_tokens - r.reused;
      const e = estimateCompaction({
        plan: { head: r.reused, span: afterHead - 52_000, tail: 52_000 },
        cache: "warm",
        speeds,
      });
      within(e.doNothing.freshTokens.low, r.prompt_read, 0.05);
      within(e.doNothing.value.low, r.prompt_ms / 1000, 0.15);
    },
  );

  it.each(replies.map((r) => [r.id, r]))(
    "warm reply %s: within 15% of the time",
    (id, r) => {
      const speeds = speedsFromStrataMetrics(LIVE, { except: id })!;
      const e = estimateCompaction({
        plan: { head: 16_384, span: r.reused - 16_384, tail: 0 },
        cache: "warm",
        speeds,
        instructionTokens: r.prompt_read,
        summaryTokens: r.output_tokens,
      });
      expect(e.summary.freshTokens.low).toBe(r.prompt_read);
      within(e.summary.value.low, (r.prompt_ms + r.decode_ms) / 1000, 0.15);
    },
  );
});

describe("formatCompactionEstimate", () => {
  it("says what Compact now costs on Opus 5.5, in one line", () => {
    const opus = prices("claude-opus-5-5");
    expect(
      formatCompactionEstimate(
        estimateCompaction({ plan: OWNER, cache: "warm", prices: opus }),
      ),
    ).toBe(
      "Compact now (estimate): about $0.20 for the summary and $0.29 to rewrite the cache. Each later turn is about $0.07 cheaper, so it pays for itself after about 7 turns. Not compacting: the next forced drop rewrites about 391k tokens, about $1.96.",
    );
    expect(
      formatCompactionEstimate(
        estimateCompaction({ plan: OWNER, cache: "unknown", prices: opus }),
      ),
    ).toBe(
      "Compact now (estimate): about $0.20 for the summary and $0.29 to rewrite the cache ($0.50 to $2.53 if the cache has expired). Each later turn is about $0.07 cheaper, so it pays for itself after about 7 to 38 turns. Not compacting: the next forced drop rewrites about 391k tokens, about $1.96.",
    );
  });

  it("says what Compact now takes on a local server, in one line", () => {
    const speeds = { prefillTokS: 4_600, decodeTokS: 70 };
    expect(
      formatCompactionEstimate(
        estimateCompaction({ plan: OWNER, cache: "warm", speeds }),
      ),
    ).toBe(
      "Compact now (estimate): about 86 s in the background, then about 13 s once (0 s if prepared while you are away). Not compacting: about 85 s on each forced re-read.",
    );
    expect(
      formatCompactionEstimate(
        estimateCompaction({
          plan: OWNER,
          cache: "warm",
          speeds,
          prewarmed: true,
          forcedRereadsPerTurn: 0.5,
        }),
      ),
    ).toBe(
      "Compact now (estimate): about 86 s in the background, then nothing more at your next message (prepared while you were away). Not compacting: about 85 s on each forced re-read; compacting pays for itself after about 2 turns.",
    );
  });
});

describe("inputs", () => {
  it("needs prices or speeds", () => {
    expect(() => estimateCompaction({ plan: OWNER, cache: "warm" })).toThrow(
      /prices or speeds/,
    );
    expect(() =>
      estimateCompaction({
        plan: OWNER,
        cache: "warm",
        speeds: { prefillTokS: 0, decodeTokS: 70 },
      }),
    ).toThrow(/positive/);
  });

  it("adapts a planner's sizes", () => {
    expect(
      planSizesFrom({
        headTokens: 16_000,
        spanTokens: 339_000,
        tailTokens: -1,
      }),
    ).toEqual({ head: 16_000, span: 339_000, tail: 0 });
  });
});
