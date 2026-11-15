import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatSummary,
  runProbe,
  summarizeProbe,
  toCsv,
  type ProbeArm,
  type ProbeProvider,
} from "./cacheProbe";

/**
 * Runs the reviewer cache probe against a real model. Skipped unless
 * REVIEWER_PROBE_RUN=1 and RUN_LIVE_PROVIDER_TESTS=1, which only
 * `scripts/reviewerCacheProbe.mjs --run` sets, so CI never calls a model. Run
 * it through that script, not directly.
 */
const run =
  process.env.REVIEWER_PROBE_RUN === "1" &&
  process.env.RUN_LIVE_PROVIDER_TESTS === "1";

describe.skipIf(!run)(
  `reviewer cache probe (live model)${run ? "" : " (skipped: run it through scripts/reviewerCacheProbe.mjs --run)"}`,
  () => {
    it(
      "replays a session through each arm and prints the table",
      async () => {
        const provider = process.env.REVIEWER_PROBE_PROVIDER as ProbeProvider;
        const model = process.env.REVIEWER_PROBE_MODEL!;
        const rows = await runProbe({
          target: {
            provider,
            model,
            baseUrl: process.env.REVIEWER_PROBE_BASE_URL || undefined,
            region: process.env.REVIEWER_PROBE_REGION || undefined,
            ttl: process.env.REVIEWER_PROBE_TTL === "1h" ? "1h" : undefined,
          },
          credential: process.env.REVIEWER_PROBE_CREDENTIAL ?? "",
          arms: (process.env.REVIEWER_PROBE_ARMS ?? "A,B,C").split(
            ",",
          ) as ProbeArm[],
          calls: Number(process.env.REVIEWER_PROBE_CALLS ?? 60),
          gapMs: Number(process.env.REVIEWER_PROBE_GAP_MS ?? 2000),
        });
        process.stdout.write(
          `\n${formatSummary(`${provider}:${model}`, summarizeProbe(rows))}\n`,
        );
        if (process.env.REVIEWER_PROBE_OUT) {
          writeFileSync(process.env.REVIEWER_PROBE_OUT, `${toCsv(rows)}\n`);
        }
        expect(rows.length).toBeGreaterThan(0);
      },
      8 * 60 * 60_000,
    );
  },
);
