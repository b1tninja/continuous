/**
 * Hook configuration loader.
 *
 * Loads hooks from settings files in the same locations as Claude Code:
 * - ~/.continue/settings.json  (user-global)
 * - .continue/settings.json    (project, committable)
 * - .continue/settings.local.json (project-local, gitignored)
 *
 * Also supports Claude Code's native locations for cross-compatibility:
 * - ~/.claude/settings.json (only with `hooks.readClaudeSettings: true` in the
 *   user's Continuous settings file; D-023)
 * - .claude/settings.json
 * - .claude/settings.local.json
 *
 * Hooks from all sources are merged (project > user, continue > claude).
 */

import * as os from "os";
import * as path from "path";

import { logger } from "../util/logger.js";
import {
  type BrokenConfigFile,
  readPolicyFile,
  warnOnce,
} from "../util/readPolicyFile.js";

import {
  fingerprintProjectHooks,
  getGlobalDir,
  isProjectHooksTrustedForRun,
  isProjectTrusted,
  listProjectHandlers,
  realPath,
} from "./hookTrust.js";
import type { ProjectHookFile } from "./hookTrust.js";
import { READ_CLAUDE_SETTINGS_KEY } from "./types.js";
import type {
  HookMatcherGroup,
  HookSettingsFile,
  HooksConfig,
} from "./types.js";

/**
 * Load and parse a settings JSON file, returning only the hooks portion.
 * Returns null if the file does not exist or is broken. A broken file (present
 * but unparseable) is added to `broken` so the caller can refuse or warn: it
 * must not read as "no hooks".
 */
function loadSettingsFile(
  filePath: string,
  broken?: BrokenConfigFile[],
): HookSettingsFile | null {
  const result = readPolicyFile<HookSettingsFile>(filePath, "json", (parsed) =>
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? undefined
      : "has the wrong structure (expected a JSON object)",
  );
  if (result.status === "ok") return liftReadClaudeSettings(result.value);
  if (result.status === "broken") {
    logger.warn(`Hooks settings file ${filePath} is broken: ${result.error}`);
    broken?.push({ path: result.path, error: result.error });
  }
  return null;
}

/**
 * Takes `hooks.readClaudeSettings` out of the event map, so nothing that walks
 * the events sees a boolean, and puts it on the file as `readClaudeSettings`.
 * Done for every file; only the user's Continuous file is asked for the value.
 */
export function liftReadClaudeSettings(
  settings: HookSettingsFile,
): HookSettingsFile {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (
    !hooks ||
    typeof hooks !== "object" ||
    !Object.prototype.hasOwnProperty.call(hooks, READ_CLAUDE_SETTINGS_KEY)
  ) {
    return settings;
  }
  const { [READ_CLAUDE_SETTINGS_KEY]: flag, ...events } = hooks;
  return {
    ...settings,
    hooks: events as HooksConfig,
    readClaudeSettings: flag,
  };
}

/** `~/.claude/settings.json`, Claude Code's user settings file. */
export function getClaudeUserSettingsPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".claude", "settings.json");
}

/** How many handlers a hooks map defines. */
export function countHookHandlers(hooks: HooksConfig | undefined): number {
  let n = 0;
  for (const groups of Object.values(hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      n += Array.isArray(group?.hooks) ? group.hooks.length : 0;
    }
  }
  return n;
}

/**
 * The value of `hooks.readClaudeSettings` in the user's Continuous settings
 * file, or undefined when it is not set (or the file is absent or broken).
 * Only that file is asked: a project, or `~/.claude` itself, cannot opt in.
 */
export function readClaudeSettingsSetting(
  cwd: string,
  homeDir?: string,
): unknown {
  const globalDir = getGlobalDir(cwd, homeDir);
  if (!globalDir) return undefined;
  return loadSettingsFile(path.join(globalDir, "settings.json"))
    ?.readClaudeSettings;
}

/**
 * Merge two hook configs. Later config entries are appended (not replaced).
 * This matches Claude Code's behavior: hooks from multiple sources all run.
 */
function mergeHooksConfigs(
  base: HooksConfig,
  overlay: HooksConfig,
): HooksConfig {
  const merged: HooksConfig = { ...base };

  for (const [eventName, matcherGroups] of Object.entries(overlay)) {
    const key = eventName as keyof HooksConfig;
    if (merged[key]) {
      merged[key] = [...merged[key]!, ...matcherGroups!];
    } else {
      merged[key] = matcherGroups;
    }
  }

  return merged;
}

/**
 * Settings files that belong to the user. The Continuous one always loads;
 * `~/.claude/settings.json` loads only with `hooks.readClaudeSettings: true`.
 */
