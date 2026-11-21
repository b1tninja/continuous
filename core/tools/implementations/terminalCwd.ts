import * as fs from "node:fs";
import * as nodePath from "node:path";

/**
 * The working directory a terminal command was asked to run in.
 *
 * The shell does not keep a `cd` between calls, so an agent that works in a
 * sub-folder started 56% of its commands with a directory change (the usage
 * data). A `cwd` argument says it once, and the permission layer reads it as a
 * fact instead of parsing `Set-Location` out of the command text.
 *
 * It is narrower than what a command's own `cd` can do: the folder must be a
 * workspace folder or inside one, after links are followed. A folder anywhere
 * else is still reachable with `cd` in the command, where the path checks
 * judge it as before; nothing here loosens that.
 */
export type RequestedCwd =
  { ok: true; cwd: string; requested: boolean } | { ok: false; error: string };

export interface CwdFacts {
  /** The first workspace folder as a local path: where a call runs by default */
  defaultCwd: string;
  /** Every workspace folder as a local path */
  workspaceRoots: readonly string[];
  /** Follows links; throws when the path does not exist */
  realpath?: (p: string) => string;
  isDirectory?: (p: string) => boolean;
  /** Path rules to use (tests pass win32 or posix); the host's by default */
  path?: Pick<typeof nodePath, "resolve" | "relative" | "isAbsolute" | "sep">;
}

const defaultRealpath = (p: string) => fs.realpathSync.native(p);
const defaultIsDirectory = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** True when `child` is `root` or a folder or file below it. */
export function isInsideFolder(
  root: string,
  child: string,
  path: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep"> = nodePath,
): boolean {
  const rel = path.relative(root, child);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

export function resolveRequestedCwd(
  requested: unknown,
  facts: CwdFacts,
): RequestedCwd {
  const path = facts.path ?? nodePath;
  const realpath = facts.realpath ?? defaultRealpath;
  const isDirectory = facts.isDirectory ?? defaultIsDirectory;

  if (requested === undefined || requested === null) {
    return { ok: true, cwd: facts.defaultCwd, requested: false };
  }
  if (typeof requested !== "string") {
    return {
      ok: false,
      error: "cwd must be a string: a folder in the workspace.",
    };
  }
  const text = requested.trim();
  if (text === "") {
    return { ok: true, cwd: facts.defaultCwd, requested: false };
  }
  if (text.includes("\0")) {
    return { ok: false, error: "cwd is not a valid path." };
  }

  const wanted = path.resolve(facts.defaultCwd, text);
  let real: string;
  try {
    real = realpath(wanted);
  } catch {
    return {
      ok: false,
      error: `cwd "${text}" does not exist. Give a folder in the workspace, relative to ${facts.defaultCwd}.`,
    };
  }
  if (!isDirectory(real)) {
    return { ok: false, error: `cwd "${text}" is not a folder.` };
  }

  const roots = facts.workspaceRoots.map((r) => {
    try {
      return realpath(r);
    } catch {
      return r;
    }
  });
  if (!roots.some((r) => isInsideFolder(r, real, path))) {
    return {
      ok: false,
      error: `cwd "${text}" is outside the workspace. Use a folder inside it, or run the command with cd in it.`,
    };
  }
  return { ok: true, cwd: real, requested: true };
}

/**
 * The directory the permission layer should judge the command against: the
 * requested folder when it is valid, otherwise where the call would run by
 * default. It never throws: an invalid `cwd` is reported by the tool when it
 * runs, and the policy then reads the command from the default folder.
 */
export function effectiveCwdForPolicy(
  requested: unknown,
  facts: CwdFacts,
): string {
  const r = resolveRequestedCwd(requested, facts);
  return r.ok ? r.cwd : facts.defaultCwd;
}
