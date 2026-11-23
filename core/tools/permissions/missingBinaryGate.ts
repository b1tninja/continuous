import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";
import type { CommandExecutor } from "../../util/commandExecutor";
import { isPosixShell } from "../../util/shell";
import { missingBinaryMessage, missingBinaryProblem } from "./missingBinary";

/**
 * The missing-program check wired to a real executor. A name is looked up on
 * the PATH first (with PATHEXT on Windows). A name that is not there is then
 * asked of the shell that will run the command (`command -v`, `Get-Command`),
 * because a login shell's profile defines functions (`nvm`, `conda`) and
 * PowerShell has cmdlets and functions no PATH search sees. Anything the probe
 * cannot answer counts as present: the command runs. Results are kept for
 * 60 seconds. A container executor is not probed (a probe is a container
 * start), so its commands are never stopped by this check.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; found: boolean }>();

/** For tests: forget what was looked up. */
export function resetMissingBinaryCache(): void {
  cache.clear();
}

/** The names a probe is written for: nothing the shell could read as syntax. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+@-]*$/;

export function onPath(
  name: string,
  opts: {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
    cwd?: string;
    isFile?: (file: string) => boolean;
  } = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const win = platform === "win32";
  const pathValue = (win ? (env.Path ?? env.PATH ?? env.path) : env.PATH) ?? "";
  const sep = win ? ";" : ":";
  const exts = win
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  const isFile =
    opts.isFile ??
    ((file: string) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  const dirs = pathValue.split(sep).filter(Boolean);
  for (const dir of dirs) {
    const base = opts.cwd ? path.resolve(opts.cwd, dir) : path.resolve(dir);
    for (const ext of exts) {
      if (isFile(path.join(base, name + ext))) return true;
    }
  }
  return false;
}

type Probe = (executor: CommandExecutor, name: string) => boolean | undefined;

/** Asks the shell that will run the command. undefined when it cannot say. */
const shellProbe: Probe = (executor, name) => {
  const kind = executor.shell.kind;
  let script: string;
  if (isPosixShell(kind)) {
    script = `if command -v ${name} >/dev/null 2>&1; then echo __CONT_FOUND__; else echo __CONT_MISSING__; fi`;
  } else if (kind === "powershell") {
    script = `if (Get-Command -Name '${name}' -ErrorAction SilentlyContinue) { 'CONT_FOUND' } else { 'CONT_MISSING' }`;
  } else {
    return undefined;
  }
  const { shell, args } = executor.invocation(script);
  try {
    const result = spawnSync(shell, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = String(result.stdout ?? "");
    if (/CONT_FOUND/.test(out)) return true;
    if (/CONT_MISSING/.test(out)) return false;
  } catch {
    // fall through: not known
  }
  return undefined;
};

export interface MissingBinaryGateOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  cwd?: string;
  now?: () => number;
  probe?: Probe;
  /** False when the person switched the shell check off */
  checkOn?: boolean;
  /** For tests: stands in for the PATH search */
  onPath?: (name: string) => boolean;
}

/**
 * The message that stands in for a command whose program is not there, or
 * undefined when the command may run. CONTINUE_MISSING_BINARY_CHECK=off skips it.
 */
export function missingBinaryGate(
  command: string,
  executor: CommandExecutor,
  opts: MissingBinaryGateOptions = {},
): string | undefined {
  const env = opts.env ?? process.env;
  if (env.CONTINUE_MISSING_BINARY_CHECK === "off") return undefined;
  // The same "Check shell commands" switch as the syntax lint
  if (opts.checkOn === false) return undefined;
  if (executor.kind === "container") return undefined;
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? shellProbe;
  const kind = executor.shell.kind;
  const wsl = executor.kind === "wsl";
  let cwd: string;
  try {
    cwd = opts.cwd ?? process.cwd();
  } catch {
    // no working folder to look in: the shell will report that itself
    return undefined;
  }
  const keyBase = `${executor.kind}|${executor.shell.executable}|${kind}|`;

  const hasProgram = (name: string): boolean => {
    const key = keyBase + name;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.found;
    let found: boolean;
    if (!SAFE_NAME.test(name)) {
      found = true;
    } else if (
      !wsl &&
      (opts.onPath ?? ((n) => onPath(n, { platform, env, cwd })))(name)
    ) {
      found = true;
    } else if (kind === "cmd") {
      // cmd has no profile; it also runs what is in the current folder
      found = onPath(name, { platform, env: { PATH: cwd, Path: cwd }, cwd });
    } else {
      found = probe(executor, name) ?? true;
    }
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: now(), found });
    return found;
  };

  const problem = missingBinaryProblem(command, {
    shell: kind,
    hasProgram,
    cwd,
  });
  if (!problem) return undefined;
  return missingBinaryMessage(problem, {
    shell: kind,
    hasProgram,
    cwd,
    where: executor.describe(),
    platform: wsl ? "linux" : platform,
  });
}