export function getUserSettingsFilePaths(
  cwd: string,
  homeDir?: string,
): string[] {
  const paths = [getClaudeUserSettingsPath(homeDir)];
  // Undefined when CONTINUE_GLOBAL_DIR points inside the project; see hookTrust.
  const globalDir = getGlobalDir(cwd, homeDir);
  if (globalDir) paths.push(path.join(globalDir, "settings.json"));
  return paths;
}

/**
 * Settings files that come with the project, lowest precedence first. They
 * load only once the user has trusted them.
 */
function getProjectSettingsFilePaths(cwd: string): string[] {
  return [
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".continue", "settings.json"),
    path.join(cwd, ".continuous", "settings.json"),
    // Project-local (highest precedence)
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".continue", "settings.local.json"),
    path.join(cwd, ".continuous", "settings.local.json"),
  ];
}

/**
 * The project's settings files that define hooks (or switch them off). A file
 * that is really one of the user's files, as when `cn` runs from the home
 * directory, is not a project file.
 */
export function getProjectHookFiles(
  cwd: string,
  homeDir?: string,
  broken?: BrokenConfigFile[],
): ProjectHookFile[] {
  const userFiles = new Set(
    getUserSettingsFilePaths(cwd, homeDir).map(realPath),
  );
  const files: ProjectHookFile[] = [];
  for (const filePath of getProjectSettingsFilePaths(cwd)) {
    if (userFiles.has(realPath(filePath))) continue;
    const settings = loadSettingsFile(filePath, broken);
    if (!settings?.hooks && !settings?.disableAllHooks) continue;
    files.push({
      path: filePath,
      hooks: settings.hooks ?? {},
      disableAllHooks: settings.disableAllHooks,
    });
  }
  return files;
}

/** Project hooks that were found but are not running because they are not trusted. */
export interface UntrustedProjectHooks {
  files: ProjectHookFile[];
  fingerprint: string;
  /** `[event] command: ...` lines, for showing what would run */
  handlers: string[];
}

export interface LoadedHooksConfig {
  hooks: HooksConfig;
  disabled: boolean;
  /**
   * The user's own settings say `managedHooksOnly`: the project's hook files
   * were not read for this run, trusted or not, and `--trust-project-hooks`
   * does not change that.
   */
  managedOnly?: boolean;
  untrustedProject?: UntrustedProjectHooks;
  /**
   * Settings files that exist but do not parse. None of what they say was
   * loaded. Project files are listed only when they would have been read.
   */
  broken?: BrokenConfigFile[];
  /**
   * `~/.claude/settings.json` defines hooks that were not loaded because
   * `hooks.readClaudeSettings` is not `true`. `settingUnset` is true when the
   * setting is absent, as opposed to set to `false`: only then is the
   * one-time notice due.
   */
  skippedClaudeHooks?: SkippedClaudeHooks;
}

export interface SkippedClaudeHooks {
  path: string;
  handlers: number;
  settingUnset: boolean;
}

/**
 * Mark every handler as coming from the project. The mark is set here, over
 * whatever the file says, so a repository cannot claim to be the user.
 */
function markAsProject(hooks: HooksConfig): HooksConfig {
  const marked: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    marked[event as keyof HooksConfig] = (groups ?? []).map((group) => ({
      ...group,
      hooks: group.hooks.map((h) => ({ ...h, origin: "project" as const })),
    }));
  }
  return marked;
}

/**
 * Load hook configurations and merge them. The user's Continuous file always
 * loads; `~/.claude/settings.json` only with `hooks.readClaudeSettings: true`
 * there (its `managedHooksOnly: true` counts either way, since it only narrows
 * what runs). The project's files load only if the user trusted this project with these
 * exact hooks, or passed --trust-project-hooks for this run; otherwise they
 * are reported in `untrustedProject` and nothing from them runs, including a
 * `disableAllHooks` that would silence the user's own hooks. With
 * `managedHooksOnly` in the user's own settings the project's files are not
 * looked at at all.
 */
