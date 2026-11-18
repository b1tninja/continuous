import type { ILLM } from "../../../..";
import { promptTokensExcludeCache } from "../../../../llm/utils/cacheStats";
import { costOf, type CostResult } from "../../../../util/costOf";
import { assembleGuidance, type EffectiveGuidance } from "../guidance";
import { parseReviewerReply } from "../parse";
import {
  buildReviewMessages,
  newNonce,
  reviewerPromptVersion,
} from "../prompt";
import { promptText, type ReviewerPromptVariant } from "../promptV3";
import { findReviewerAddressedText } from "../reviewerAddressed";
import { reviewCompletionOptions, ReviewerReasoning } from "../review";
import type {
  CaseEnvironment,
  GuidanceFile,
  LabelledCase,
  ReviewDataset,
} from "./reviewEvalDataset";

/** The only thing the runner needs from a model; tests pass a scripted fake. */
export type ReviewerClient = Pick<ILLM, "chat">;

/** One reviewer configuration: the model is the client, the rest is here. */
export interface ReviewerConfig {
  /** Shown in reports. */
  label: string;
  /** Prompt guidance to try; absent is the built-in prompt alone. */
  guidance?: GuidanceFile;
  /**
   * Opaque id of a per-reviewer-model profile (a later slice). The runner only
   * carries it into the result; it does not interpret it.
   */
  profile?: string;
  /** `v3` measures the tightened prompt (promptV3.ts); absent is the shipped one. */
  promptVariant?: ReviewerPromptVariant;
  reasoning?: ReviewerReasoning;
  /**
   * The deterministic check for text addressed to the reviewer, which in
   * production runs before the model. On unless `false`; a hit is an ask
   * and costs no call. Off only to measure the model and prompt alone.
   */
  prefilter?: boolean;
}

export interface CaseOutcome {
  id: string;
  decision: "allow" | "ask" | "deny";
  category?: string;
  reason: string;
  /** The reply could not be read; failed closed to ask. */
  formatFailure: boolean;
  /** The call failed or timed out (not a format problem); failed closed to ask. */
  error?: string;
  /** The model's reply as sent, cut to RAW_REPLY_MAX characters. */
  rawReply?: string;
  /** Why generation stopped, as the provider said (`length`, `stop`, ...). */
  finishReason?: string;
  /**
   * The output ceiling cut the reply off before a verdict (finish reason
   * length, with nothing readable). Also a format failure; reported
   * separately because the fix is a bigger ceiling, not a better prompt.
   */
  truncated: boolean;
  ms: number;
  /** The whole prompt: cache reads and writes are included for every provider. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Size of the assembled messages, for cost planning. */
  promptChars: number;
}

export const RAW_REPLY_MAX = 2000;

export interface RunResult {
  config: ReviewerConfig;
  /** What the reviewer was told, as the audit trail records it in production. */
  promptVersion: string;
  /** The first run. */
  outcomes: CaseOutcome[];
  /** Every run, the first included; one entry unless --repeat asked for more. */
  runs: CaseOutcome[][];
}

