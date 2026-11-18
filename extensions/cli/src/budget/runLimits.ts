import * as fs from "fs";
import * as path from "path";

import type { Command } from "commander";
import { loadCommunityPrices } from "core/llm/communityCatalogStore.js";
import { costSince, costMarkOf } from "core/util/loopCost.js";
import { userPriceOf, type PricedModel } from "core/util/modelPrice.js";

import { cliAuditSession, cliAuditTrail } from "../audit/cliAudit.js";
import { configError } from "../headless/exitCodes.js";
import { getGlobalDir } from "../hooks/hookTrust.js";
import { safeStderr } from "../init.js";
import { getSessionUsage } from "../session.js";
import { logger } from "../util/logger.js";

import { loadPricesForRun, stalePriceWarning } from "./openRouterPrices.js";
import {
  RunBudget,
  RUN_STOP_EXIT_CODE,
  tightenLimits,
  unpricedBudgetProblem,
  type RunLimits,
  type RunStop,
} from "./runBudget.js";

/** The flags of `cn` and `cn serve` that limit a run. */
export interface RunLimitOptions {
  maxBudgetUsd?: string | number;
  maxTurns?: string | number;
  maxDuration?: string | number;
  budgetAllowUnpriced?: boolean;
}

/** Registers the run-limit flags on a command (root and serve). */
export function addRunLimitOptions(command: Command): Command {
  return command
    .option(
      "--max-budget-usd <n>",
      "Stop the run before a model request that would take its estimated spend past this many US dollars (headless runs and serve). A user setting can only be tightened by this flag.",
    )
    .option(
      "--max-turns <n>",
      "Stop the run after this many model requests (headless runs and serve)",
    )
    .option(
      "--max-duration <minutes>",
      "Stop the run once it has gone on this many minutes (headless runs and serve)",
    )
    .option(
      "--budget-allow-unpriced",
      "Run with --max-budget-usd on a model that has no price; the dollar cap is then not enforced",
    );
}

function parseLimit(
  flag: string,
  raw: string | number | undefined,
  integer: boolean,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(
      `${flag} needs a positive ${integer ? "whole number" : "number"}, got "${raw}"`,
    );
  }
  return n;
}

/** The flags as limits. Throws a message fit for the person on a bad value. */
export function limitsFromFlags(options: RunLimitOptions): RunLimits {
  const limits: RunLimits = {};
  const usd = parseLimit("--max-budget-usd", options.maxBudgetUsd, false);
  const turns = parseLimit("--max-turns", options.maxTurns, true);
  const minutes = parseLimit("--max-duration", options.maxDuration, false);
  if (usd !== undefined) limits.maxBudgetUsd = usd;
  if (turns !== undefined) limits.maxTurns = turns;
  if (minutes !== undefined) limits.maxDurationMinutes = minutes;
  return limits;
}

function settingNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/**
 * The caps in the user's own settings file (`runLimits` in settings.json in
 * the global directory). Project files are never read: a repository cannot
 * set, and so cannot loosen, a person's cap.
 */
export function loadConfiguredLimits(
  cwd: string = process.cwd(),
  homeDir?: string,
): RunLimits {
  try {
    const dir = getGlobalDir(cwd, homeDir);
    if (!dir) return {};
    const file = path.join(dir, "settings.json");
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"))?.runLimits;
    if (!raw || typeof raw !== "object") return {};
    const limits: RunLimits = {};
    const usd = settingNumber(raw.maxBudgetUsd);
    const turns = settingNumber(raw.maxTurns);
    const minutes = settingNumber(raw.maxDurationMinutes);
    if (usd !== undefined) limits.maxBudgetUsd = usd;
    if (turns !== undefined) limits.maxTurns = Math.floor(turns);
    if (minutes !== undefined) limits.maxDurationMinutes = minutes;
    return limits;
  } catch (error) {
    logger.warn("Failed to read run limits from settings:", error);
    return {};
  }
}

let active: RunBudget | undefined;

export function activeRunBudget(): RunBudget | undefined {
  return active;
}

export function setActiveRunBudget(budget: RunBudget | undefined): void {
  active = budget;
}

/**
 * Starts the run's limits from the user's settings and the flags, and makes
 * them the active ones. Returns undefined when nothing limits the run. Throws
 * when a dollar budget was asked for on a model with no price.
 */
