/**
 * `continuous sessions clean [--yes]`: the terminal side of VS Code's
 * "Continuous: Clean up old sessions". A dry run unless `--yes`.
 *
 * Removes the full prompts earlier releases kept in every session (each is
 * replaced by the marker the product writes now; model and completion stay),
 * full prompts and old lines in `dev_data`,
 * and old files in `logs/`. Each changed file is rewritten to a temporary
 * file, checked, and renamed over the original, whose bytes are kept in
 * `<global folder>/cleanup-backups/<date>/`. Sessions open in a window or
 * used by a running agent are left alone. Prints counts, sizes and file
 * names, never contents. The work is `core/util/sessionCleanup`, shared with
 * VS Code.
 */
import type { Command } from "commander";
import { DAY_MS, parseAge } from "core/util/cleanStores.js";
import { getGlobalDirPath } from "core/util/paths.js";
import type { Io } from "core/util/secretScan/secretsCli.js";
import {
  applyCleanup,
  describeResult,
  describeScan,
  pruneCleanupBackups,
  scanForCleanup,
  type CleanupStore,
} from "core/util/sessionCleanup/index.js";

import { gracefulExit } from "../util/exit.js";

export interface SessionsCleanOptions {
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Commander's --no-dev-data / --no-logs. */
  devData?: boolean;
  logs?: boolean;
  devDataDays?: string;
  logsDays?: string;
  deleteBackupsOlderThan?: string;
  /** Global folder; default the real one (tests pass a temp dir). */
  root?: string;
  now?: number;
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

function days(
  text: string | undefined,
  name: string,
  io: Io,
): number | null | undefined {
  if (text === undefined) return undefined;
  const ms = parseAge(text);
  if (!ms) {
    io.err(`Bad ${name} "${text}": use 90d, 2w or a number of days.`);
    return null;
  }
  return ms / DAY_MS;
}

export async function sessionsCleanCommand(
  options: SessionsCleanOptions,
  io: Io = consoleIo,
): Promise<number> {
  const devDataDays = days(options.devDataDays, "--dev-data-days", io);
  const logsDays = days(options.logsDays, "--logs-days", io);
  const backupsDays = days(
    options.deleteBackupsOlderThan,
    "--delete-backups-older-than",
    io,
  );
  if (devDataDays === null || logsDays === null || backupsDays === null)
    return 2;

  const root = options.root ?? getGlobalDirPath();
  const stores: CleanupStore[] = ["sessions"];
  if (options.devData !== false) stores.push("dev_data");
  if (options.logs !== false) stores.push("logs");
  const now = options.now ?? Date.now();
  const scan = await scanForCleanup({
    root,
    now,
    stores,
    devDataDays,
    logsDays,
  });
  const apply = !!options.yes && !options.dryRun;
  const result = apply ? await applyCleanup(scan, { now }) : undefined;
  const pruned =
    apply && backupsDays !== undefined
      ? pruneCleanupBackups(root, backupsDays * DAY_MS, now)
      : undefined;

  if (options.json) {
    io.out(
      JSON.stringify({
        root,
        applied: apply,
        scan: {
          sessions: scan.sessions.map(({ file, bytes, reclaimableBytes }) => ({
            file,
            bytes,
            reclaimableBytes,
          })),
          devData: scan.devData.map(({ file, reclaimableBytes }) => ({
            file,
            reclaimableBytes,
          })),
          logs: scan.logs.map(({ file, bytes }) => ({ file, bytes })),
          skipped: scan.skipped,
          largestSession: scan.largestSession,
          totals: scan.totals,
        },
        result,
        prunedBackups: pruned,
      }),
    );
    return result?.failed.length ? 1 : 0;
  }

  io.out(`Global folder: ${root}`);
  for (const line of describeScan(scan)) io.out(line);
  if (!apply) {
    io.out(
      scan.totals.reclaimableBytes > 0
        ? "Dry run: nothing changed. Run with --yes to clean up; originals are kept in cleanup-backups/."
        : "Dry run: nothing to clean up.",
    );
    return 0;
  }
  for (const line of describeResult(result!)) io.out(line);
  if (pruned?.removed.length) {
    io.out(
      `Deleted ${pruned.removed.length} backup folder(s) older than ${backupsDays} days.`,
    );
  }
  return result!.failed.length ? 1 : 0;
}

/** Adds `continuous sessions clean` to the program. */
export function registerSessionsCommand(program: Command): void {
  const sessions = program
    .command("sessions")
    .description("Work with saved sessions on this machine");
  sessions
    .command("clean")
    .description(
      "Remove old prompt logs from saved sessions (model and completion stay), full prompts and old lines from dev_data, and old logs. Dry run unless --yes. Originals are kept in cleanup-backups/; sessions open in a window or agent are left alone",
    )
    .option("--yes", "Clean up")
    .option("--dry-run", "Only report (the default)")
    .option("--json", "Machine-readable output")
    .option("--no-dev-data", "Leave dev_data alone")
    .option("--no-logs", "Leave logs alone")
    .option(
      "--dev-data-days <age>",
      "Dev data lines older than this go (default 90d)",
    )
    .option("--logs-days <age>", "Log files older than this go (default 14d)")
    .option(
      "--delete-backups-older-than <age>",
      "With --yes, also delete cleanup backups older than this (default: keep them)",
    )
    .action(async (options) => {
      await gracefulExit(await sessionsCleanCommand(options));
    });
}
