import { backgroundJobService } from "../services/BackgroundJobService.js";
import { getSessionUsage } from "../session.js";
import { telemetryService } from "../telemetry/telemetryService.js";

import { formatCacheTally, splitInputTokens } from "./cacheTally.js";
import { hadUnhandledError } from "./errorState.js";
import { fieldFallbackLines } from "./fieldFallbackLines.js";
import { logger } from "./logger.js";
import { formatReplyTally } from "./replyTally.js";
import { formatPriceSourceLines, formatSessionCost } from "./sessionCost.js";

/**
 * Display session usage breakdown in verbose mode
 */
export function displaySessionUsage(): void {
  const isVerbose = process.argv.includes("--verbose");
  if (!isVerbose) {
    return;
  }

  try {
    const usage = getSessionUsage();
    if (usage.totalCost === 0 && usage.promptTokens === 0) {
      return; // No usage to display
    }

    logger.info("\n" + "=".repeat(60));
    logger.info("Session Usage Summary");
    logger.info("=".repeat(60));
    logger.info(`Total Cost: ${formatSessionCost(usage)}`);
    for (const line of formatPriceSourceLines(usage)) logger.info(line);
    logger.info("");
    logger.info("Token Usage:");
    // Input is what the provider processed: uncached plus cache reads plus
    // cache writes. The parts are always shown.
    const { uncached, cacheRead, cacheWrite } = splitInputTokens(usage);
    logger.info(
      `  Input Tokens:      ${usage.promptTokens.toLocaleString()} processed`,
    );
    logger.info(`    Uncached:        ${uncached.toLocaleString()}`);
    logger.info(`    Cache Read:      ${cacheRead.toLocaleString()}`);
    logger.info(`    Cache Write:     ${cacheWrite.toLocaleString()}`);
    logger.info(
      `  Output Tokens:     ${usage.completionTokens.toLocaleString()}`,
    );

    const totalTokens = usage.promptTokens + usage.completionTokens;
    logger.info(`  Total Tokens:      ${totalTokens.toLocaleString()}`);

    // Counted per request this run, so they can differ from the cumulative
    // totals above when the session was resumed.
    const cacheLine = formatCacheTally();
    const cutOff = formatReplyTally();
    if (cacheLine || cutOff) logger.info("");
    if (cacheLine) logger.info(cacheLine);
    if (cutOff) logger.info(cutOff);
    // Request fields a model refused and the run went on without.
    const fallbackLines = fieldFallbackLines();
    if (fallbackLines.length > 0) {
      logger.info("");
      for (const line of fallbackLines) logger.info(line);
    }
    logger.info("=".repeat(60) + "\n");
  } catch (err) {
    logger.debug("Failed to display session usage (non-critical)", err as any);
  }
}

/**
 * Exit the process after flushing telemetry and error reporting.
 * Use this instead of process.exit() to avoid losing metrics/logs.
 *
 * If any unhandled errors occurred during execution and the requested
 * exit code is 0 (success), this will exit with code 1 instead to
 * signal that the process encountered errors.
 */
export async function gracefulExit(code: number = 0): Promise<void> {
  // Display session usage breakdown in verbose mode
  displaySessionUsage();

  try {
    const runningJobs = backgroundJobService.getRunningJobCount();
    if (runningJobs > 0) {
      logger.debug(`Killing ${runningJobs} background job(s) on exit`);
      backgroundJobService.killAllJobs();
    }
  } catch (err) {
    logger.debug("Background job cleanup error (ignored)", err as any);
  }

  try {
    // SessionEnd hooks, bounded so a slow hook cannot hold the exit
    const { runSessionEndHooks } = await import("../hooks/lifecycleHooks.js");
    await runSessionEndHooks(code === 0 ? "prompt_input_exit" : "other");
  } catch (err) {
    logger.debug("SessionEnd hooks error (ignored)", err as any);
  }

  try {
    // Flush metrics (forceFlush + shutdown inside service)
    await telemetryService.shutdown();
  } catch (err) {
    logger.debug("Telemetry shutdown error (ignored)", err as any);
  }

  // If we're trying to exit with success (0) but had unhandled errors,
  // exit with 1 instead to signal failure
  const finalCode = code === 0 && hadUnhandledError() ? 1 : code;

  // Exit the process
  process.exit(finalCode);
}
