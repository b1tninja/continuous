/**
 * `continuous sessions trash` and `continuous sessions restore <id>`: the
 * terminal side of the History page's trash (NI10, NI11). Sessions deleted
 * in the `--resume` / `continuous ls` picker or in VS Code are kept in
 * `<global folder>/sessions-trash/` for 7 days (core/util/sessionTrash.ts).
 * Prints ids, titles and dates, never contents.
 */
import historyManager from "core/util/history.js";
import type { Io } from "core/util/secretScan/secretsCli.js";
import { formatMegabytes } from "core/util/sessionCleanup/index.js";

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Lists the trash, newest deletion first. */
export function sessionsTrashCommand(
  options: { json?: boolean; empty?: boolean; yes?: boolean } = {},
  io: Io = consoleIo,
): number {
  if (options.empty) {
    const entries = historyManager.listTrash();
    if (!options.yes) {
      io.out(
        `Dry run: ${entries.length} session(s) in the trash would be deleted permanently. Run with --empty --yes to delete them.`,
      );
      return 0;
    }
    io.out(
      `Deleted ${historyManager.emptyTrash()} session(s) from the trash permanently.`,
    );
    return 0;
  }
  const entries = historyManager.listTrash();
  if (options.json) {
    io.out(
      JSON.stringify({
        sessions: entries.map((e) => ({
          id: e.sessionId,
          title: e.metadata.title,
          workspaceDirectory: e.metadata.workspaceDirectory,
          deletedAt: new Date(e.deletedAt).toISOString(),
          purgeAfter: new Date(e.purgeAfter).toISOString(),
          bytes: e.bytes,
        })),
      }),
    );
    return 0;
  }
  if (entries.length === 0) {
    io.out("The trash is empty.");
    return 0;
  }
  io.out(
    `${entries.length} deleted session(s), each kept 7 days after deletion:`,
  );
  for (const e of entries) {
    io.out(
      `  ${e.sessionId}  ${e.metadata.title || "(untitled)"}  deleted ${day(e.deletedAt)}, removed after ${day(e.purgeAfter)}, ${formatMegabytes(e.bytes)}`,
    );
  }
  io.out("Restore one with: continuous sessions restore <id>");
  return 0;
}

/** Puts a trashed session back in the list. */
export function sessionsRestoreCommand(
  sessionId: string,
  io: Io = consoleIo,
): number {
  try {
    const restored = historyManager.restore(sessionId);
    io.out(
      `Restored "${restored.title || "(untitled)"}" (${sessionId}). Resume it with: continuous --resume ${sessionId}`,
    );
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
