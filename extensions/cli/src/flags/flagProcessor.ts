/**
 * Shared flag processing utilities to eliminate duplication between TUI and headless modes
 */

import { getWebConfig } from "core/util/webConfig.js";

import { setAutoReviewEnabled } from "../permissions/coreRules.js";
import { getDefaultToolPolicies } from "../permissions/defaultPolicies.js";
import {
  checkPolicyFile,
  HEADLESS_FETCH_FOLLOWS_WEB_LEVEL,
  HEADLESS_LEGACY_ENV,
  headlessLegacyAllow,
  headlessPolicyNotice,
  isPolicyFileSpec,
  resolvePolicyFile,
} from "../permissions/headlessPolicy.js";
import {
  auditEnvLoosening,
  rememberIdgafFlag,
} from "../permissions/idgafNotices.js";
import { checkToolPermission } from "../permissions/permissionChecker.js";
import {
  auditFileEditsAtLoad,
  auditLevelChange,
} from "../permissions/policyAudit.js";
import {
  effectiveLevels,
  getPolicyLevels,
  loadPolicyFile,
  parsePolicySpec,
  setCommandPermissionFlags,
  setPolicyLevels,
} from "../permissions/policyLevels.js";
import { PermissionMode } from "../permissions/types.js";
import { logger } from "../util/logger.js";

export interface PermissionOverrides {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
  mode?: PermissionMode;
}

export interface ProcessedFlags {
  mode?: PermissionMode;
  permissionOverrides: PermissionOverrides;
}

/**
 * Converts legacy readonly/auto flags to the new mode system
 * This logic was previously duplicated in chat.ts lines 168-173 and 259-264
 */
export function convertLegacyModeFlags(
  readonly?: boolean,
  auto?: boolean,
): PermissionMode | undefined {
  if (readonly && auto) {
    throw new Error("Cannot use both --readonly and --auto flags together");
  }

  if (readonly) {
    return "plan";
  }

  if (auto) {
    return "auto";
  }

  return undefined;
}

/**
 * Structures permission overrides for service initialization
 * This logic was previously duplicated between TUI and headless paths
 */
export function buildPermissionOverrides(
  allow?: string[],
  ask?: string[],
  exclude?: string[],
  mode?: PermissionMode,
): PermissionOverrides {
  return {
    allow,
    ask,
    exclude,
    mode,
  };
}

/**
 * Processes all command line flags into a consistent structure
 * Eliminates duplication and provides single source of truth for flag processing
 */
export function processCommandFlags(options: {
  readonly?: boolean;
  auto?: boolean;
  allow?: string[];
  ask?: string[];
  exclude?: string[];
  autoReview?: boolean;
  policy?: string;
}): ProcessedFlags {
  // Experimental reviewer model for calls the rules leave open (--auto-review).
  setAutoReviewEnabled(options.autoReview === true);

  // The shared settings file first, so a flag wins over it
  for (const notice of loadPolicyFile()) logger.warn(notice);
  // Edits made to the file since the last run are audited as such
  auditFileEditsAtLoad();

  // The level of each policy area (--policy): a preset, levels, or a file
  // in the permissions.yaml format that stands in for the person's own
  if (options.policy !== undefined && isPolicyFileSpec(options.policy)) {
    const file = resolvePolicyFile(options.policy);
    const missing = checkPolicyFile(file);
    if (missing) throw new Error(`--policy: ${missing}`);
    const before = getPolicyLevels();
    for (const notice of loadPolicyFile(file)) logger.warn(notice);
    auditLevelChange(before, getPolicyLevels(), "flag", "flag");
  } else if (options.policy !== undefined) {
    const parsed = parsePolicySpec(options.policy);
    if (!parsed.ok) throw new Error(`--policy: ${parsed.error}`);
    // stderr, so a JSON run's stdout stays what it was
    if (parsed.deprecated) process.stderr.write(`${parsed.deprecated}\n`);
    const before = getPolicyLevels();
    setPolicyLevels(parsed.levels);
    // Typed on the command line, so already explicit: audited, not asked
    auditLevelChange(before, parsed.levels, "flag", "flag");
  }

  // Convert legacy flags to mode
  const mode = convertLegacyModeFlags(options.readonly, options.auto);
  // `--auto` raises the tool areas to IDGAF for this run
  if (mode === "auto") {
    auditLevelChange(
      getPolicyLevels(),
      effectiveLevels("auto"),
      "flag",
      "flag",
    );
  }

  // The flag that turned IDGAF on, for the session's one IDGAF line
  rememberIdgafFlag(idgafFlagSource(options, mode));

  // Remembered for loop workers, which are a separate process.
  setCommandPermissionFlags({
    allow: options.allow,
    ask: options.ask,
    exclude: options.exclude,
  });

  // Build permission overrides
  const permissionOverrides = buildPermissionOverrides(
    options.allow,
    options.ask,
    options.exclude,
    mode,
  );

  return {
    mode,
    permissionOverrides,
  };
}

/** `--auto` or `--policy <spec>` when the levels they set have an area at IDGAF. */
function idgafFlagSource(
  options: { auto?: boolean; policy?: string },
  mode: PermissionMode | undefined,
): string | undefined {
  const levels = effectiveLevels(mode ?? "normal");
  if (!Object.values(levels).includes("idgaf")) return undefined;
  if (options.auto) return "--auto";
  if (options.policy === undefined) return undefined;
  return `--policy ${options.policy}`;
}

/** The CLI's headless default lists allow `Fetch`; never throws. */
function defaultListsAllowFetch(): boolean {
  try {
    return (
      checkToolPermission(
        { name: "Fetch", arguments: {} },
        { policies: getDefaultToolPolicies(true) },
      ).permission === "allow"
    );
  } catch {
    return false;
  }
}

/**
 * The one stderr line a headless run (`-p`, `serve`) starts with: the levels
 * it runs at and where they came from (CO2). stderr, so a JSON run's stdout
 * is unchanged.
 */
export function announceHeadlessPolicy(
  options: { auto?: boolean; readonly?: boolean; policy?: string },
  write: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const mode = convertLegacyModeFlags(options.readonly, options.auto);
  let source: string | undefined;
  if (options.auto) source = "--auto";
  else if (options.policy !== undefined) source = `--policy ${options.policy}`;
  const legacy = headlessLegacyAllow() && !options.auto;
  const notice = headlessPolicyNotice({
    levels: effectiveLevels(mode ?? "normal"),
    ...(source ? { source } : {}),
    legacy,
    webEnabled: getWebConfig().enabled,
    fetchTransition:
      !HEADLESS_FETCH_FOLLOWS_WEB_LEVEL && defaultListsAllowFetch(),
  });
  write(`${notice}\n`);
  // B21: a loosening from the environment is audited apart from IDGAF
  if (legacy) {
    auditEnvLoosening(
      HEADLESS_LEGACY_ENV,
      process.env[HEADLESS_LEGACY_ENV] ?? "",
    );
  }
}
