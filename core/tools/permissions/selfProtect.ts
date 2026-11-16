import * as os from "node:os";
import type { ShellKind } from "../../util/shell";
import {
  GLOBAL_DIR_NAME,
  LEGACY_GLOBAL_DIR_NAME,
} from "../../util/productPaths";
import { commandCandidateSet } from "./candidates";
import { isLockedProductPath } from "./lockedPaths";
import { normalizeProtectedPath } from "./protected";
import {
  isPowerShellProfilePath,
  POWERSHELL_PROFILE_VARIABLE,
} from "./protectedPaths";
import { pathWords, wordsOf } from "./protectedCall";
import { classifyReadOnly } from "./readOnlyCommand";

/**
 * The permission and policy files protect themselves. A call that would write
 * or delete one is a locked floor: no setting, rule or level below IDGAF lets
 * it run unasked, because a model that can edit the policy can undo every
 * other protection. IDGAF runs it and records it (evaluate.ts,
 * idgafRunsEverything). `protect-config` is a separate, switchable rule over
 * the wider set of files that change what runs later; this one has no switch.
 *
 * What counts is every path the product loads as config, code, rules or hooks,
 * read from PRODUCT_LOADED_PATHS (core/util/productPaths.ts, applied in
 * lockedPaths.ts): the global folder (`~/.continuous`, `~/.continue` and the
 * folder CONTINUOUS_GLOBAL_DIR or CONTINUE_GLOBAL_DIR names), a project's
 * `.continuous` and `.continue` folders, `.claude` settings, agents and skills,
 * and `.continuerc.*`.
 *
 * Like protected paths this reads the path as written and resolved, and a
 * terminal command by its words: it is a guard that sees what is visible, not
 * a sandbox. A path built at run time (a variable, a glob, a backtick, a bare
 * name after a `cd` into the home folder) is not seen: at IDGAF a command with
 * such a write target asks (runtimeWriteTarget.ts, ROADMAP B31), and the
 * sandbox that denies writes to these folders (W8) is what holds for certain.
 */
export interface PolicyFileHit {
  /** The path as it was matched, for the message. */
  path: string;
  /** The scan gave up (too large or too deep): the call asks, and is not refused. */
  capped?: boolean;
}

export const POLICY_FILE_REASON =
  "This would change your permission or policy files, or a file the product loads as config, rules or hooks, which no setting lets the agent change without you.";

/** The default global folders and the one an env var names, as comparable paths. */
export function globalDirsFor(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const named = env.CONTINUOUS_GLOBAL_DIR || env.CONTINUE_GLOBAL_DIR;
  const dirs = [`~/${GLOBAL_DIR_NAME}`, `~/${LEGACY_GLOBAL_DIR_NAME}`];
  if (named) dirs.push(normalizeProtectedPath(named, home, process.cwd()));
  return dirs;
}

/** A normalized (forward-slash, lower-cased on compare) path of a policy file. */
export function isPolicyFilePath(
  p: string,
  globalDirs?: string[],
  cwd?: string,
): boolean {
  return isLockedProductPath(p, { globalDirs, cwd });
}

function policyPathHit(
  raw: string | undefined,
  home: string,
  cwd?: string,
): PolicyFileHit | undefined {
  if (!raw) return undefined;
  const path = normalizeProtectedPath(raw, home, cwd);
  if (!path) return undefined;
  const globalDirs = globalDirsFor(home);
  const normCwd = cwd ? normalizeProtectedPath(cwd, home) : undefined;
  return isPolicyFilePath(path, globalDirs, normCwd) ? { path } : undefined;
}

const NO_READERS: ReadonlySet<string> = new Set();

/**
 * Programs that only print or test a file. `$PROFILE` keeps the parser from
 * vouching `Get-Content $PROFILE` as read-only, and a refusal of a read at
 * Automatic would only be noise, so their candidates are not profile writes.
 */
const PROFILE_READERS: ReadonlySet<string> = new Set([
  "get-content",
  "gc",
  "cat",
  "type",
  "test-path",
  "get-item",
  "select-string",
  "sls",
  "more",
]);

/** One path word, matched against one list of files. */
type PathMatch = (
  raw: string | undefined,
  home: string,
  cwd?: string,
) => PolicyFileHit | undefined;

/** D-012: a PowerShell profile, as a path or as `$PROFILE`. */
function profilePathHit(
  raw: string | undefined,
  home: string,
  cwd?: string,
): PolicyFileHit | undefined {
  if (!raw) return undefined;
  if (POWERSHELL_PROFILE_VARIABLE.test(raw.trim())) return { path: raw.trim() };
  const path = normalizeProtectedPath(raw, home, cwd);
  return path && isPowerShellProfilePath(path) ? { path } : undefined;
}