export function loadHooksConfig(
  cwd: string = process.cwd(),
  homeDir?: string,
): LoadedHooksConfig {
  let mergedHooks: HooksConfig = {};
  let disabled = false;
  let managedOnly = false;
  const broken: BrokenConfigFile[] = [];
  let skippedClaudeHooks: SkippedClaudeHooks | undefined;
  const withBroken = (r: LoadedHooksConfig): LoadedHooksConfig => ({
    ...r,
    ...(broken.length > 0 ? { broken } : {}),
    ...(skippedClaudeHooks ? { skippedClaudeHooks } : {}),
  });

  const apply = (settings: {
    hooks?: HooksConfig;
    disableAllHooks?: boolean;
  }) => {
    if (settings.disableAllHooks) disabled = true;
    if (settings.hooks)
      mergedHooks = mergeHooksConfigs(mergedHooks, settings.hooks);
  };

  const claudePath = getClaudeUserSettingsPath(homeDir);
  const optIn = readClaudeSettingsSetting(cwd, homeDir);
  for (const filePath of getUserSettingsFilePaths(cwd, homeDir)) {
    const isClaude = filePath === claudePath;
    // A `~/.claude` file that is not being read cannot be broken for us: it
    // must not stop a headless start.
    const readHooks = !isClaude || optIn === true;
    const settings = loadSettingsFile(filePath, readHooks ? broken : undefined);
    if (!settings) continue;
    if (readHooks) {
      apply(settings);
    } else {
      const handlers = countHookHandlers(settings.hooks);
      if (handlers > 0) {
        skippedClaudeHooks = {
          path: filePath,
          handlers,
          settingUnset: optIn === undefined,
        };
      }
    }
    // Only the user's own files can switch this on, and only with `true`.
    if (settings.managedHooksOnly === true) managedOnly = true;
  }

  if (managedOnly) {
    // Nothing from the project is read, so not even a `disableAllHooks` in it
    // can silence the user's hooks, and there is nothing to ask about.
    return withBroken({ hooks: mergedHooks, disabled, managedOnly });
  }

  const projectFiles = getProjectHookFiles(cwd, homeDir, broken);
  if (projectFiles.length === 0) {
    return withBroken({ hooks: mergedHooks, disabled });
  }

  const fingerprint = fingerprintProjectHooks(cwd, projectFiles);
  if (
    isProjectHooksTrustedForRun() ||
    isProjectTrusted(cwd, fingerprint, homeDir)
  ) {
    projectFiles.forEach((file) =>
      apply({ ...file, hooks: markAsProject(file.hooks) }),
    );
    return withBroken({ hooks: mergedHooks, disabled });
  }

  return withBroken({
    hooks: mergedHooks,
    disabled,
    untrustedProject: {
      files: projectFiles,
      fingerprint,
      handlers: listProjectHandlers(projectFiles, cwd),
    },
  });
}

/** Hook settings files that exist but do not parse, for the headless start check. */
export function findBrokenHookFiles(
  cwd: string,
  homeDir?: string,
): BrokenConfigFile[] {
  return loadHooksConfig(cwd, homeDir).broken ?? [];
}

/**
 * Get matching hook handlers for a given event and matcher value.
 *
 * @param config - The merged hooks config
 * @param eventName - The hook event name
 * @param matcherValue - The value to match against (e.g., tool name). Undefined for events without matchers.
 * @returns Array of matching hook handler groups
 */
export function getMatchingHookGroups(
  config: HooksConfig,
  eventName: string,
  matcherValue?: string,
): HookMatcherGroup[] {
  const groups = config[eventName as keyof HooksConfig];
  if (!groups) return [];

  return groups.filter((group) => {
    // No matcher, empty matcher, or "*" = match all
    if (!group.matcher || group.matcher === "" || group.matcher === "*") {
      return true;
    }

    // If no matcher value provided (e.g., events without matcher support), match all
    if (matcherValue === undefined) {
      return true;
    }

    return matcherAccepts(group.matcher, matcherValue, eventName);
  });
}

/**
 * A matcher made only of these characters is a name or a list of names, not a
 * regular expression. This is Claude Code's rule (code.claude.com/docs/en/hooks,
 * "Matcher patterns"), so a shared hooks file means the same thing in both.
 */
const EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]+$/;

/**
 * Whether one matcher accepts a value, the way Claude Code decides it: a
 * matcher of letters, digits, `_`, `-`, spaces, `,` and `|` is compared as an
 * exact name, or a list of names split on `|` or `,` (`Edit|Write`,
 * `Edit, Write`), so `Edit` no longer matches `NotebookEdit`. Any other
 * character makes it a JavaScript regular expression tested unanchored, as
 * before (`mcp__.*`, `Notebook.*`, `^Edit$`).
 */
export function matcherAccepts(
  matcher: string,
  value: string,
  eventName: string,
): boolean {
  if (matcher === "" || matcher === "*") return true;
  if (EXACT_MATCHER.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .some((name) => name !== "" && name === value);
  }
  let regex: RegExp;
  try {
    regex = new RegExp(matcher);
  } catch {
    // A matcher that does not compile must not switch the hook off: a guard
    // that silently never runs is the dangerous direction. Treat it as
    // matching, so the hook runs, and say so once.
    warnOnce(
      `matcher:${matcher}`,
      `Hook matcher "${matcher}" for event ${eventName} is not a valid regular expression, so the hook runs on every ${eventName} event. Fix the matcher.`,
    );
    return true;
  }
  return regex.test(value);
}
