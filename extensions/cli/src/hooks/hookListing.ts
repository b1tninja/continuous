/**
 * The user's own hook files, for `continuous hooks`. Reading is separate from
 * loading: this is for showing, and a file that cannot be read is reported
 * rather than skipped.
 */

import * as fs from "fs";

import { getUserSettingsFilePaths } from "./hookConfig.js";
import type { ProjectHookFile } from "./hookTrust.js";
import type { HooksConfig } from "./types.js";

export interface UserHookFile extends ProjectHookFile {
  /** The file exists but is not a JSON object; its hooks do not run. */
  unreadable?: boolean;
}

/**
 * The user's settings files (`~/.claude/settings.json` and the Continuous one)
 * that exist and define hooks, or switch them off, or cannot be read. The
 * reason a file cannot be read is not repeated: a parser message can quote the
 * file.
 */
export function getUserHookFiles(
  cwd: string,
  homeDir?: string,
): UserHookFile[] {
  const files: UserHookFile[] = [];
  for (const filePath of getUserSettingsFilePaths(cwd, homeDir)) {
    if (!fs.existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      files.push({ path: filePath, hooks: {}, unreadable: true });
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      files.push({ path: filePath, hooks: {}, unreadable: true });
      continue;
    }
    const settings = parsed as {
      hooks?: HooksConfig;
      disableAllHooks?: boolean;
    };
    if (!settings.hooks && !settings.disableAllHooks) continue;
    files.push({
      path: filePath,
      hooks: settings.hooks ?? {},
      disableAllHooks: settings.disableAllHooks,
    });
  }
  return files;
}