const WRITE_TOOLS = new Set([
  "create_new_file",
  "edit_existing_file",
  "single_find_and_replace",
  "multi_edit",
]);

/** git subcommands that only read the index or history, or stage and commit. */
const GIT_NOT_WRITING = new Set([
  "add",
  "commit",
  "diff",
  "log",
  "show",
  "status",
  "blame",
  "ls-files",
  "check-ignore",
  "grep",
]);

function terminalHit(
  command: string,
  home: string,
  cwd: string | undefined,
  shell: ShellKind | undefined,
  match: PathMatch,
  readers: ReadonlySet<string> = NO_READERS,
): PolicyFileHit | undefined {
  // A command the parser vouched as only reading cannot write.
  if (classifyReadOnly(command, { cwd, shell }).vouched) return undefined;
  const { list } = commandCandidateSet(command, shell);
  const reading = new Set(
    wordsOf(list).flatMap((w, i) =>
      (w[0] === "git" && GIT_NOT_WRITING.has(w[1] ?? "")) ||
      readers.has((w[0] ?? "").toLowerCase())
        ? [list[i]]
        : [],
    ),
  );
  // Candidates derived from a git command that only stages or reads (the
  // command without `git`, its path argument alone) are not writes either.
  // (PowerShell's candidates are also lower-cased, so the test folds case.)
  const readingLow = [...reading].map((r) => r.toLowerCase());
  const considered = list.filter(
    (c) => !readingLow.some((r) => r.includes(c.toLowerCase())),
  );
  for (const word of pathWords(considered)) {
    const hit = match(word, home, cwd);
    if (hit) return hit;
  }
  return undefined;
}

const MCP_MAX_DEPTH = 12;
const MCP_MAX_STRINGS = 2000;

/**
 * Every string in an MCP call's arguments, keys included. `capped` is set when
 * the tree is deeper or larger than the scan reads, which cannot be vouched for.
 */
function stringArgs(root: unknown): { strings: string[]; capped: boolean } {
  const strings: string[] = [];
  let capped = false;
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop()!;
    if (typeof value === "string") {
      if (strings.length >= MCP_MAX_STRINGS) capped = true;
      else strings.push(value);
    } else if (value && typeof value === "object") {
      if (depth >= MCP_MAX_DEPTH) {
        capped = true;
        continue;
      }
      for (const [k, v] of Object.entries(value)) {
        strings.push(k);
        stack.push([v, depth + 1]);
      }
    }
  }
  return { strings, capped };
}

export interface WriteTargetArgs {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  resolvedPath?: string;
  mcp?: { readonly?: boolean };
  home?: string;
  cwd?: string;
  shell?: ShellKind;
}

/**
 * Would this call write or delete a policy file? `mcp` is set for an MCP
 * tool, with its `readonly` hint: a tool that says it only reads is skipped,
 * any other MCP call naming such a path in its arguments is a hit.
 */
export function policyFileHit(
  args: WriteTargetArgs,
): PolicyFileHit | undefined {
  return writeTargetHit(args, policyPathHit);
}

/**
 * Would this call write a PowerShell profile (D-012)? Read the same way as a
 * policy file: a file tool's target, a command's words unless the parser
 * vouched it only reads, an MCP call's arguments.
 */
export function profileWriteHit(
  args: WriteTargetArgs,
): PolicyFileHit | undefined {
  return writeTargetHit(args, profilePathHit, PROFILE_READERS);
}

function writeTargetHit(
  args: WriteTargetArgs,
  match: PathMatch,
  readers?: ReadonlySet<string>,
): PolicyFileHit | undefined {
  const { toolName, parsedArgs, resolvedPath, cwd } = args;
  const home = args.home ?? os.homedir();
  if (toolName === "run_terminal_command") {
    const command = parsedArgs.command;
    return typeof command === "string"
      ? terminalHit(command, home, cwd, args.shell, match, readers)
      : undefined;
  }
  if (args.mcp) {
    if (args.mcp.readonly) return undefined;
    const { strings, capped } = stringArgs(parsedArgs);
    for (const value of strings) {
      // A string may be a path or a sentence that holds one (`type x > C:/...`).
      for (const word of [value, ...value.split(/[\s"'`=<>|;&,()]+/)]) {
        const hit = match(word, home, cwd);
        if (hit) return hit;
      }
    }
    return capped
      ? { path: "(arguments too large to read)", capped }
      : undefined;
  }
  if (!WRITE_TOOLS.has(toolName)) return undefined;
  const written =
    typeof parsedArgs.filepath === "string" ? parsedArgs.filepath : undefined;
  return match(written, home, cwd) ?? match(resolvedPath, home, cwd);
}
