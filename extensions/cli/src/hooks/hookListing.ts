/**
 * The user's own hook files, for `continuous hooks`. Reading is separate from
 * loading: this is for showing, and a file that cannot be read is reported
 * rather than skipped.
 */

import * as fs from "fs";
import * as path from "path";

import {
  type SkippedClaudeHooks,
  getClaudeUserSettingsPath,
  getUserSettingsFilePaths,
  liftReadClaudeSettings,
  readClaudeSettingsSetting,
} from "./hookConfig.js";
import { getGlobalDir } from "./hookTrust.js";
import type { ProjectHookFile } from "./hookTrust.js";
import type { HookSettingsFile } from "./types.js";

export interface UserHookFile extends ProjectHookFile {
  /** The file exists but is not a JSON object; its hooks do not run. */
  unreadable?: boolean;
  /**
   * `~/.claude/settings.json` while `hooks.readClaudeSettings` is not `true`:
   * its hooks are listed but do not run.
   */
  notRead?: boolean;
}

/**
 * The user's settings files (`~/.claude/settings.json` and the Continuous one)
 * that exist and define hooks, or switch them off, or cannot be read. The
 * `~/.claude` file is marked `notRead` unless the user opted in to it. The
 * reason a file cannot be read is not repeated: a parser message can quote the
 * file.
 */
export function getUserHookFiles(
  cwd: string,
  homeDir?: string,
): UserHookFile[] {
  const files: UserHookFile[] = [];
  const claudePath = getClaudeUserSettingsPath(homeDir);
  const claudeRead = readClaudeSettingsSetting(cwd, homeDir) === true;
  for (const filePath of getUserSettingsFilePaths(cwd, homeDir)) {
    if (!fs.existsSync(filePath)) continue;
    const mark =
      filePath === claudePath && !claudeRead ? { notRead: true } : {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      files.push({ path: filePath, hooks: {}, unreadable: true, ...mark });
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      files.push({ path: filePath, hooks: {}, unreadable: true, ...mark });
      continue;
    }
    const settings = liftReadClaudeSettings(parsed as HookSettingsFile);
    if (!settings.hooks && !settings.disableAllHooks) continue;
    files.push({
      path: filePath,
      hooks: settings.hooks ?? {},
      disableAllHooks: settings.disableAllHooks,
      ...mark,
    });
  }
  return files;
}

/** Where the one-time notices of the hooks system are recorded. */
const NOTICES_FILE = "hook-notices.json";
const CLAUDE_NOTICE_KEY = "claudeSettingsOptIn";
let claudeNoticeShown = false;

/** The one-time notice for `~/.claude` hooks that no longer run, naming the setting. */
export function describeSkippedClaudeHooks(
  skipped: SkippedClaudeHooks,
  settingsFile: string,
): string {
  const n = skipped.handlers;
  return (
    `${skipped.path} defines ${n} hook${n === 1 ? "" : "s"} that ${n === 1 ? "does" : "do"} not run here: ` +
    `hooks from Claude Code's settings are opt-in. To run them, set ` +
    `"hooks": { "readClaudeSettings": true } in ${settingsFile}. ` +
    `\`continuous hooks\` lists them. This notice is shown once.\n`
  );
}

/**
 * Prints the notice once ever (recorded in the global folder), and only when
 * the setting is unset: someone who wrote `false` has already decided. When
 * the record cannot be written it is shown once per process. Returns whether
 * it was printed.
 */
export function noticeSkippedClaudeHooks(
  skipped: SkippedClaudeHooks | undefined,
  cwd: string,
  homeDir?: string,
  write: (text: string) => void = (text) => process.stderr.write(text),
): boolean {
  if (!skipped?.settingUnset || claudeNoticeShown) return false;
  const globalDir = getGlobalDir(cwd, homeDir);
  const record = globalDir ? path.join(globalDir, NOTICES_FILE) : undefined;
  let seen: Record<string, unknown> = {};
  if (record) {
    try {
      const parsed = JSON.parse(fs.readFileSync(record, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        seen = parsed as Record<string, unknown>;
      }
    } catch {
      // Absent or unreadable: not shown yet.
    }
  }
  if (seen[CLAUDE_NOTICE_KEY]) return false;
  claudeNoticeShown = true;
  const settingsFile = globalDir
    ? path.join(globalDir, "settings.json")
    : "~/.continuous/settings.json";
  write(describeSkippedClaudeHooks(skipped, settingsFile));
  if (record) {
    try {
      fs.mkdirSync(path.dirname(record), { recursive: true });
      fs.writeFileSync(
        record,
        `${JSON.stringify({ ...seen, [CLAUDE_NOTICE_KEY]: new Date().toISOString() }, null, 2)}\n`,
      );
    } catch {
      // Shown once for this process instead.
    }
  }
  return true;
}

/** For tests. */
export function resetClaudeNoticeForTests(): void {
  claudeNoticeShown = false;
}
