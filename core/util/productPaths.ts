/**
 * Every place the product loads configuration, code, rules or hooks from. This
 * is the one registry the loaders name their paths from and the locked floor
 * (core/tools/permissions/lockedPaths.ts) reads, so a file the product loads
 * is a file the agent cannot change: a model that can write a hook, a rule or
 * a setting changes what the next session runs.
 *
 * To add a loader: name its folder or file here, in PRODUCT_LOADED_PATHS (the
 * product reads it as the user's own) or in PRODUCT_STATE_PATHS (the product
 * only writes it for itself). productPaths.vitest.ts scans the source for
 * paths read from the global folder and fails on a name that is in neither.
 *
 * No fs or node imports: the permission code and the GUI both import this.
 */

/** The global folder's name in the home directory, and its name before 2.4.2. */
export const GLOBAL_DIR_NAME = ".continuous";
export const LEGACY_GLOBAL_DIR_NAME = ".continue";

/** Folders of that name hold the product's config: in the home dir, in a project, at any depth. */
export const CONFIG_DIR_NAMES: readonly string[] = [
  GLOBAL_DIR_NAME,
  LEGACY_GLOBAL_DIR_NAME,
];

/** A project folder under the config folder that the product itself writes, not read as config. */
export const PROJECT_STATE_DIRS: readonly string[] = ["plans"];

/** Files read from the global folder or from a project's config folder, and what reads them. */
export const PRODUCT_LOADED_FILES = {
  "config.yaml": "the config",
  "config.json": "the config (older format)",
  "config.ts": "user code, run at start",
  "config.js": "user code, run at start",
  "permissions.yaml": "the permission settings",
  "trusted-hooks.json": "which hooks the user trusted",
  "trusted-project.json": "which project configuration the user trusted",
  "mcp-tool-pins.json": "the pinned MCP tool definitions",
  "settings.json": "hook settings",
  "settings.local.json": "hook settings (project-local)",
  ".env": "keys and the API base",
  "providers.yaml": "model providers",
  "models.yaml": "models",
  "worktrees.json": "worktree setup commands",
  "environment.json": "install command",
  "sharedConfig.json": "shared settings",
  "auth.json": "the signed-in account",
  "package.json": "dependencies of config.ts",
  "tsconfig.json": "how config.ts is built",
  ".continuousignore": "ignore patterns",
  ".continueignore": "ignore patterns (older name)",
  ".continuousrc.json": "the rc file",
  ".continuerc.json": "the rc file (older name)",
} as const;

/** Folders read from the global folder or from a project's config folder. */
export const PRODUCT_LOADED_DIRS = {
  rules: "rule files",
  context: "context provider blocks",
  docs: "doc blocks",
  agents: "agent definitions and subagents",
  prompts: "prompt files",
  checks: "review checks",
  skills: "skills",
  mcpServers: "MCP server definitions",
  blocks: "config blocks",
  assistants: "assistant configs",
  configs: "named configs",
  ".configs": "downloaded remote configs",
  audit: "the audit log the policy writes",
  reviewer: "the reviewer's guidance",
  models: "model files",
  providers: "provider files",
  catalog: "model catalog",
  data: "data destinations",
  out: "the compiled config.ts",
  types: "types for config.ts",
  hooks: "hook scripts",
} as const;

/**
 * What the product writes for itself in the global folder and never reads as
 * config. These are locked too (the folder is locked as a whole), but listed
 * so that a new name has to be put in one list or the other on purpose.
 */
export const PRODUCT_STATE_PATHS = [
  "sessions",
  "index",
  "logs",
  "dev_data",
  ".utils",
  ".diffs",
  ".migrations",
  ".local",
  ".staging",
  "worktrees",
  "bedrock-catalog",
  "model-catalog",
  // the full output of long commands (commandOutputStore.ts); written, never read as config
  "command-output",
  // the terminal agent's compiled-code cache, `cache/compile`
  "cache",
  "input_history.json",
  "retirement-notices.json",
  ".onboarding_complete",
  "node_modules",
  "plans",
  "reset-backups",
] as const;

export type LoadedDirName = keyof typeof PRODUCT_LOADED_DIRS;
export type LoadedFileName = keyof typeof PRODUCT_LOADED_FILES;
export type StatePathName = (typeof PRODUCT_STATE_PATHS)[number];

/**
 * A loader names its folder or file through these, so a name that is in no
 * list is a type error, not a path that escapes the lock.
 */
export const loadedDir = <K extends LoadedDirName>(name: K): K => name;
export const loadedFile = <K extends LoadedFileName>(name: K): K => name;

/** `.claude` is another tool's folder that this product also reads. */
export const FOREIGN_CONFIG_DIR = ".claude";
export const FOREIGN_LOADED_FILES: readonly string[] = [
  "settings.json",
  "settings.local.json",
];
export const FOREIGN_LOADED_DIRS: readonly string[] = ["agents", "skills"];

/** Files in a project root that are config wherever they are. */
export const RC_FILE = /^\.(continue|continuous)rc(\..+)?$/;
export const PROJECT_ROOT_FILES: readonly string[] = [".continuerules"];

/** One export for the lock and the covering test. */
export const PRODUCT_LOADED_PATHS = {
  configDirs: CONFIG_DIR_NAMES,
  projectStateDirs: PROJECT_STATE_DIRS,
  files: PRODUCT_LOADED_FILES,
  dirs: PRODUCT_LOADED_DIRS,
  state: PRODUCT_STATE_PATHS,
  foreign: {
    dir: FOREIGN_CONFIG_DIR,
    files: FOREIGN_LOADED_FILES,
    dirs: FOREIGN_LOADED_DIRS,
  },
  rcFile: RC_FILE,
  projectRootFiles: PROJECT_ROOT_FILES,
} as const;

/** Every name the product knows in a config folder, lower-cased. */
export function knownConfigNames(): string[] {
  return [
    ...Object.keys(PRODUCT_LOADED_FILES),
    ...Object.keys(PRODUCT_LOADED_DIRS),
    ...CONFIG_DIR_NAMES,
    FOREIGN_CONFIG_DIR,
    ...PROJECT_ROOT_FILES,
  ].map((n) => n.toLowerCase());
}