export function startRunLimits(
  options: RunLimitOptions,
  model: { provider: string; model: string } & PricedModel,
  opts: {
    homeDir?: string;
    now?: () => number;
    warn?: (m: string) => void;
    /** The downloaded price list (tests pass a temporary file). */
    priceFile?: string;
    /** The community catalogue copy (tests pass a temporary file). */
    communityFile?: string;
  } = {},
): RunBudget | undefined {
  const { limits, ignored } = tightenLimits(
    loadConfiguredLimits(process.cwd(), opts.homeDir),
    limitsFromFlags(options),
  );
  for (const line of ignored) (opts.warn ?? logger.warn.bind(logger))(line);
  if (Object.keys(limits).length === 0) {
    setActiveRunBudget(undefined);
    return undefined;
  }
  // OpenRouter models are priced from the downloaded list (a file read). A
  // list over 90 days old does not price a budgeted run.
  const prices = loadPricesForRun({
    forBudget: limits.maxBudgetUsd !== undefined,
    file: opts.priceFile,
  });
  // The community catalogue (models.dev), the last price source: a file read.
  // A budget is held on it only with --budget-allow-unpriced.
  loadCommunityPrices({ file: opts.communityFile });
  if (model.provider.toLowerCase() === "openrouter") {
    const warning = stalePriceWarning(prices);
    if (warning) (opts.warn ?? logger.warn.bind(logger))(warning);
  }
  // A price on the model's own entry (`pricing:`) prices it ahead of the tables
  const userPrice = userPriceOf(model);
  const costModel = { provider: model.provider, model: model.model };
  const problem = unpricedBudgetProblem(
    limits,
    costModel,
    options.budgetAllowUnpriced,
    prices,
    userPrice,
  );
  if (problem) throw configError(problem);
  const start = costMarkOf(getSessionUsage());
  const userPrices = userPrice
    ? { [`${model.provider}/${model.model}`]: userPrice }
    : undefined;
  const budget = new RunBudget({
    limits,
    model: costModel,
    userPrice,
    allowCommunityPrice: options.budgetAllowUnpriced === true,
    now: opts.now,
    spentUsd: () =>
      costSince(start, costMarkOf(getSessionUsage()), { userPrices }).amount,
  });
  setActiveRunBudget(budget);
  return budget;
}

/**
 * Before a model request: true means the request must not be sent. The input
 * size is counted only when a limit is active. A compaction request is not
 * gated (its spend still counts).
 */
export function runStoppedBefore(
  isCompacting: boolean,
  inputTokens: () => number,
): boolean {
  if (!active || isCompacting) return false;
  return active.beforeCall(inputTokens()) !== undefined;
}

/** After a request is counted in the session totals: true means stop. */
export function runStoppedAfter(
  isCompacting: boolean,
  usage?: { completionTokens?: number; completion_tokens?: number },
): boolean {
  if (!active || isCompacting) return false;
  return (
    active.afterCall(usage?.completionTokens ?? usage?.completion_tokens) !==
    undefined
  );
}

/** Headless runs and serve only: a limit that is not enforced must not look like one that is. */
export function assertLimitsEnforceable(options: RunLimitOptions): void {
  if (
    options.maxBudgetUsd !== undefined ||
    options.maxTurns !== undefined ||
    options.maxDuration !== undefined
  ) {
    throw new Error(
      "--max-budget-usd, --max-turns and --max-duration apply to headless runs (-p) and cn serve, not to the interactive chat",
    );
  }
}

/** The stop the active run has reached, if any. */
export function currentRunStop(): RunStop | undefined {
  return active?.stop;
}

/** " (prices from openrouter.ai as of <date>)" after a budget stop on downloaded prices. */
function priceNoteFor(stop: RunStop): string {
  const note = stop.reason === "budget" ? active?.priceNote : undefined;
  return note ? ` (${note}; estimates)` : "";
}

/**
 * Records the stop in the audit trail, writes the final message to stderr
 * (JSON with --format json) and returns the exit code for it.
 */
export function reportRunStop(
  stop: RunStop,
  write: (text: string) => void,
  format?: string,
): number {
  const exit = RUN_STOP_EXIT_CODE[stop.reason];
  try {
    const trail = cliAuditTrail();
    if (trail.enabled) {
      trail.outcome({
        callId: `run-limit-${stop.reason}`,
        tool: "run-limit",
        session: cliAuditSession(),
        ran: false,
        exit,
        error: `${stop.reason} (${stop.phase}): ${stop.detail}`,
      });
    }
  } catch {
    // the audit never blocks the stop
  }
  write(
    format === "json"
      ? JSON.stringify({
          status: "stopped",
          reason: stop.reason,
          phase: stop.phase,
          message: stop.detail,
          exitCode: exit,
          ...(stop.spentUsd === undefined ? {} : { spentUsd: stop.spentUsd }),
        }) + "\n"
      : `${stop.detail}${priceNoteFor(stop)} (exit ${exit})\n`,
  );
  return exit;
}

/**
 * The exit code of a finished headless run: 0, or the code of the limit that
 * ended it, with the reason written to stderr.
 */
export function exitCodeOfRun(format?: string): number {
  const stop = active?.stop;
  if (stop) return reportRunStop(stop, safeStderr, format);
  // A cap held on downloaded prices says where they came from
  const note = active?.dollarCapActive ? active.priceNote : undefined;
  if (note && format !== "json")
    safeStderr(`Run budget: ${note} (estimates).\n`);
  return 0;
}
