/**
 * "Continuous: Clean up old sessions", and the one notice after an update
 * that offers it. The work, and the words of the report, are
 * `core/util/sessionCleanup`, shared with `continuous sessions clean`.
 *
 * Never automatic: the command shows what a scan found and changes nothing
 * until the person says so. After an update the extension scans once, in the
 * background, and offers the command only when more than 100 MB could be
 * reclaimed; "Don't ask again" is remembered.
 */
import { DAY_MS } from "core/util/cleanStores";
import {
  applyCleanup,
  CLEANUP_NOTICE_THRESHOLD_BYTES,
  describeResult,
  describeScan,
  formatMegabytes,
  pruneCleanupBackups,
  quickCleanupEstimate,
  scanForCleanup,
  type CleanupScan,
} from "core/util/sessionCleanup/index";
import * as vscode from "vscode";

export const CLEANUP_COMMAND = "continuous.cleanUpOldSessions";
const NOTICE_VERSION_KEY = "continuous.sessionCleanup.noticeVersion";
const NOTICE_DECLINED_KEY = "continuous.sessionCleanup.noticeDeclined";
/** Let start-up finish before reading session files. */
const NOTICE_DELAY_MS = 60_000;

/** Whether this start should look for something to offer. Pure, for tests. */
export function shouldScanForNotice(state: {
  version: string;
  lastNoticeVersion?: string;
  declined?: boolean;
}): boolean {
  return !state.declined && state.lastNoticeVersion !== state.version;
}

function backupsSetting(): number {
  return vscode.workspace
    .getConfiguration("continuous")
    .get<number>("sessionCleanup.deleteBackupsAfterDays", 0);
}

async function scanWithProgress(): Promise<CleanupScan | undefined> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Continuous: looking for old prompt logs",
      cancellable: true,
    },
    async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        return await scanForCleanup({
          signal: abort.signal,
          onProgress: (_file, done, total) =>
            progress.report({ message: `${done} of ${total} files` }),
        });
      } catch (error) {
        if (abort.signal.aborted) {
          return undefined;
        }
        throw error;
      }
    },
  );
}

/** Shows the dry run and, when the person agrees, cleans up. */
export async function runSessionCleanup(given?: CleanupScan): Promise<void> {
  const scan = given ?? (await scanWithProgress());
  if (!scan) {
    return;
  }
  const report = describeScan(scan);
  if (scan.totals.reclaimableBytes <= 0) {
    void vscode.window.showInformationMessage(
      "Continuous: nothing to clean up.",
      { modal: true, detail: report.join("\n") },
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Clean up ${formatMegabytes(scan.totals.reclaimableBytes)}?`,
    {
      modal: true,
      detail: [
        ...report,
        "",
        "Each file is checked after it is rewritten; originals are kept in cleanup-backups/ in the global folder. Sessions open in another window or agent are left alone.",
      ].join("\n"),
    },
    "Clean up",
  );
  if (choice !== "Clean up") {
    return;
  }

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Continuous: cleaning up",
    },
    (progress) =>
      applyCleanup(scan, {
        onProgress: (_file, done, total) =>
          progress.report({ message: `${done} of ${total} files` }),
      }),
  );
  const lines = describeResult(result);
  const keepDays = backupsSetting();
  if (keepDays > 0) {
    const pruned = pruneCleanupBackups(scan.root, keepDays * DAY_MS);
    if (pruned.removed.length) {
      lines.push(
        `Deleted ${pruned.removed.length} backup folder(s) older than ${keepDays} days (${formatMegabytes(pruned.bytes)}).`,
      );
    }
  }
  const open = await vscode.window.showInformationMessage(
    result.failed.length
      ? "Continuous: cleanup finished with errors."
      : "Continuous: cleanup finished.",
    { modal: true, detail: lines.join("\n") },
    "Open backup folder",
  );
  if (open === "Open backup folder") {
    void vscode.env.openExternal(vscode.Uri.file(result.backupDir));
  }
}

export async function offerAfterUpdate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const version = String(context.extension?.packageJSON?.version ?? "");
  const state = {
    version,
    lastNoticeVersion: context.globalState.get<string>(NOTICE_VERSION_KEY),
    declined: context.globalState.get<boolean>(NOTICE_DECLINED_KEY),
  };
  if (!shouldScanForNotice(state)) {
    return;
  }
  // Once per version, whatever the scan finds
  await context.globalState.update(NOTICE_VERSION_KEY, version);
  if ((await quickCleanupEstimate()) <= CLEANUP_NOTICE_THRESHOLD_BYTES) {
    return;
  }
  const scan = await scanForCleanup();
  if (scan.totals.reclaimableBytes <= CLEANUP_NOTICE_THRESHOLD_BYTES) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Continuous: earlier versions kept every request's full prompt in your sessions and dev data. ${formatMegabytes(scan.totals.reclaimableBytes)} can be reclaimed. Review it?`,
    "Review",
    "Not now",
    "Don't ask again",
  );
  if (choice === "Review") {
    await runSessionCleanup(scan);
  } else if (choice === "Don't ask again") {
    await context.globalState.update(NOTICE_DECLINED_KEY, true);
  }
}

export function registerSessionCleanup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CLEANUP_COMMAND, () =>
      runSessionCleanup().catch((error) => {
        void vscode.window.showErrorMessage(
          `Continuous: cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }),
    ),
  );
  const timer = setTimeout(() => {
    offerAfterUpdate(context).catch((error) =>
      console.warn("Could not check for old prompt logs", error),
    );
  }, NOTICE_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
