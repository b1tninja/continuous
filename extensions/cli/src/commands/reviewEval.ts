/**
 * `continuous reviewer eval --dataset <file> --reviewer <model-role>
 * [--guidance <file>] [--compare <file>] [--config <file>] [--repeat <k>]
 * [--max-tokens <n>] [--outcomes <file>] [--run] [--json]`
 *
 * Scores a reviewer configuration (model plus prompt guidance) over a labelled
 * set of tool calls. The default is a dry run: it assembles the messages,
 * prints a cost plan and calls nothing. `--run` sends the requests.
 * See plans/reviewer-eval-gate.md.
 */

import { readFileSync, writeFileSync } from "node:fs";

import type { Command } from "commander";
import {
  datasetFormat,
  parseDataset,
  parseGuidance,
  type ReviewDataset,
} from "core/tools/permissions/auto/evaluation/reviewEvalDataset.js";
import { scoreRuns } from "core/tools/permissions/auto/evaluation/reviewEvalRepeat.js";
import {
  formatCostPlan,
  formatGate,
  formatMetrics,
  formatPaired,
  outcomeLines,
} from "core/tools/permissions/auto/evaluation/reviewEvalReport.js";
import {
  planCost,
  runReviewEval,
  type CostPlan,
  type PlanModel,
  type ReviewerClient,
  type ReviewerConfig,
} from "core/tools/permissions/auto/evaluation/reviewEvalRun.js";
import {
  comparePaired,
  gate,
  type GateResult,
  type Metrics,
  type Paired,
} from "core/tools/permissions/auto/evaluation/reviewEvalScore.js";

/**
 * The root program also defines `--config` and commander lets it take the flag
 * wherever it appears, so the subcommand's own copy stays empty. Read it from
 * the parent when the subcommand has none.
 */
export function withRootConfig<T extends { config?: string }>(
  options: T,
  command: { parent?: { opts(): { config?: string } } | null },
): T {
  if (options.config) return options;
  const config = command.parent?.opts().config;
  return config ? { ...options, config } : options;
}

export interface ReviewEvalOptions {
  dataset?: string;
  /** A model name or the `reviewer` role (the default). */
  reviewer?: string;
  /** Guidance to try; absent is the built-in prompt alone. */
  guidance?: string;
  /** Baseline guidance file, or `default` for the built-in prompt alone. */
  compare?: string;
  /** Opaque id of a per-reviewer-model profile (a later slice). */
  profile?: string;
  /** `v3`: measure the tightened reviewer prompt as the candidate (--compare keeps the shipped one). */
  prompt?: string;
  /** Send the requests. Without it nothing is called. */
  run?: boolean;
  /** `false` (--no-prefilter) leaves the addressed-text check out. */
  prefilter?: boolean;
  json?: boolean;
  concurrency?: number | string;
  timeoutMs?: number | string;
  /** A config file to load the reviewer model from (like the other commands). */
  config?: string;
  /** Times each case is asked; the floor gate takes the union. Default 1. */
  repeat?: number | string;
  /** Reply ceiling: 1024 for a model that reasons, else 300. */
  maxTokens?: number | string;
  /** Write every case's outcome as JSONL to this file. */
  outcomes?: string;
}

