/**
 * What the `cn` wrapper (src/cn.ts) does before it loads the CLI bundle.
 *
 * Imports only Node built-ins: anything imported here is paid for by every
 * invocation, `--version` included.
 */
import { existsSync, readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the arguments ask for the version and nothing else. Any other
 * combination (`serve --version`, `-p --version`, two flags) goes to the
 * bundle, so commander keeps deciding what those mean.
 */
export function isVersionOnlyInvocation(args: readonly string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

/**
 * The version in the package.json beside `dist/`, read the way
 * src/version.ts reads it. Null when it cannot be read, so the caller falls
 * back to the bundle and its warning.
 */
export function readPackageVersion(entryUrl: string): string | null {
  try {
    const packageJsonPath = fileURLToPath(new URL("../package.json", entryUrl));
    const version = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * Answers `cn --version` and `cn -v` without loading the bundle. Returns
 * whether it did. The output is what commander prints: the version and a
 * newline on stdout, exit code 0.
 */
export function answerVersionFast(
  args: readonly string[],
  entryUrl: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
): boolean {
  if (!isVersionOnlyInvocation(args)) {
    return false;
  }
  const version = readPackageVersion(entryUrl);
  if (version === null) {
    return false;
  }
  write(`${version}\n`);
  return true;
}

/**
 * Where the compiled-code cache goes: `cache/compile` under the global folder
 * (`~/.continuous`, or CONTINUOUS_GLOBAL_DIR / CONTINUE_GLOBAL_DIR as core
 * reads them). Null when that folder does not exist yet: on a first run core
 * copies `~/.continue` into it only if it is missing, so the wrapper must not
 * be what creates it.
 */
export function compileCacheDirectory(
  env: NodeJS.ProcessEnv,
  home: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const configured = env.CONTINUOUS_GLOBAL_DIR || env.CONTINUE_GLOBAL_DIR;
  let globalDir = join(home, ".continuous");
  if (configured) {
    globalDir = isAbsolute(configured) ? configured : resolve(configured);
  }
  return exists(globalDir) ? join(globalDir, "cache", "compile") : null;
}

type EnableCompileCache = (directory?: string) => unknown;

/**
 * Turns on Node's compile cache for the bundle that is about to be imported,
 * where this Node has one (22.8 and later). The bundle is 18 MB and compiling
 * it is about a third of start-up; with the cache a later start reads the
 * compiled code back.
 *
 * Off switches are Node's own: NODE_DISABLE_COMPILE_CACHE=1 turns it off, and
 * NODE_COMPILE_CACHE=<dir> has already turned it on with that folder, so it
 * is left alone. Returns the folder asked for, or null when nothing was done.
 */
export function enableCliCompileCache(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  enable: EnableCompileCache | null = (
    nodeModule as { enableCompileCache?: EnableCompileCache }
  ).enableCompileCache ?? null,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (enable === null || env.NODE_COMPILE_CACHE) {
    return null;
  }
  const directory = compileCacheDirectory(env, home, exists);
  if (directory === null) {
    return null;
  }
  try {
    enable(directory);
    return directory;
  } catch {
    // A cache that cannot be set up must never stop the CLI from starting
    return null;
  }
}
