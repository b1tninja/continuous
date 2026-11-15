/**
 * Hook configuration loader.
 *
 * Loads hooks from settings files in the same locations as Claude Code:
 * - ~/.continue/settings.json  (user-global)
 * - .continue/settings.json    (project, committable)
 * - .continue/settings.local.json (project-local, gitignored)
 *
 * Also supports Claude Code's native locations for cross-compatibility:
 * - ~/.claude/settings.json
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
  if (result.status === "ok") return result.value;
  if (result.status === "broken") {
    logger.warn(`Hooks settings file ${filePath} is broken: ${result.error}`);
    broken?.push({ path: result.path, error: result.error });
  }
  return null;
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
 * Settings files that belong to the user. These always load.
 */
export function getUserSettingsFilePaths(
  cwd: string,
  homeDir?: string,
): string[] {
  const home = homeDir ?? os.homedir();
  const paths = [path.join(home, ".claude", "settings.json")];
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
 * Load hook configurations and merge them. The user's own files always load.
 * The project's files load only if the user trusted this project with these
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
  const withBroken = (r: LoadedHooksConfig): LoadedHooksConfig =>
    broken.length > 0 ? { ...r, broken } : r;

  const apply = (settings: {
    hooks?: HooksConfig;
    disableAllHooks?: boolean;
  }) => {
    if (settings.disableAllHooks) disabled = true;
    if (settings.hooks)
      mergedHooks = mergeHooksConfigs(mergedHooks, settings.hooks);
  };

  for (const filePath of getUserSettingsFilePaths(cwd, homeDir)) {
    const settings = loadSettingsFile(filePath, broken);
    if (!settings) continue;
    apply(settings);
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

    // Regex match
    let regex: RegExp;
    try {
      regex = new RegExp(group.matcher);
    } catch {
      // A matcher that does not compile must not switch the hook off: a guard
      // that silently never runs is the dangerous direction. Treat it as
      // matching, so the hook runs, and say so once.
      warnOnce(
        `matcher:${group.matcher}`,
        `Hook matcher "${group.matcher}" for event ${eventName} is not a valid regular expression, so the hook runs on every ${eventName} event. Fix the matcher.`,
      );
      return true;
    }
    return regex.test(matcherValue);
  });
}
