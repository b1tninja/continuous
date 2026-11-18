/**
 * `continuous reset --sessions | --trust | --permissions | --caches | --all
 * [--yes]`: put this product's own state back to "as installed", one scope at
 * a time, keeping the models and keys.
 *
 * A dry run unless --yes: it lists each path, its size and its file count.
 * With --yes nothing is deleted: every entry is moved into
 * `<global folder>/reset-backups/<time>/` at the same relative path, so an
 * undo is a move back. Only names listed below, directly in the global
 * folder, are touched. `~/.continue` (the folder of the product this one was
 * forked from) and anything outside the global folder never are, and a
 * global folder that is, or is inside, `~/.continue`, a home folder or a
 * drive root is refused.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getGlobalDirPath, LEGACY_GLOBAL_DIR_NAME } from "core/util/paths.js";

export type ResetScope = "sessions" | "trust" | "permissions" | "caches";

export const RESET_SCOPES: readonly ResetScope[] = [
  "sessions",
  "trust",
  "permissions",
  "caches",
];

interface ScopeEntry {
  name: string;
  /** For a folder: children that stay where they are. */
  keep?: string[];
}

export const RESET_SCOPE_INFO: Record<
  ResetScope,
  { what: string; entries: ScopeEntry[] }
> = {
  sessions: {
    what: "saved sessions and the prompt input history",
    entries: [
      { name: "sessions" },
      { name: "sessions-trash" },
      { name: "input_history.json" },
    ],
  },
  trust: {
    what: "trusted projects, trusted hooks and pinned MCP tool definitions",
    entries: [
      { name: "trusted-project.json" },
      { name: "trusted-hooks.json" },
      { name: "mcp-tool-pins.json" },
    ],
  },
  permissions: {
    what: "permission levels, rules, floor and Protection switches",
    entries: [{ name: "permissions.yaml" }],
  },
  caches: {
    what: "what the product rebuilds by itself: the code index, the Bedrock model list, diffs",
    entries: [
      { name: "index", keep: ["globalContext.json"] },
      { name: "bedrock-catalog" },
      { name: ".diffs" },
    ],
  },
};

/** The folder backups go to, inside the global folder. */
export const RESET_BACKUP_DIR = "reset-backups";

export const RESET_KEEPS =
  "Not touched: config.yaml, providers.yaml, models.yaml, .env, settings.json, audit/, logs/, rules/, skills/, ~/.continue and anything outside the global folder.";

export interface ResetItem {
  scope: ResetScope;
  /** Relative to the global folder, with forward slashes. */
  relative: string;
  path: string;
  kind: "file" | "folder" | "link";
  files: number;
  bytes: number;
}

export interface ResetPlan {
  root: string;
  items: ResetItem[];
  /** Why nothing may be touched, when that is the case. */
  refused?: string;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function fold(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(fold(parent), fold(child));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Why `root` must not be reset, or undefined when it may be. */
export function refuseRoot(root: string, homeDir: string): string | undefined {
  const real = realPath(root);
  const home = realPath(homeDir);
  const legacy = realPath(path.join(homeDir, LEGACY_GLOBAL_DIR_NAME));
  if (isInside(real, legacy)) {
    return `${root} is ~/${LEGACY_GLOBAL_DIR_NAME}, the folder of another product. Nothing there is changed.`;
  }
  if (fold(real) === fold(home) || path.parse(real).root === real) {
    return `${root} is a home folder or a drive root, not this product's own folder. Nothing was changed.`;
  }
  return undefined;
}

/** File count and bytes under `p`, never following a link. */
function measure(p: string): Pick<ResetItem, "kind" | "files" | "bytes"> {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink()) return { kind: "link", files: 1, bytes: 0 };
  if (!stat.isDirectory()) return { kind: "file", files: 1, bytes: stat.size };
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(p)) {
    const inner = measure(path.join(p, name));
    files += inner.files;
    bytes += inner.bytes;
  }
  return { kind: "folder", files, bytes };
}

