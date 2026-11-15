/**
 * Shared flag processing utilities to eliminate duplication between TUI and headless modes
 */

import { setAutoReviewEnabled } from "../permissions/coreRules.js";
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

  // The level of each policy area (--policy)
  if (options.policy !== undefined) {
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
