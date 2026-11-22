import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROMPT_PROFILES, type PromptProfile } from "../turns";
import { modelFromEnv } from "./adapters";
import { GUIDANCE_CASES } from "./guidanceCases";
import {
  formatReplayReport,
  REPLAY_TEMPERATURE,
  runGuidanceReplay,
} from "./guidanceReplay";
import type { ReasoningEffort } from "./runner";
import { repeatModel, replayOracleModel, textOnlyModel } from "./stubs";

/**
 * Runs the guidance replay against a model or a stand-in. Skipped unless
 * TURNS_EVAL_STUB is set, or TURNS_EVAL_MODEL with RUN_LIVE_PROVIDER_TESTS=1
 * (the wrapper sets both), so a plain test run never calls a model.
 *
 * Normally run it through the wrapper:
 *
 *   cd core && npm run eval:turns -- --replay --ollama --model <name> --runs 10
 *
 * It reads the variables live.vitest.ts reads (provider, model, base URL,
 * key, reasoning, max tokens, out, dump, result), with these differences:
 *   TURNS_EVAL_RUNS=<n>              trials of every case under every arm (default 1)
 *   TURNS_EVAL_PROFILES=<one>        the act turn text sent as the system message (default full)
 *   TURNS_EVAL_TEMPERATURE=<0..2>    default 0.7, so that trials differ
 *   TURNS_EVAL_STUB=oracle|repeat|text-only
 *   TURNS_EVAL_OUT=<path>            default: a file under the temp directory, never the repository
 *
 * The test passes whatever the rates are; read the report.
 */
const model =
  process.env.RUN_LIVE_PROVIDER_TESTS === "1"
    ? process.env.TURNS_EVAL_MODEL
    : undefined;
const stub = process.env.TURNS_EVAL_STUB;

function pickModel() {
  if (stub) {
    return {
      label: `stub:${stub}`,
      model:
        stub === "oracle"
          ? replayOracleModel(GUIDANCE_CASES)
          : stub === "repeat"
            ? repeatModel
            : textOnlyModel,
    };
  }
  return modelFromEnv();
}

function pickProfile(): PromptProfile {
  const first = (process.env.TURNS_EVAL_PROFILES ?? "").split(",")[0].trim();
  return (PROMPT_PROFILES as readonly string[]).includes(first)
    ? (first as PromptProfile)
    : "full";
}

function pickReasoning(): ReasoningEffort | undefined {
  const raw = process.env.TURNS_EVAL_REASONING;
  return raw === "low" || raw === "medium" || raw === "high" ? raw : undefined;
}

describe.skipIf(!model && !stub)(
  `guidance replay${model || stub ? "" : " (skipped: set TURNS_EVAL_STUB, or TURNS_EVAL_MODEL with RUN_LIVE_PROVIDER_TESTS=1)"}`,
  () => {
    it(
      "runs every case under every arm and writes the report",
      async () => {
        const { label, model: chat } = pickModel();
        const trials = Math.max(
          1,
          Number(process.env.TURNS_EVAL_RUNS ?? 1) || 1,
        );
        const rawTemperature = Number(process.env.TURNS_EVAL_TEMPERATURE);
        const temperature =
          process.env.TURNS_EVAL_TEMPERATURE && rawTemperature >= 0
            ? rawTemperature
            : REPLAY_TEMPERATURE;
        const results = await runGuidanceReplay(chat, {
          trials,
          profile: pickProfile(),
          model,
          temperature,
          concurrency: 2,
          timeoutMs: 300_000,
          maxTokens: Number(process.env.TURNS_EVAL_MAX_TOKENS) || undefined,
          reasoning: pickReasoning(),
        });
        const report = formatReplayReport(label, results, {
          temperature,
          stub: !!stub,
        });
        // Outside the repository unless a path is given
        const out =
          process.env.TURNS_EVAL_OUT ??
          join(
            tmpdir(),
            "guidance-replay",
            `${label.replace(/[^\w.-]+/g, "_")}.md`,
          );
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, report + "\n");
        // Written to stdout directly so the report is not swallowed by a reporter.
        process.stdout.write(`\n${report}\n\nReport written to ${out}\n`);
        if (process.env.TURNS_EVAL_DUMP) {
          writeFileSync(
            process.env.TURNS_EVAL_DUMP,
            JSON.stringify(
              results.map((r) => ({
                case: r.case.id,
                failureClass: r.case.failureClass,
                arm: r.arm,
                trial: r.trial,
                ms: r.ms,
                error: r.error,
                text: r.text,
                calls: r.calls,
                changed: r.changed,
                valid: r.valid,
                succeeded: r.succeeded,
                invalid: r.invalid,
                leakedCall: r.leakedCall,
              })),
              null,
              2,
            ) + "\n",
          );
        }
        if (process.env.TURNS_EVAL_RESULT) {
          // The replay has no bar: it "passes" when every trial got a reply
          writeFileSync(
            process.env.TURNS_EVAL_RESULT,
            JSON.stringify({ passed: results.every((r) => !r.error) }),
          );
        }
        expect(results.length).toBeGreaterThan(0);
      },
      60 * 60_000,
    );
  },
);
