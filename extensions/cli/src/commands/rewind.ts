/**
 * `continuous rewind <session> [--to <n>]`: the `/rewind` picker without the
 * TUI, for scripts and for a session that is not open. With no `--to` it
 * lists the prompts; `--to <n>` restores to before prompt n; `--redo` undoes
 * the last rewind. A file changed outside the agent since its last write
 * stops the command (nothing is changed) unless `--yes` overwrites it or
 * `--skip-changed` leaves it and restores the rest.
 */
import fs from "fs";

import type { Command } from "commander";
import type { Session } from "core/index.js";
import type { Io } from "core/util/secretScan/secretsCli.js";

import { isSafeSessionId } from "../checkpoints/model.js";
import {
  applyRedo,
  applyRewind,
  buildRewindEntries,
  describeItems,
  NOT_COVERED_NOTE,
  previewFiles,
  type RewindEntry,
  type RewindMode,
  type RewindOutcome,
} from "../checkpoints/rewind.js";
import type { CheckpointStore } from "../checkpoints/store.js";
import { gracefulExit } from "../util/exit.js";

export interface RewindCommandOptions {
  to?: string;
  mode?: string;
  redo?: boolean;
  yes?: boolean;
  skipChanged?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface RewindDeps {
  loadSession: (id: string) => Session | null;
  saveSession: (session: Session) => void;
  storeFor: (id: string) => CheckpointStore;
}

const consoleIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

const MODES: RewindMode[] = ["files", "conversation", "both"];

function report(io: Io, json: boolean, data: object, lines: string[]) {
  if (json) io.out(JSON.stringify(data));
  else for (const l of lines) io.out(l);
}

function saveHistory(
  deps: RewindDeps,
  session: Session,
  outcome: RewindOutcome,
): void {
  if (outcome.history) {
    deps.saveSession({ ...session, history: outcome.history });
  }
}

function redoCommand(
  store: CheckpointStore,
  session: Session,
  options: RewindCommandOptions,
  deps: RewindDeps,
  io: Io,
): number {
  const json = !!options.json;
  const cwd = session.workspaceDirectory || process.cwd();
  const items = store.redoRecord() ? store.planRedo() : undefined;
  if (!items) {
    report(io, json, { redo: false }, ["Nothing to redo."]);
    return 1;
  }
  const changed = items.filter((i) => i.changedOutside);
  if (changed.length && !options.yes && !options.skipChanged) {
    report(io, json, { refused: true, items }, [
      `${changed.length} file(s) changed since the rewind; nothing was changed:`,
      ...describeItems(changed, cwd).map((l) => `  ${l}`),
      "Run again with --yes to overwrite them or --skip-changed to leave them.",
    ]);
    return 1;
  }
  if (options.dryRun) {
    report(io, json, { dryRun: true, items }, [
      "Redo would change:",
      ...describeItems(items, cwd).map((l) => `  ${l}`),
    ]);
    return 0;
  }
  const outcome = applyRedo(store, session.history, {
    confirmChanged: !!options.yes,
    cwd,
  })!;
  saveHistory(deps, session, outcome);
  report(io, json, { result: outcome.result }, outcome.lines);
  return outcome.result.failed.length ? 1 : 0;
}

function listCommand(
  store: CheckpointStore,
  session: Session,
  entries: RewindEntry[],
  json: boolean,
  io: Io,
): number {
  const lines = entries.map((e) => {
    const files = e.files.length ? `  (${e.files.length} file(s))` : "";
    const gone =
      e.historyIndex === undefined ? "  (not in the conversation)" : "";
    return `${String(e.number).padStart(3)}. ${e.label}${files}${gone}`;
  });
  report(
    io,
    json,
    {
      sessionId: session.sessionId,
      redo: !!store.redoRecord(),
      entries: entries.map((e) => ({
        number: e.number,
        label: e.label,
        files: e.files,
        inConversation: e.historyIndex !== undefined,
      })),
    },
    [
      entries.length
        ? `Prompts in ${session.sessionId}:`
        : "No prompts to rewind to.",
      ...lines,
      NOT_COVERED_NOTE,
      "Rewind with: continuous rewind <session> --to <n> [--mode files|conversation|both]",
    ],
  );
  return 0;
}

export function rewindCommand(
  sessionId: string,
  options: RewindCommandOptions,
  deps: RewindDeps,
  io: Io = consoleIo,
): number {
  const json = !!options.json;
  const mode = (options.mode ?? "files") as RewindMode;
  if (!MODES.includes(mode)) {
    io.err(`Bad --mode "${options.mode}": use files, conversation or both.`);
    return 2;
  }
  const session = deps.loadSession(sessionId);
  if (!session) {
    io.err(`No session ${sessionId}. List sessions with: continuous ls`);
    return 2;
  }
  let store: CheckpointStore;
  try {
    store = deps.storeFor(session.sessionId);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const cwd = session.workspaceDirectory || process.cwd();
  const entries = buildRewindEntries(session.history, store.turns());

  if (options.redo) {
    return redoCommand(store, session, options, deps, io);
  }

  if (options.to === undefined) {
    return listCommand(store, session, entries, json, io);
  }

  const n = Number(options.to);
  const entry = entries.find((e) => e.number === n);
  if (!entry) {
    io.err(
      `No prompt ${options.to}: pick 1 to ${entries.length} (run without --to to list them).`,
    );
    return 2;
  }
  if (mode !== "files" && entry.historyIndex === undefined) {
    io.err(
      `Prompt ${n} is no longer in the conversation; only --mode files works for it.`,
    );
    return 2;
  }
  const items = mode === "conversation" ? [] : previewFiles(store, entry);
  const changed = items.filter((i) => i.changedOutside);
  if (changed.length && !options.yes && !options.skipChanged) {
    report(io, json, { refused: true, items }, [
      `${changed.length} file(s) changed outside the agent since its last write; nothing was changed:`,
      ...describeItems(changed, cwd).map((l) => `  ${l}`),
      "Run again with --yes to overwrite them or --skip-changed to leave them.",
    ]);
    return 1;
  }
  if (options.dryRun) {
    report(io, json, { dryRun: true, items }, [
      `Rewinding to before "${entry.label}" (${mode}) would change:`,
      ...(items.length
        ? describeItems(items, cwd).map((l) => `  ${l}`)
        : ["  no files"]),
      NOT_COVERED_NOTE,
    ]);
    return 0;
  }
  const outcome = applyRewind(store, session.history, entry, mode, {
    confirmChanged: !!options.yes,
    cwd,
  });
  saveHistory(deps, session, outcome);
  report(io, json, { result: outcome.result }, [
    ...outcome.lines,
    NOT_COVERED_NOTE,
  ]);
  return outcome.result.failed.length ? 1 : 0;
}

/** Adds `continuous rewind` to the program. */
export function registerRewindCommand(program: Command): void {
  program
    .command("rewind <session>")
    .description(
      "List a session's prompts, or restore the files the agent's Edit, MultiEdit and Write changed since one (--to), rewind its conversation, or both. Files changed by shell commands are not covered",
    )
    .option("--to <n>", "Rewind to before prompt n (from the list)")
    .option("--mode <mode>", "files (default), conversation, or both", "files")
    .option("--redo", "Undo the last rewind (until the agent writes again)")
    .option("--yes", "Overwrite files changed outside the agent")
    .option(
      "--skip-changed",
      "Leave files changed outside the agent, restore the rest",
    )
    .option("--dry-run", "Show what would change, change nothing")
    .option("--json", "Machine-readable output")
    .action(async (session: string, options: RewindCommandOptions) => {
      const [{ loadSessionById }, history, { checkpointStoreFor }, paths] =
        await Promise.all([
          import("../session.js"),
          import("core/util/history.js"),
          import("../checkpoints/sessionCheckpoints.js"),
          import("core/util/paths.js"),
        ]);
      const code = rewindCommand(session, options, {
        // A missing file would load as an empty session: refuse it instead
        loadSession: (id) =>
          isSafeSessionId(id) && fs.existsSync(paths.getSessionFilePath(id))
            ? loadSessionById(id)
            : null,
        saveSession: (s) => history.default.save(s),
        storeFor: checkpointStoreFor,
      });
      await gracefulExit(code);
    });
}
