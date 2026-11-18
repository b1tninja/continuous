/**
 * Whether git-ai may run at all, and which executable that means.
 *
 * git-ai is an external program, run with the workspace as its working
 * directory. Two things a cloned repository must not be able to do: switch it
 * on, and supply the program. So the switch is the user's own `settings.json`
 * in their Continuous folder, and the program is looked up on PATH ourselves,
 * skipping relative entries and anything inside the workspace, then run by its
 * absolute path (on Windows a bare name is also searched for in the current
 * directory, which is the workspace).
 */

import * as fs from "fs";
import * as path from "path";

import { getGlobalDir, realPath } from "../hooks/hookTrust.js";

/** True only when the user's settings.json says `"gitAiIntegration": true`. */
export function isGitAiOptedIn(cwd: string = process.cwd()): boolean {
  const dir = getGlobalDir(cwd);
  if (!dir) return false;
  try {
    const file = path.join(dir, "settings.json");
    if (!fs.existsSync(file)) return false;
    return (
      JSON.parse(fs.readFileSync(file, "utf-8"))?.gitAiIntegration === true
    );
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The absolute path of `git-ai` on PATH, or null. Relative PATH entries
 * (including "" and ".") and entries inside `workspaceDir` are skipped.
 */
export function resolveGitAiBinary(
  workspaceDir: string,
  pathEnv: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!pathEnv) return null;
  const workspace = realPath(workspaceDir);
  const names =
    platform === "win32" ? ["git-ai.exe", "git-ai.com"] : ["git-ai"];

  for (const entry of pathEnv.split(platform === "win32" ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir)) continue;
    if (isInside(realPath(dir), workspace)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        const real = fs.realpathSync(candidate);
        if (isInside(real, workspace)) continue;
        if (!fs.statSync(real).isFile()) continue;
        if (platform !== "win32") fs.accessSync(real, fs.constants.X_OK);
        return real;
      } catch {
        // not here
      }
    }
  }
  return null;
}
