/**
 * The start-up check for a headless run (`cn -p`, `cn serve`): a hook settings
 * file or permissions.yaml that is present but broken stops the start.
 * Without this the broken file reads as "no policy" and the run goes ahead
 * with the guards the person wrote missing (headless defaults allow Bash).
 */

import { findBrokenHookFiles } from "../hooks/hookConfig.js";
import { safeStderr } from "../init.js";
import { readPermissionsYaml } from "../permissions/permissionsYamlLoader.js";
import { isSafeMode } from "../safeMode.js";

import { gracefulExit } from "./exit.js";
import {
  type BrokenConfigFile,
  formatBrokenConfigRefusal,
  noticeBrokenConfig,
  setIgnoreBrokenConfigForRun,
} from "./readPolicyFile.js";

/** Exit code of a headless start refused over a broken policy file. */
export const BROKEN_CONFIG_EXIT_CODE = 2;

/** Where to look, for tests. Defaults are the real home and global folder. */
export interface ConfigFileLocations {
  homeDir?: string;
  permissionsFile?: string;
}

export function findBrokenConfigFiles(
  cwd: string,
  where: ConfigFileLocations = {},
): BrokenConfigFile[] {
  const broken: BrokenConfigFile[] = [
    ...findBrokenHookFiles(cwd, where.homeDir),
  ];
  const permissions = readPermissionsYaml(where.permissionsFile);
  if (permissions.status === "broken") {
    broken.push({ path: permissions.path, error: permissions.error });
  }
  return broken;
}

/**
 * Returns the refusal text when the run must not start, or undefined. With
 * `ignoreBrokenConfig` nothing is refused and each file is noticed once.
 */
export function checkConfigFiles(
  cwd: string,
  ignoreBrokenConfig: boolean,
  where: ConfigFileLocations = {},
): string | undefined {
  setIgnoreBrokenConfigForRun(ignoreBrokenConfig);
  const broken = findBrokenConfigFiles(cwd, where);
  if (broken.length === 0) return undefined;
  if (ignoreBrokenConfig) {
    broken.forEach((file) => noticeBrokenConfig(file, true));
    return undefined;
  }
  return formatBrokenConfigRefusal(broken);
}

/** Call at the start of a headless run or serve. Exits with code 2 on a refusal. */
export async function exitOnBrokenConfig(
  options: { ignoreBrokenConfig?: boolean },
  where: ConfigFileLocations = {},
): Promise<void> {
  // --safe does not read hooks or project files, and is the way out when a
  // broken one stops a start: it must not be refused by them
  if (isSafeMode()) return;
  const refusal = checkConfigFiles(
    process.cwd(),
    !!options.ignoreBrokenConfig,
    where,
  );
  if (!refusal) return;
  safeStderr(`${refusal}\n`);
  await gracefulExit(BROKEN_CONFIG_EXIT_CODE);
}
