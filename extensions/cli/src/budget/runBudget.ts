import { costOf, type CostModel, type UserPrice } from "core/util/costOf.js";
import { USER_PRICE_SOURCE } from "core/util/modelPrice.js";

import {
  REFRESH_HINT,
  priceSourceNote,
  type PriceListStatus,
} from "./openRouterPrices.js";

/**
 * The run limits of a plain headless run (`cn -p`) or `cn serve`: dollars,
 * model requests and wall-clock time. Semantics are ours, defined here and in
 * docs/cli/run-limits.mdx:
 *
 * - turns: one turn is one model request. A request is refused once this many
 *   have been sent in the run. A run that finishes on its last allowed request
 *   is not stopped.
 * - budget: USD at list price, counted from the usage the provider reports for
 *   THIS run (spend restored by --resume or --continue does not count). Before
 *   each request the run estimates what it would cost and refuses to start it
 *   if spend plus the estimate would pass the cap; after each request the real
 *   usage is counted and the run stops once spend has reached the cap.
 * - duration: minutes since the run started, checked before and after each
 *   request. A request in flight is let finish.
 */
export type RunStopReason = "budget" | "turns" | "duration";

/** Distinct from 1 (error) and 3 (secrets found). */
export const RUN_STOP_EXIT_CODE: Record<RunStopReason, number> = {
  budget: 20,
  turns: 21,
  duration: 22,
};

export interface RunLimits {
  maxBudgetUsd?: number;
  maxTurns?: number;
  maxDurationMinutes?: number;
}

export interface RunStop {
  reason: RunStopReason;
  /** Whether the request was refused before it was sent, or counted and then stopped */
  phase: "before-call" | "after-call";
  /** One sentence for the final message and the audit trail */
  detail: string;
  spentUsd?: number;
  estimateUsd?: number;
}

/** Output assumed for a request before the run has seen one (tokens). */
export const DEFAULT_OUTPUT_ESTIMATE = 1024;

export interface RunBudgetOptions {
  limits: RunLimits;
  model: CostModel;
  /**
   * Hold the dollar cap on a price from the community catalogue (models.dev)
   * when that is the only price: set by --budget-allow-unpriced.
   */
  allowCommunityPrice?: boolean;
  /** The price on the model's config entry (`pricing:`), which wins over the tables */
  userPrice?: UserPrice;
  /** Milliseconds, injectable for tests */
  now?: () => number;
  /** USD this run has spent so far, or "unknown" when a model it used has no price */
  spentUsd: () => number | "unknown";
}

function positive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