export interface ReviewEvalDeps {
  readFile: (path: string) => string;
  /** Build the reviewer client; only called with --run. */
  createClient: (
    reviewer: string | undefined,
    configPath: string | undefined,
  ) => Promise<{
    client: ReviewerClient;
    model: string;
    plan?: PlanModel;
  } | null>;
  /** Name the model for the dry-run plan (price, reasoning); null if unknown. */
  describeModel: (
    reviewer: string | undefined,
    configPath: string | undefined,
  ) => Promise<PlanModel | null>;
  writeFile: (path: string, text: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** The assistant and the reviewer model it names, without building a client. */
async function loadReviewer(
  reviewer: string | undefined,
  configPath: string | undefined,
) {
  const { initializeServices, getService, SERVICE_NAMES } =
    await import("../services/index.js");
  const { reviewerModel } = await import("../permissions/coreRules.js");
  await initializeServices({
    headless: true,
    skipOnboarding: true,
    ...(configPath ? { options: { config: configPath } } : {}),
  });
  const state = await getService<
    import("../services/types.js").ModelServiceState
  >(SERVICE_NAMES.MODEL);
  // authConfig is null for a person who has not signed in; the model client
  // does not use it, so a local config.yaml is enough.
  if (!state?.assistant) return null;
  const assistant =
    reviewer && reviewer !== "reviewer"
      ? ({
          ...state.assistant,
          modeModels: { reviewer: { model: reviewer } },
        } as typeof state.assistant)
      : state.assistant;
  const model = reviewerModel(assistant);
  if (!model) return null;
  const plan: PlanModel = {
    provider: model.provider ?? "",
    model: model.model,
    reasoning: (model as { defaultCompletionOptions?: { reasoning?: boolean } })
      .defaultCompletionOptions?.reasoning,
  };
  return { state, assistant, model, plan };
}

async function defaultDescribeModel(
  reviewer: string | undefined,
  configPath: string | undefined,
): Promise<PlanModel | null> {
  try {
    return (await loadReviewer(reviewer, configPath))?.plan ?? null;
  } catch {
    return null;
  }
}

/** A reviewer client from the user's own assistant, as `Auto` builds it. */
async function defaultCreateClient(
  reviewer: string | undefined,
  configPath: string | undefined,
) {
  const loaded = await loadReviewer(reviewer, configPath);
  if (!loaded) return null;
  const { createReviewer } = await import("../permissions/coreRules.js");
  const client = createReviewer(
    loaded.assistant,
    loaded.state.authConfig as Parameters<typeof createReviewer>[1],
  );
  if (!client) return null;
  return {
    client,
    model: loaded.model.name ?? loaded.model.model,
    plan: loaded.plan,
  };
}

const defaultDeps: ReviewEvalDeps = {
  readFile: (p) => readFileSync(p, "utf8"),
  createClient: defaultCreateClient,
  describeModel: defaultDescribeModel,
  writeFile: (p, t) => writeFileSync(p, t, "utf8"),
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

function guidanceConfig(
  path: string | undefined,
  deps: ReviewEvalDeps,
  fallbackLabel: string,
  profile?: string,
): ReviewerConfig {
  const base = profile ? { profile } : {};
  if (!path || path === "default") {
    return { label: fallbackLabel, ...base };
  }
  return {
    label: path,
    guidance: parseGuidance(deps.readFile(path), path),
    ...base,
  };
}

function toNumber(v: number | string | undefined, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : v;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `--prompt v3` puts the tightened prompt on the candidate; the baseline keeps the shipped one. */
function applyPrompt(opts: ReviewEvalOptions, candidate: ReviewerConfig): void {
  if (opts.prompt === undefined) return;
  if (opts.prompt !== "v3" && opts.prompt !== "default") {
    throw new Error("--prompt takes default or v3.");
  }
  if (opts.prompt === "v3") {
    candidate.promptVariant = "v3";
    if (!opts.guidance || opts.guidance === "default") {
      candidate.label = "built-in prompt v3";
    }
  }
}

function summaryLine(dataset: ReviewDataset): string {
  const floor = dataset.cases.filter((c) => c.floor).length;
  return `Dataset ${dataset.name}: ${dataset.cases.length} cases, ${floor} floor, ${dataset.cases.length - floor} open middle.`;
}

interface Finished {
  plan: CostPlan;
  metrics: Metrics;
  baseline?: { metrics: Metrics; paired: Paired };
  gate: GateResult;
}

function render(
  opts: ReviewEvalOptions,
  deps: ReviewEvalDeps,
  configs: ReviewerConfig[],
  model: string,
  f: Finished,
): void {
  if (opts.json) {
    deps.out(
      JSON.stringify(
        {
          dryRun: false,
          reviewer: model,
          plan: f.plan,
          candidate: { label: configs[0].label, profile: configs[0].profile },
          metrics: f.metrics,
          ...(f.baseline
            ? {
                baseline: {
                  label: configs[1].label,
                  metrics: f.baseline.metrics,
                },
                paired: f.baseline.paired,
              }
            : {}),
          gate: f.gate,
        },
        null,
        2,
      ),
    );
    return;
  }
  deps.out(`Reviewer: ${model}\n`);
  deps.out(formatMetrics(`Candidate: ${configs[0].label}`, f.metrics));
  if (f.baseline) {
    deps.out(
      `\n${formatMetrics(`Baseline: ${configs[1].label}`, f.baseline.metrics)}`,
    );
    deps.out(`\n### Paired comparison\n\n${formatPaired(f.baseline.paired)}`);
  }
  deps.out(`\n### Gate\n\n${formatGate(f.gate)}`);
}

/** Returns the exit code: 0, 1 when the gate fails or an error stops the run. */
export async function reviewEvalCommand(
  opts: ReviewEvalOptions,
  deps: ReviewEvalDeps = defaultDeps,
): Promise<number> {
  if (!opts.dataset) {
    deps.err("reviewer eval needs --dataset <file>.");
    return 1;
  }
  let dataset: ReviewDataset;
  let configs: ReviewerConfig[];
  try {
    dataset = parseDataset(
      deps.readFile(opts.dataset),
      datasetFormat(opts.dataset),
    );
    configs = [
      guidanceConfig(opts.guidance, deps, "built-in prompt", opts.profile),
    ];
    if (opts.compare) {
      configs.push(
        guidanceConfig(opts.compare, deps, "built-in prompt", opts.profile),
      );
    }
    applyPrompt(opts, configs[0]);
    if (opts.prefilter === false) {
      for (const c of configs) c.prefilter = false;
    }
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
  const concurrency = toNumber(opts.concurrency, 4);
  const repeat = Math.floor(toNumber(opts.repeat, 1));
  const planOptions = (model: PlanModel | null | undefined) => ({
    ...(model ? { model } : {}),
    ...(opts.maxTokens ? { maxTokens: toNumber(opts.maxTokens, 300) } : {}),
    repeat,
  });
  const reviewerName = opts.reviewer ?? "reviewer";

  if (!opts.run) {
    const model = await deps.describeModel(opts.reviewer, opts.config);
    const plan = planCost(dataset, configs, concurrency, planOptions(model));
    if (opts.json) {
      deps.out(
        JSON.stringify({ dryRun: true, plan, cases: dataset.cases.length }),
      );
    } else {
      deps.out(summaryLine(dataset));
      deps.out(formatCostPlan(plan, reviewerName));
    }
    return 0;
  }

  const made = await deps.createClient(opts.reviewer, opts.config);
  if (!made) {
    deps.err(
      "No reviewer model is configured. Add one with the reviewer role" +
        (opts.config ? ` in ${opts.config}.` : ", or pass --config <file>."),
    );
    return 1;
  }
  const plan = planCost(dataset, configs, concurrency, planOptions(made.plan));
  if (!opts.json) deps.out(formatCostPlan(plan, reviewerName));
  const runOpts = {
    concurrency,
    timeoutMs: toNumber(opts.timeoutMs, 30_000),
    maxTokens: plan.maxTokens,
    repeat,
  };
  // Sequential, so a baseline never competes with the candidate for rate limits.
  const candidateRun = await runReviewEval(
    made.client,
    dataset,
    configs[0],
    runOpts,
  );
  const metrics = scoreRuns(dataset.cases, candidateRun.runs);
  const lines = outcomeLines(
    dataset.cases,
    candidateRun.runs,
    configs[0].label,
  );
  let baseline: Finished["baseline"];
  if (configs[1]) {
    const baselineRun = await runReviewEval(
      made.client,
      dataset,
      configs[1],
      runOpts,
    );
    baseline = {
      metrics: scoreRuns(dataset.cases, baselineRun.runs),
      paired: comparePaired(
        dataset.cases,
        baselineRun.outcomes,
        candidateRun.outcomes,
      ),
    };
    lines.push(
      ...outcomeLines(dataset.cases, baselineRun.runs, configs[1].label),
    );
  }
  if (opts.outcomes) {
    try {
      deps.writeFile(opts.outcomes, `${lines.join("\n")}\n`);
    } catch (e) {
      deps.err(
        `Could not write ${opts.outcomes}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const verdict = gate(dataset.cases, metrics, baseline);
  render(opts, deps, configs, made.model, {
    plan,
    metrics,
    baseline,
    gate: verdict,
  });
  return verdict.verdict === "not safe to adopt" ? 1 : 0;
}

/** Registers `reviewer [action]` on the program; `exit` ends the process. */
export function registerReviewerCommand(
  program: Command,
  exit: (code: number) => Promise<void> | void,
  run: (opts: ReviewEvalOptions) => Promise<number> = reviewEvalCommand,
): void {
  program
    .command("reviewer [action]")
    .description(
      "Work with the reviewer model: eval scores a reviewer model and prompt guidance over a labelled set of tool calls (dry run unless --run)",
    )
    .option("--dataset <file>", "Labelled cases (JSON or YAML)")
    .option(
      "--reviewer <model-role>",
      "Reviewer model name or role",
      "reviewer",
    )
    .option("--guidance <file>", "Guidance to try (JSON, YAML or text)")
    .option(
      "--compare <file>",
      "Baseline guidance file, or `default` for the built-in prompt, to compare against",
    )
    .option("--profile <id>", "Reviewer profile id (carried into the report)")
    .option(
      "--prompt <variant>",
      "Reviewer prompt for the candidate: default or v3 (the tightened prompt)",
    )
    .option("--run", "Call the model; without it nothing is sent")
    .option(
      "--no-prefilter",
      "Leave out the check for text addressed to the reviewer, to measure the model alone",
    )
    .option("--json", "Machine-readable output")
    .option("--concurrency <n>", "Parallel requests", "4")
    .option("--timeout-ms <n>", "Per-request timeout", "30000")
    .option("--config <path>", "Config file that defines the reviewer model")
    .option("--repeat <k>", "Ask each case k times (floor gate: union)", "1")
    .option("--max-tokens <n>", "Reply ceiling (1024 if it reasons, else 300)")
    .option("--outcomes <file>", "Write every case's outcome as JSONL")
    .action(async (action: string | undefined, options, command: Command) => {
      options = withRootConfig(options, command);
      if (action !== "eval") {
        console.error(
          "Usage: continuous reviewer eval --dataset <file> [options]",
        );
        await exit(1);
        return;
      }
      const code = await run(options);
      await exit(code);
    });
}
