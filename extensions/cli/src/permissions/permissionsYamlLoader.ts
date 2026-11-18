import fs from "fs";
import path from "path";

import { POLICY_FILE_KEYS } from "core/tools/permissions/settingsFile.js";

import { env } from "../env.js";
import { logger } from "../util/logger.js";
import {
  ignoreBrokenConfigForRun,
  noticeBrokenConfig,
  type PolicyFileResult,
  readPolicyFile,
} from "../util/readPolicyFile.js";

import { PermissionPolicy, ToolPermissionPolicy } from "./types.js";

export const PERMISSIONS_YAML_PATH = path.resolve(
  path.join(env.continueHome, "permissions.yaml"),
);

export interface PermissionsYamlConfig {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}

/**
 * Why a parsed permissions.yaml cannot be used, or undefined when it can.
 * An empty file, or one holding only comments, is an empty policy.
 */
export function permissionsYamlProblem(parsed: unknown): string | undefined {
  if (parsed === null || parsed === undefined) return undefined;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return "has the wrong structure (expected a mapping with allow, ask and exclude lists)";
  }
  const validKeys = ["allow", "ask", "exclude"];
  // The policy levels share this file (see core settingsFile): its keys
  // are read there, not here
  const policyKeys: readonly string[] = POLICY_FILE_KEYS;
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (policyKeys.includes(key)) continue;
    if (!validKeys.includes(key)) {
      return `has the wrong structure (unrecognised top-level key "${key.slice(0, 40)}")`;
    }
    if (record[key] && !Array.isArray(record[key])) {
      return `has the wrong structure ("${key}" must be a list)`;
    }
  }
  return undefined;
}

/**
 * Reads ~/.continue/permissions.yaml, telling a missing file from a broken
 * one. A broken file must not be read as "no policy": the caller decides what
 * to do (headless runs refuse to start, see configFileGate).
 */
export function readPermissionsYaml(
  file: string = PERMISSIONS_YAML_PATH,
): PolicyFileResult<PermissionsYamlConfig> {
  const result = readPolicyFile<PermissionsYamlConfig | null>(
    file,
    "yaml",
    permissionsYamlProblem,
  );
  if (result.status === "ok") {
    return { status: "ok", value: result.value ?? {} };
  }
  return result as PolicyFileResult<PermissionsYamlConfig>;
}

/**
 * Loads permissions from ~/.continue/permissions.yaml
 * Returns null if file doesn't exist or is broken. A broken file is reported
 * once on stderr; use readPermissionsYaml to tell the two apart.
 */
export function loadPermissionsYaml(
  file: string = PERMISSIONS_YAML_PATH,
): PermissionsYamlConfig | null {
  const result = readPermissionsYaml(file);
  if (result.status === "absent") {
    logger.debug("Permissions YAML file does not exist", { path: file });
    return null;
  }
  if (result.status === "broken") {
    noticeBrokenConfig(result, ignoreBrokenConfigForRun());
    return null;
  }
  logger.debug("Loaded permissions from YAML", {
    allow: result.value.allow?.length || 0,
    ask: result.value.ask?.length || 0,
    exclude: result.value.exclude?.length || 0,
  });
  return result.value;
}

/**
 * Parses a pattern string into a ToolPermissionPolicy
 * Supports formats like:
 * - "Write" -> { tool: "Write", permission }
 * - "Write(pattern)" -> { tool: "Write", permission, argumentMatches: { filepath: "pattern" } }
 * - "Bash(npm install)" -> { tool: "Bash", permission, argumentMatches: { command: "npm install" } }
 */
export function parseToolPattern(
  pattern: string,
  permission: PermissionPolicy,
): ToolPermissionPolicy {
  const match = pattern.match(/^([^(]+)(?:\(([^)]*)\))?$/);
  if (!match) {
    throw new Error(`Invalid tool pattern: ${pattern}`);
  }

  const [, toolName, args] = match;
  const normalizedName = toolName.trim();

  const policy: ToolPermissionPolicy = {
    tool: normalizedName,
    permission,
  };

  if (args) {
    const trimmedArgs = args.trim();
    if (trimmedArgs) {
      // The key is the tool's real parameter name (see each tool's schema).
      // Edit and MultiEdit take file_path; Write and Read take filepath.
      const toolArgMappings: Record<string, string> = {
        Write: "filepath",
        Edit: "file_path",
        MultiEdit: "file_path",
        Read: "filepath",
        List: "dirpath",
        Search: "pattern",
        Bash: "command",
        Fetch: "url",
        Diff: "path",
      };

      const argKey = toolArgMappings[normalizedName] || "pattern";
      policy.argumentMatches = {
        [argKey]: trimmedArgs,
      };
    }
  }

  return policy;
}

/**
 * Converts permissions YAML config to ToolPermissionPolicy array
 */
export function yamlConfigToPolicies(
  config: PermissionsYamlConfig,
): ToolPermissionPolicy[] {
  const policies: ToolPermissionPolicy[] = [];

  // Order matters: more restrictive policies first
  if (config.exclude) {
    for (const pattern of config.exclude) {
      policies.push(parseToolPattern(pattern, "exclude"));
    }
  }

  if (config.ask) {
    for (const pattern of config.ask) {
      policies.push(parseToolPattern(pattern, "ask"));
    }
  }

  if (config.allow) {
    for (const pattern of config.allow) {
      policies.push(parseToolPattern(pattern, "allow"));
    }
  }

  return policies;
}

/**
 * Creates the permissions.yaml file with default content if it doesn't exist
 */
export async function ensurePermissionsYamlExists(): Promise<void> {
  const dir = path.dirname(PERMISSIONS_YAML_PATH);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  // Create file if it doesn't exist
  if (!fs.existsSync(PERMISSIONS_YAML_PATH)) {
    const defaultContent = `# cn tool permissions

# Tools that are automatically allowed without prompting
allow: []

# Tools that require user confirmation before execution
ask: []

# Tools that are completely excluded (model won't know they exist)
exclude: []
`;

    await fs.promises.writeFile(PERMISSIONS_YAML_PATH, defaultContent, "utf-8");
    logger.info("Created default permissions.yaml", {
      path: PERMISSIONS_YAML_PATH,
    });
  }
}
