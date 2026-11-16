import { describe, expect, it } from "vitest";

import metrics from "../llm/__fixtures__/strata/metrics-2026-11-15-live.trimmed.json";
import session from "../llm/__fixtures__/strata/session-compaction.json";
import {
  estimateCompaction,
  planSizesFrom,
  speedsFromStrataMetrics,
} from "./compactionEstimate";

/**
 * C108's fixture test (the note's section 7): the estimate against the usage
 * the chat recorded. Each forced re-read of the session is what "do
 * nothing" costs at that turn; the estimate, made from the speeds of the
 * session's other requests and the sizes the usage gives (head: the cached
 * root; the rest: what came after it), must land within 15% of the recorded
 * time and 5% of the recorded tokens.
 */
const rereads = session.requests.filter(
  (r) => r.usage.cachedTokens === session.head,
);

describe("the Compact now estimate against a recorded session", () => {
  it("has the forced re-reads the note describes", () => {
    expect(rereads.length).toBeGreaterThanOrEqual(8);
    expect(session.window).toBe(524_288);
  });

  it.each(rereads.map((r) => [r.id, r] as const))(
    "re-read %s: within 15%% of its time and 5%% of its tokens",
    (_id, request) => {
      const speeds = speedsFromStrataMetrics(metrics, { except: request.id })!;
      expect(speeds).toBeDefined();
      const afterHead = request.usage.promptTokens - request.usage.cachedTokens;
      // The planner's sizes at that turn: the tail budget of D3 (64k) kept,
      // the rest the span; "do nothing" reads both again either way
      const tail = Math.min(65_536, afterHead);
      const estimate = estimateCompaction({
        plan: planSizesFrom({
          headTokens: request.usage.cachedTokens,
          spanTokens: afterHead - tail,
          tailTokens: tail,
        }),
        cache: "warm",
        speeds,
      });
      const readTokens =
        request.usage.promptTokens - request.usage.cachedTokens;
      expect(
        Math.abs(estimate.doNothing.freshTokens.low - readTokens) / readTokens,
      ).toBeLessThanOrEqual(0.05);
      const seconds = request.promptMs / 1000;
      expect(
        Math.abs(estimate.doNothing.value.low - seconds) / seconds,
      ).toBeLessThanOrEqual(0.15);
    },
  );

  it("records no compaction yet: that is the C106 live check's capture", () => {
    expect(session.afterCompaction).toBeNull();
  });

  it.todo(
    "the switch-over after a live compaction (pre-warmed and not) is within 15% of its recorded time and 5% of its tokens",
  );
});