function itemsFor(root: string, scope: ResetScope): ResetItem[] {
  const items: ResetItem[] = [];
  const add = (relative: string) => {
    const p = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(p) && !isLink(p)) return;
    items.push({ scope, relative, path: p, ...measure(p) });
  };
  for (const entry of RESET_SCOPE_INFO[scope].entries) {
    const p = path.join(root, entry.name);
    const keep = entry.keep ?? [];
    if (keep.length && isFolder(p)) {
      for (const child of fs.readdirSync(p).sort()) {
        if (!keep.includes(child)) add(`${entry.name}/${child}`);
      }
    } else {
      add(entry.name);
    }
  }
  return items;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFolder(p: string): boolean {
  try {
    const stat = fs.lstatSync(p);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** What the scopes hold, in the global folder `root`. Reads only. */
export function planReset(
  root: string,
  scopes: readonly ResetScope[],
  homeDir: string = os.homedir(),
): ResetPlan {
  const refused = refuseRoot(root, homeDir);
  if (refused) return { root, items: [], refused };
  if (!isFolder(root)) return { root, items: [] };
  const real = realPath(root);
  return {
    root,
    items: scopes.flatMap((scope) => itemsFor(real, scope)),
  };
}

export interface ResetResult {
  backup: string;
  moved: string[];
  failed: { relative: string; error: string }[];
}

/** `reset-backups/2026-11-12T20-15-03-123Z`: sortable, and legal on Windows. */
export function backupFolderName(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Moves every item into the backup folder. Nothing is deleted. A failure
 * (a file another process holds open, on Windows) is reported, and the rest
 * go on.
 */
export function runReset(plan: ResetPlan, now: Date = new Date()): ResetResult {
  const backup = path.join(
    realPath(plan.root),
    RESET_BACKUP_DIR,
    backupFolderName(now),
  );
  const result: ResetResult = { backup, moved: [], failed: [] };
  if (plan.refused) return result;
  for (const item of plan.items) {
    const target = path.join(backup, ...item.relative.split("/"));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(item.path, target);
      result.moved.push(item.relative);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? "error";
      result.failed.push({ relative: item.relative, error: code });
    }
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export interface ResetCommandOptions {
  sessions?: boolean;
  trust?: boolean;
  permissions?: boolean;
  caches?: boolean;
  all?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Global folder; default the real one (tests pass a temp dir). */
  root?: string;
  /** For tests: the home folder `~/.continue` is under. */
  homeDir?: string;
  now?: Date;
}

export function chosenScopes(options: ResetCommandOptions): ResetScope[] {
  return options.all
    ? [...RESET_SCOPES]
    : RESET_SCOPES.filter((scope) => options[scope]);
}

function itemLine(item: ResetItem): string {
  const size =
    item.kind === "folder"
      ? `${item.files} file${item.files === 1 ? "" : "s"}, ${formatBytes(item.bytes)}`
      : item.kind === "link"
        ? "a link (moved, not followed)"
        : formatBytes(item.bytes);
  return `  ${item.scope.padEnd(12)} ${item.path}  (${size})`;
}

function usageLines(): string[] {
  return [
    "Usage: continuous reset <scope...> [--yes]",
    ...RESET_SCOPES.map(
      (scope) => `  --${scope.padEnd(12)} ${RESET_SCOPE_INFO[scope].what}`,
    ),
    `  --${"all".padEnd(12)} all of the above`,
    "Without --yes nothing is changed. With --yes each entry is moved to a backup folder, not deleted.",
  ];
}

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

function reportPlan(plan: ResetPlan, apply: boolean, io: Io): void {
  const total = plan.items.reduce((n, i) => n + i.bytes, 0);
  io.out(`Global folder: ${plan.root}`);
  if (plan.items.length === 0) {
    io.out("Nothing to reset in the chosen scopes.");
    return;
  }
  io.out(
    apply
      ? "Moving to a backup folder (nothing is deleted):"
      : "Would move to a backup folder (nothing is deleted):",
  );
  plan.items.forEach((item) => io.out(itemLine(item)));
  io.out(`Total: ${plan.items.length} entries, ${formatBytes(total)}.`);
  io.out(RESET_KEEPS);
}

/** Exit code: 0 done or dry run, 1 a move failed, 2 refused or no scope. */
export function resetCommand(
  options: ResetCommandOptions,
  io: Io = consoleIo,
): number {
  const scopes = chosenScopes(options);
  if (scopes.length === 0) {
    usageLines().forEach((line) => io.err(line));
    return 2;
  }
  const root = options.root ?? getGlobalDirPath();
  const plan = planReset(root, scopes, options.homeDir);
  if (plan.refused) {
    io.err(plan.refused);
    return 2;
  }
  const apply = !!options.yes && plan.items.length > 0;
  const result = apply ? runReset(plan, options.now) : undefined;
  if (options.json) {
    // plan carries root and items
    io.out(JSON.stringify({ scopes, applied: apply, ...plan, result }));
    return result?.failed.length ? 1 : 0;
  }
  reportPlan(plan, apply, io);
  if (!result) {
    if (plan.items.length) {
      io.out(
        "Dry run: nothing was moved. Close other Continuous sessions, then run again with --yes.",
      );
    }
    return 0;
  }
  io.out(`Moved ${result.moved.length} to ${result.backup}`);
  io.out("To undo, move them back from that folder.");
  for (const failure of result.failed) {
    io.err(`Not moved: ${failure.relative} (${failure.error})`);
  }
  return result.failed.length ? 1 : 0;
}
