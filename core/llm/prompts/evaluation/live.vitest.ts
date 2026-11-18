import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROMPT_PROFILES, type PromptProfile } from "../turns";
import type { ReasoningEffort } from "./runner";
import {
  anthropicMessages,
  bedrockConverse,
  openAiCompatible,
} from "./adapters";
import { formatReport, PROFILES, runTurnsEval, summarize } from "./runner";
import { TURN_SCENARIOS } from "./scenarios";
import { oracleModel, textOnlyModel } from "./stubs";

/**
 * Runs the turn-prompt evaluation against a real model. Skipped unless
 * TURNS_EVAL_STUB is set, or TURNS_EVAL_MODEL with RUN_LIVE_PROVIDER_TESTS=1
 * (the wrapper sets both), so CI never calls a model.
 *
 * Normally run it through the wrapper, which adds flags, a check before
 * calling a hosted API, and an exit code:
 *
 *   cd core && npm run eval:turns -- --ollama --model qwen2.5-coder:7b
 *
 * Or directly, with:
 *   TURNS_EVAL_PROVIDER=openai|anthropic|bedrock   (default openai; use openai for Ollama/LM Studio)
 *   TURNS_EVAL_MODEL=<model id>
 *   TURNS_EVAL_BASE_URL=<for openai-compatible, e.g. http://localhost:11434/v1>
 *   TURNS_EVAL_API_KEY=<key, if the provider needs one>
 *   TURNS_EVAL_REGION=<bedrock region, default us-east-1>
 *   TURNS_EVAL_AWS_PROFILE=<bedrock: a profile in ~/.aws/config, else the default chain>
 *   TURNS_EVAL_DUMP=<optional path; every reply (text, calls, failures) as JSON>
 *   TURNS_EVAL_PROFILES=full,short,tailored   (default full,short; tailored reads the model id)
 *   TURNS_EVAL_REASONING=off|low|medium|high   (default off: no reasoning fields sent)
 *   TURNS_EVAL_RUNS=<n>                     (default 1; the bar is then a rate over all runs)
 *   TURNS_EVAL_MAX_TOKENS=<n>               (default 4000; Bedrock counts reasoning tokens against it)
 *   TURNS_EVAL_OUT=<optional path for the markdown report>
 *   TURNS_EVAL_RESULT=<optional path; gets {"passed": boolean} as JSON>
 *   TURNS_EVAL_STUB=oracle|text-only       (stand-in instead of a model)
 *
 *   npx vitest run llm/prompts/evaluation/live.vitest.ts
 *
 * The test passes whatever the result; read the printed report, or use the
 * wrapper's --strict for an exit code.
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
      model: stub === "oracle" ? oracleModel(TURN_SCENARIOS) : textOnlyModel,
    };
  }
  const provider = process.env.TURNS_EVAL_PROVIDER ?? "openai";
  const apiKey = process.env.TURNS_EVAL_API_KEY ?? "";
  return {
    label: `${provider}:${model}`,
    model:
      provider === "bedrock"
        ? bedrockConverse({
            model: model!,
            region: process.env.TURNS_EVAL_REGION ?? "us-east-1",
            profile: process.env.TURNS_EVAL_AWS_PROFILE,
          })
        : provider === "anthropic"
          ? anthropicMessages({
              model: model!,
              apiKey,
              baseUrl: process.env.TURNS_EVAL_BASE_URL,
            })
          : openAiCompatible({
              model: model!,
              apiKey: apiKey || undefined,
              baseUrl:
                process.env.TURNS_EVAL_BASE_URL ?? "https://api.openai.com/v1",
            }),
  };
}

function pickReasoning(): ReasoningEffort | undefined {
  const raw = process.env.TURNS_EVAL_REASONING;
  return raw === "low" || raw === "medium" || raw === "high" ? raw : undefined;
}

function pickProfiles(): readonly PromptProfile[] {
  const raw = process.env.TURNS_EVAL_PROFILES;
  if (!raw) return PROFILES;
  const chosen = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is PromptProfile =>
      (PROMPT_PROFILES as readonly string[]).includes(s),
    );
  return chosen.length ? chosen : PROFILES;
}

describe.skipIf(!model && !stub)(
  `turn prompt evaluation (live model)${model || stub ? "" : " (skipped: set TURNS_EVAL_STUB, or TURNS_EVAL_MODEL with RUN_LIVE_PROVIDER_TESTS=1)"}`,
  () => {
    it(
      "runs every scenario under each profile and prints the report",
      async () => {
        const { label, model: chat } = pickModel();
        const profiles = pickProfiles();
        const reasoning = pickReasoning();
        const runs = Math.max(1, Number(process.env.TURNS_EVAL_RUNS ?? 1) || 1);
        const maxTokens =
          Number(process.env.TURNS_EVAL_MAX_TOKENS) || undefined;
        const results = await runTurnsEval(chat, {
          profiles,
          concurrency: 2,
          timeoutMs: 300_000,
          reasoning,
          model,
          runs,
          maxTokens,
        });
        const summary = summarize(results, undefined, profiles);
        const report = formatReport(
          [
            label,
            reasoning ? `reasoning ${reasoning}` : "",
            maxTokens ? `${maxTokens} max tokens` : "",
          ]
            .filter(Boolean)
            .join(", "),
          results,
          summary,
          undefined,
          maxTokens,
        );
        // Written to stdout directly so the report is not swallowed by a reporter.
        process.stdout.write(`\n${report}\n`);
        if (process.env.TURNS_EVAL_OUT) {
          writeFileSync(process.env.TURNS_EVAL_OUT, report + "\n");
        }
        if (process.env.TURNS_EVAL_DUMP) {
          writeFileSync(
            process.env.TURNS_EVAL_DUMP,
            JSON.stringify(
              results.map((r) => ({
                scenario: r.scenario.id,
                profile: r.profile,
                run: r.run,
                ms: r.ms,
                error: r.error,
                text: r.text,
                calls: r.calls,
                failures: r.failures,
              })),
              null,
              2,
            ) + "\n",
          );
        }
        if (process.env.TURNS_EVAL_RESULT) {
          writeFileSync(
            process.env.TURNS_EVAL_RESULT,
            JSON.stringify({ passed: summary.passed }),
          );
        }
        expect(results.length).toBeGreaterThan(0);
      },
      30 * 60_000,
    );
  },
);