function probe(model: CostModel, userPrice?: UserPrice) {
  return costOf(
    { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
    model,
    { userPrice },
  );
}

/**
 * Whether a dollar cap can be held on this model's price. A price from the
 * community catalogue (models.dev) counts only with `allowCommunity`
 * (--budget-allow-unpriced): it is a third-party estimate.
 */
function hasPrice(
  model: CostModel,
  allowCommunity = false,
  userPrice?: UserPrice,
): boolean {
  const r = probe(model, userPrice);
  if (r.amount === "unknown") return false;
  return allowCommunity || r.priceSource?.kind !== "community";
}

/** The date of the community copy when that is the model's only price. */
function communityOnlyPrice(model: CostModel): string | undefined {
  const r = probe(model);
  return r.amount !== "unknown" && r.priceSource?.kind === "community"
    ? (r.priceSource.asOf ?? "").slice(0, 10)
    : undefined;
}

/**
 * Why a dollar budget cannot be held on this model, or undefined when it can.
 * `prices` is the state of the downloaded OpenRouter list, which prices
 * OpenRouter models the tables do not know.
 */
export function unpricedBudgetProblem(
  limits: RunLimits,
  model: CostModel,
  allowUnpriced: boolean | undefined,
  prices?: PriceListStatus,
  userPrice?: UserPrice,
): string | undefined {
  if (!positive(limits.maxBudgetUsd) || allowUnpriced) return undefined;
  if (hasPrice(model, false, userPrice)) return undefined;
  const communityDate = communityOnlyPrice(model);
  if (communityDate !== undefined) {
    return `--max-budget-usd cannot be held on ${model.provider}/${model.model}: its only price is from the community catalogue (models.dev, ${communityDate}), a third-party estimate a dollar cap is not held on. Pick a model with a price from the provider or the price tables, or pass --budget-allow-unpriced to hold the cap on the community estimate.`;
  }
  if (model.provider.toLowerCase() === "openrouter") {
    const id = `${model.provider}/${model.model}`;
    const escape =
      "or pass --budget-allow-unpriced to run without the dollar cap";
    if (!prices || prices.state === "none") {
      return `--max-budget-usd cannot be held on ${id}: there is no downloaded OpenRouter price list on this computer. To download the public list, ${REFRESH_HINT} (it contacts openrouter.ai once), ${escape}.`;
    }
    if (prices.state === "tooOld") {
      return `--max-budget-usd cannot be held on ${id}: the downloaded OpenRouter price list is ${prices.ageDays} days old (downloaded ${prices.fetchedAt.slice(0, 10)}), and a dollar cap is not held on prices older than 90 days. ${REFRESH_HINT}, ${escape}.`;
    }
    return `--max-budget-usd cannot be held on ${id}: the downloaded OpenRouter list (${prices.fetchedAt.slice(0, 10)}) has no price for this model id. Pick a priced model, or ${REFRESH_HINT} in case it was added since, ${escape}.`;
  }
  return `--max-budget-usd cannot be held on ${model.provider}/${model.model}: the cost table has no price for it, so spend would read as unknown. Pick a priced model, set its price in config.yaml (pricing: input and output, US dollars per million tokens), or pass --budget-allow-unpriced to run without the dollar cap.`;
}

/**
 * Both ends of a request go through here: `beforeCall` with the estimated
 * input size, `afterCall` with the real usage already counted. A stop is
 * sticky: once set, every later check returns it.
 */
export class RunBudget {
  readonly limits: RunLimits;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly priced: boolean;
  private calls = 0;
  private maxOutput = 0;
  private stopped: RunStop | undefined;

  constructor(private readonly opts: RunBudgetOptions) {
    this.limits = opts.limits;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.priced = hasPrice(
      opts.model,
      opts.allowCommunityPrice,
      opts.userPrice,
    );
  }

  get stop(): RunStop | undefined {
    return this.stopped;
  }

  get requests(): number {
    return this.calls;
  }

  /**
   * "prices from openrouter.ai as of <date>" when the model is priced from the
   * downloaded list, "prices from the community catalogue (models.dev) as of
   * <date>" when from that.
   */
  get priceNote(): string | undefined {
    if (!this.priced) return undefined;
    if (this.opts.userPrice) return `prices from ${USER_PRICE_SOURCE}`;
    const community = communityOnlyPrice(this.opts.model);
    if (community !== undefined) {
      return `prices from the community catalogue (models.dev) as of ${community}`;
    }
    return priceSourceNote(this.opts.model);
  }

  /** Whether the dollar cap is actually being enforced for this run. */
  get dollarCapActive(): boolean {
    return positive(this.limits.maxBudgetUsd) && this.priced;
  }

  /** The estimate for a request of `inputTokens`, in USD, or undefined when unpriced. */
  estimateUsd(inputTokens: number): number | undefined {
    const output =
      this.maxOutput > 0 ? this.maxOutput : DEFAULT_OUTPUT_ESTIMATE;
    // Every input token at the full input rate: cache discounts are not
    // assumed, so the estimate errs high.
    const r = costOf(
      {
        input: Math.max(0, inputTokens),
        output,
        cacheRead: 0,
        cacheWrite: 0,
      },
      this.opts.model,
      { userPrice: this.opts.userPrice },
    );
    return r.amount === "unknown" ? undefined : r.amount;
  }

  private elapsedMinutes(): number {
    return (this.now() - this.startedAt) / 60_000;
  }

  private set(stop: RunStop): RunStop {
    this.stopped ??= stop;
    return this.stopped;
  }

  private durationStop(phase: RunStop["phase"]): RunStop | undefined {
    const max = this.limits.maxDurationMinutes;
    if (!positive(max) || this.elapsedMinutes() < max) return undefined;
    return this.set({
      reason: "duration",
      phase,
      detail: `Stopped: the run has been going for ${this.elapsedMinutes().toFixed(1)} minutes, at the --max-duration limit of ${max}.`,
    });
  }

  private budgetBefore(inputTokens: number): RunStop | undefined {
    const cap = this.limits.maxBudgetUsd;
    if (!positive(cap) || !this.priced) return undefined;
    const spent = this.opts.spentUsd();
    const estimate = this.estimateUsd(inputTokens);
    if (spent === "unknown" || estimate === undefined) return undefined;
    if (spent + estimate <= cap) return undefined;
    const output =
      this.maxOutput > 0
        ? "the largest reply so far"
        : `${DEFAULT_OUTPUT_ESTIMATE} output tokens assumed`;
    return this.set({
      reason: "budget",
      phase: "before-call",
      detail: `Stopped before request ${this.calls + 1}: $${spent.toFixed(4)} spent, and this request is estimated at $${estimate.toFixed(4)} (${Math.round(inputTokens)} input tokens, ${output}), which would pass the --max-budget-usd cap of $${cap}.`,
      spentUsd: spent,
      estimateUsd: estimate,
    });
  }

  /** Call before sending a request. A returned stop means: do not send it. */
  beforeCall(inputTokens: number): RunStop | undefined {
    if (this.stopped) return this.stopped;
    const { maxTurns } = this.limits;
    if (positive(maxTurns) && this.calls >= maxTurns) {
      return this.set({
        reason: "turns",
        phase: "before-call",
        detail: `Stopped before request ${this.calls + 1}: the run has made ${this.calls} model requests, the --max-turns limit.`,
      });
    }
    const stop =
      this.durationStop("before-call") ?? this.budgetBefore(inputTokens);
    if (stop) return stop;
    this.calls += 1;
    return undefined;
  }

  /** Call after a request, once its real usage is in the session totals. */
  afterCall(completionTokens?: number): RunStop | undefined {
    if (typeof completionTokens === "number" && completionTokens > 0) {
      this.maxOutput = Math.max(this.maxOutput, completionTokens);
    }
    if (this.stopped) return this.stopped;
    const cap = this.limits.maxBudgetUsd;
    if (positive(cap) && this.priced) {
      const spent = this.opts.spentUsd();
      if (spent !== "unknown" && spent >= cap) {
        return this.set({
          reason: "budget",
          phase: "after-call",
          detail: `Stopped: $${spent.toFixed(4)} spent after request ${this.calls}, at the --max-budget-usd cap of $${cap}.`,
          spentUsd: spent,
        });
      }
    }
    return this.durationStop("after-call");
  }
}

export interface Tightened {
  limits: RunLimits;
  /** Flags that asked for more than the configured cap and were ignored */
  ignored: string[];
}

const LIMIT_FLAGS: Record<keyof RunLimits, string> = {
  maxBudgetUsd: "--max-budget-usd",
  maxTurns: "--max-turns",
  maxDurationMinutes: "--max-duration",
};

/**
 * A flag may tighten a configured cap, never loosen it: the smaller value
 * wins. A flag with no configured cap just applies.
 */
export function tightenLimits(
  configured: RunLimits,
  flags: RunLimits,
): Tightened {
  const limits: RunLimits = {};
  const ignored: string[] = [];
  for (const key of Object.keys(LIMIT_FLAGS) as (keyof RunLimits)[]) {
    const c = positive(configured[key]) ? configured[key] : undefined;
    const f = positive(flags[key]) ? flags[key] : undefined;
    if (c !== undefined && f !== undefined && f > c) {
      ignored.push(
        `${LIMIT_FLAGS[key]} ${f} is looser than the configured cap of ${c} and is ignored`,
      );
    }
    const value =
      c !== undefined && f !== undefined ? Math.min(c, f) : (f ?? c);
    if (value !== undefined) limits[key] = value;
  }
  return { limits, ignored };
}