export interface RunOptions {
  concurrency?: number;
  timeoutMs?: number;
  /** Reply ceiling; defaults to `defaultMaxTokens(false)`. */
  maxTokens?: number;
  /** Times each case is asked (default 1). */
  repeat?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Guidance goes through the same validation production uses
 * (`assembleGuidance`). An entry that is refused is an error, not a dropped
 * line: a run without a "never" the person wrote would measure a looser
 * reviewer than the one that ships.
 */
export function resolveGuidance(config: Pick<ReviewerConfig, "guidance">): {
  guidance: EffectiveGuidance;
  errors: string[];
} {
  const { guidance, errors } = assembleGuidance(config.guidance);
  return { guidance, errors };
}

function validGuidance(
  config: Pick<ReviewerConfig, "guidance">,
): EffectiveGuidance {
  const { guidance, errors } = resolveGuidance(config);
  if (errors.length > 0) {
    throw new Error(`The guidance was refused. ${errors.join(" ")}`);
  }
  return guidance;
}

function merged(
  base: CaseEnvironment,
  over: CaseEnvironment | undefined,
): CaseEnvironment {
  return { ...base, ...(over ?? {}) };
}

/** The exact messages the reviewer would receive for one case. */
export function messagesFor(
  c: LabelledCase,
  dataset: Pick<ReviewDataset, "environment">,
  config: Pick<ReviewerConfig, "guidance" | "promptVariant">,
  nonce: string = newNonce(),
) {
  const env = merged(dataset.environment, c.environment);
  const environment: Record<string, unknown> = {};
  const settingsEnv: {
    trustedDomains?: string[];
    productionMarkers?: string[];
  } = {};
  if (env.os) environment.os = env.os;
  if (env.workspaceDirs) environment.workspaceDirs = env.workspaceDirs;
  if (env.gitRemotes) environment.gitRemotes = env.gitRemotes;
  if (env.trustedDomains) settingsEnv.trustedDomains = env.trustedDomains;
  if (env.productionMarkers) {
    settingsEnv.productionMarkers = env.productionMarkers;
  }
  return buildReviewMessages({
    toolName: c.tool,
    args: c.args,
    history: {
      userMessages: c.history.userMessages,
      toolCalls: c.history.toolCalls ?? [],
    },
    environment,
    settings: {
      environment: settingsEnv,
    },
    guidance: validGuidance(config),
    systemPrompt: promptText(config.promptVariant),
    nonce,
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String(p.text) : "",
      )
      .join("");
  }
  return "";
}

function tokens(raw: unknown, cacheExcluded: boolean) {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as Record<string, any>;
  const num = (...vals: unknown[]) =>
    vals.find((v): v is number => typeof v === "number");
  const prompt = num(u.promptTokens, u.prompt_tokens, u.input_tokens);
  const read = num(
    u.promptTokensDetails?.cachedTokens,
    u.prompt_tokens_details?.cached_tokens,
    u.prompt_tokens_details?.cache_read_tokens,
    u.cacheReadTokens,
    u.cache_read_input_tokens,
  );
  const write = num(
    u.promptTokensDetails?.cacheWriteTokens,
    u.prompt_tokens_details?.cache_write_tokens,
    u.cache_creation_input_tokens,
  );
  // Bedrock (and Claude on Anthropic) count the prompt without what was read
  // from or written to the cache; Nova reports 0 and puts it all there.
  const inputTokens =
    prompt === undefined && read === undefined && write === undefined
      ? undefined
      : (prompt ?? 0) + (cacheExcluded ? (read ?? 0) + (write ?? 0) : 0);
  return {
    inputTokens,
    outputTokens: num(u.completionTokens, u.completion_tokens, u.output_tokens),
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
}

/** Reply ceiling for a reviewer: roomy for a model that reasons first. */
export function defaultMaxTokens(reasons: boolean): number {
  return reasons ? 1024 : reviewCompletionOptions().maxTokens;
}

/** Model families that spend output tokens on reasoning before they answer. */
const REASONING_MODEL =
  /nova-2|deepseek-r|(^|[^a-z])o[134]([^a-z0-9]|$)|gpt-5|gpt-oss|magistral|grok-4|qwq|reasoner|thinking/i;

/**
 * Does this reviewer reason first? An explicit `reasoning` setting wins; else
 * a known family. A guess, used to pick a ceiling and to warn, never to gate.
 */
export function reviewerReasons(model: string, reasoning?: boolean): boolean {
  return reasoning ?? REASONING_MODEL.test(model);
}

const TRUNCATED = new Set(["length", "max_tokens", "max_output_tokens"]);

function finishReasonOf(reply: unknown): string | undefined {
  const r = reply as {
    finishReason?: unknown;
    usage?: { response?: { stopReason?: unknown } };
  };
  const v = r?.finishReason ?? r?.usage?.response?.stopReason;
  return typeof v === "string" && v ? v : undefined;
}

const failedClosed = (why: string) => ({
  decision: "ask" as const,
  reason: why,
});

async function runOne(
  client: ReviewerClient,
  c: LabelledCase,
  dataset: ReviewDataset,
  config: ReviewerConfig,
  opts: RunOptions,
): Promise<CaseOutcome> {
  if (config.prefilter !== false && findReviewerAddressedText(c.args).length) {
    return {
      id: c.id,
      decision: "ask",
      category: "reviewer-addressed-text",
      reason: "Text in the call addresses the reviewer (pre-filter).",
      formatFailure: false,
      truncated: false,
      ms: 0,
      promptChars: 0,
    };
  }
  const messages = messagesFor(c, dataset, config);
  const promptChars = messages.reduce(
    (n, m) => n + messageText(m.content).length,
    0,
  );
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  const t0 = Date.now();
  try {
    const reply = await client.chat(messages, controller.signal, {
      ...reviewCompletionOptions(config.reasoning),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    });
    const ms = Date.now() - t0;
    const text = messageText(reply?.content);
    const parsed = parseReviewerReply(text, {
      allowNeedsNone: config.promptVariant === "v3",
    });
    const finishReason = finishReasonOf(reply);
    const named = client as { providerName?: string; model?: string };
    const excluded =
      !!named.providerName &&
      promptTokensExcludeCache(named.providerName, named.model ?? "");
    return {
      id: c.id,
      decision: parsed.decision,
      category: parsed.category,
      reason: parsed.reason,
      formatFailure: parsed.unusable === true,
      rawReply: text.slice(0, RAW_REPLY_MAX),
      ...(finishReason ? { finishReason } : {}),
      truncated:
        parsed.unusable === true &&
        finishReason !== undefined &&
        TRUNCATED.has(finishReason),
      ms,
      promptChars,
      ...tokens((reply as { usage?: unknown } | undefined)?.usage, excluded),
    };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      id: c.id,
      ...failedClosed(`The reviewer call failed: ${why}`),
      category: "reviewer-unavailable",
      formatFailure: false,
      truncated: false,
      error: why,
      ms: Date.now() - t0,
      promptChars,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Ask the reviewer about every case: the real messages from
 * `buildReviewMessages`, the strict verdict parser, nothing else in between
 * (the rules engine is not run; this measures the model and its prompt).
 * Results keep the dataset's order. Never throws for one bad case.
 */
async function runOnce(
  client: ReviewerClient,
  dataset: ReviewDataset,
  config: ReviewerConfig,
  opts: RunOptions = {},
): Promise<CaseOutcome[]> {
  const { cases } = dataset;
  const outcomes: CaseOutcome[] = new Array(cases.length);
  let next = 0;
  let done = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      outcomes[i] = await runOne(client, cases[i], dataset, config, opts);
      opts.onProgress?.(++done, cases.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker),
  );
  return outcomes;
}

/**
 * Ask every case `opts.repeat` times (default once), runs back to back so a
 * rate limit hits them alike. `outcomes` is the first run; `runs` has all.
 */
export async function runReviewEval(
  client: ReviewerClient,
  dataset: ReviewDataset,
  config: ReviewerConfig,
  opts: RunOptions = {},
): Promise<RunResult> {
  const promptVersion = reviewerPromptVersion(
    validGuidance(config),
    config.profile,
    promptText(config.promptVariant),
  );
  const runs: CaseOutcome[][] = [];
  for (let k = 0; k < Math.max(1, opts.repeat ?? 1); k++) {
    runs.push(await runOnce(client, dataset, config, opts));
  }
  return { config, promptVersion, outcomes: runs[0], runs };
}

export interface CostPlan {
  calls: number;
  configs: number;
  /** Times each case is asked. */
  repeat: number;
  /** About four characters a token; an estimate, not a tokenizer count. */
  estInputTokens: number;
  /** The reply ceiling in force. */
  maxTokens: number;
  /** Upper bound: every reply up to the reply ceiling. */
  maxOutputTokens: number;
  concurrency: number;
  /** USD at list price for the estimated input and the output ceiling. */
  cost?: CostResult;
  /** Things to fix before paying for the run. */
  warnings: string[];
}

export interface PlanModel {
  provider: string;
  model: string;
  /** The model's own reasoning setting, when the config states one. */
  reasoning?: boolean;
}

/** What a real run would send, computed without calling anything. */
export function planCost(
  dataset: ReviewDataset,
  configs: Pick<ReviewerConfig, "guidance" | "promptVariant">[],
  concurrency = 4,
  options: { model?: PlanModel; maxTokens?: number; repeat?: number } = {},
): CostPlan {
  let chars = 0;
  for (const config of configs) {
    for (const c of dataset.cases) {
      for (const m of messagesFor(c, dataset, config, "0".repeat(16))) {
        chars += messageText(m.content).length;
      }
    }
  }
  const repeat = Math.max(1, options.repeat ?? 1);
  const reasons = options.model
    ? reviewerReasons(options.model.model, options.model.reasoning)
    : false;
  const maxTokens = options.maxTokens ?? defaultMaxTokens(reasons);
  const calls = dataset.cases.length * configs.length * repeat;
  const estInputTokens = Math.ceil((chars / 4) * repeat);
  const maxOutputTokens = calls * maxTokens;
  const warnings: string[] = [];
  if (reasons && maxTokens < 1000) {
    warnings.push(
      `${options.model?.model} reasons before it answers and the reply ceiling is ${maxTokens} tokens: ` +
        "it can spend all of it on reasoning and return nothing (counted as truncated). " +
        "Raise --max-tokens to 1024 or more, or set reasoning_effort: none on the model.",
    );
  }
  return {
    calls,
    configs: configs.length,
    repeat,
    estInputTokens,
    maxTokens,
    maxOutputTokens,
    concurrency,
    ...(options.model
      ? {
          cost: costOf(
            {
              input: estInputTokens,
              output: maxOutputTokens,
              cacheRead: 0,
              cacheWrite: 0,
              requests: calls,
            },
            options.model,
          ),
        }
      : {}),
    warnings,
  };
}
