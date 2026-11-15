/**
 * `--safe`: start without the things that can stop a start or widen what the
 * agent may do. It is the way out when a hook, a settings file or a project
 * file blocks the CLI: those files are not read at all.
 *
 * Skipped: project configuration (providers.yaml, models.yaml), hooks (yours
 * and the project's), MCP servers (config.yaml, --mcp), agent files
 * (AGENTS.md and the like, --agent), rules from config.yaml and from rules
 * folders, skills, and `serve`'s environment install. Kept: your config.yaml
 * (or --config) for its models, your permission rules and levels, capped so
 * that no area is looser than its default, and the text you pass with
 * --rule or --prompt for this run.
 */

import {
  DEFAULT_POLICY_LEVELS,
  POLICY_AREAS,
  POLICY_LEVELS,
  type PolicyLevels,
} from "core/tools/permissions/policy.js";

import { safeStderr } from "./init.js";

let safeMode = false;

export function setSafeMode(value: boolean): void {
  safeMode = value;
}

export function isSafeMode(): boolean {
  return safeMode;
}

/** Each area at its own level or its default, whichever asks more. */
export function capAtDefaults(levels: PolicyLevels): PolicyLevels {
  const capped = { ...levels };
  for (const area of POLICY_AREAS) {
    const given = POLICY_LEVELS.indexOf(levels[area]);
    const limit = POLICY_LEVELS.indexOf(DEFAULT_POLICY_LEVELS[area]);
    if (given > limit) capped[area] = DEFAULT_POLICY_LEVELS[area];
  }
  return capped;
}

/** The options of a start that safe mode changes. */
export interface SafeModeOptions {
  safe?: boolean;
  auto?: boolean;
  autoReview?: boolean;
  allow?: string[];
  agent?: string;
  mcp?: string[];
  trustProjectHooks?: boolean;
  trustProjectConfig?: boolean;
  /** Read by the headless broken-file check (#739): continue, file ignored. */
  ignoreBrokenConfig?: boolean;
}

/** The flags that would widen what the agent may do, which safe mode drops. */
function dropWideningFlags(options: SafeModeOptions): string[] {
  const dropped: string[] = [];
  if (options.auto) dropped.push("--auto");
  if (options.autoReview) dropped.push("--auto-review");
  if (options.allow?.length) dropped.push("--allow");
  if (options.agent) dropped.push("--agent");
  if (options.mcp?.length) dropped.push("--mcp");
  if (options.trustProjectHooks) dropped.push("--trust-project-hooks");
  if (options.trustProjectConfig) dropped.push("--trust-project-config");
  options.auto = false;
  options.autoReview = false;
  options.allow = [];
  options.agent = undefined;
  options.mcp = [];
  options.trustProjectHooks = false;
  options.trustProjectConfig = false;
  return dropped;
}

/** The one stderr line a safe start prints. */
export function safeModeNotice(dropped: string[]): string {
  const ignored = dropped.length ? ` Ignored: ${dropped.join(", ")}.` : "";
  return `Safe mode: started without project configuration, hooks (yours and the project's), MCP servers, agent files (AGENTS.md, CLAUDE.md), rules, skills and the environment install; permission levels are capped at the defaults.${ignored} To find what is broken: continuous doctor config`;
}

/**
 * Applies `--safe` to a start's options, before any service reads a file.
 * Does nothing without `--safe`. Prints one line on stderr, so piped and
 * JSON output on stdout stays what it was.
 */
export function applySafeMode(
  options: SafeModeOptions,
  // safeStderr: a headless run's stderr is captured until it is configured
  write: (line: string) => void = (line) => safeStderr(`${line}\n`),
): void {
  if (!options.safe) return;
  setSafeMode(true);
  const dropped = dropWideningFlags(options);
  // A broken hook settings file or permissions.yaml must not refuse a safe
  // start: the hooks are not read, and a permissions.yaml that does not
  // parse leaves the defaults, which are what safe mode caps at anyway.
  options.ignoreBrokenConfig = true;
  write(safeModeNotice(dropped));
}

export const SAFE_FLAG_HELP =
  "Start without project configuration, hooks (yours and the project's), MCP servers, agent files, rules and skills, with no permission level looser than its default. For when a broken hook or settings file stops a start; see `continuous doctor config`";
