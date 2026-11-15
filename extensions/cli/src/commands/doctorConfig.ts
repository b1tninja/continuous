/**
 * `continuous doctor config` (alias `continuous config check [file]`): which
 * settings files exist, whether each one parses, and for the main controls
 * the value in force and where it came from (the default, a file of yours, a
 * file of the project, a flag or an environment variable).
 *
 * Read-only. Prints paths, key names, counts, levels and switches. It never
 * prints a file's text, a rule, a command, an argument or a variable's value,
 * and everything it does print goes through the audit trail's masker.
 */

import * as os from "node:os";
import * as path from "node:path";

import { maskDeep } from "core/tools/permissions/audit/mask.js";
import { getGlobalDirPath, GLOBAL_DIR_NAME } from "core/util/paths.js";

import {
  collectControls,
  type ControlContext,
  type ControlReport,
  type ControlSource,
  type DoctorFlags,
} from "./doctorControls.js";
import {
  checkConfigYaml,
  checkHookSettings,
  checkPermissionsYaml,
  isMapping,
  type FileCheck,
  type FileProblem,
  type FileState,
} from "./doctorFiles.js";
import { checkMcpServers, type McpServerCheck } from "./doctorMcp.js";

export type { ControlReport, ControlSource, DoctorFlags };

/** Bumped only when a field is removed or changes meaning. Fields may be added. */
export const DOCTOR_CONFIG_SCHEMA = "continuous.doctor.config/1";

const SOURCE_WORDS: Record<ControlSource, string> = {
  default: "default",
  "user-file": "user file",
  "project-file": "project file",
  flag: "flag",
  env: "env",
};

export interface FileReport {
  /** Stable id: `config`, `permissions`, `hooks.user.claude`, ... */
  id: string;
  kind: "config" | "permissions" | "hooks";
  scope: "user" | "project";
  path: string;
  state: FileState;
  errors: FileProblem[];
  warnings: FileProblem[];
}

export interface DoctorConfigReport {
  schema: typeof DOCTOR_CONFIG_SCHEMA;
  /** False when a file that exists is broken, or an MCP entry is. */
  ok: boolean;
  problems: number;
  globalDir: { path: string; source: ControlSource; sourceDetail?: string };
  cwd: string;
  files: FileReport[];
  mcpServers: McpServerCheck[];
  controls: ControlReport[];
}

export interface DoctorConfigInput {
  cwd?: string;
  /** For tests: the home folder the user's files are looked up under. */
  homeDir?: string;
  /** For tests: the global folder. Default: the product's own. */
  globalDir?: string;
  /** `config check <file>`: this file in place of the global config.yaml. */
  configFile?: string;
  flags?: DoctorFlags;
  env?: Readonly<Record<string, string | undefined>>;
}

function fileReport(
  id: string,
  kind: FileReport["kind"],
  scope: FileReport["scope"],
  file: string,
  check: FileCheck,
): FileReport {
  return {
    id,
    kind,
    scope,
    path: file,
    state: check.state,
    errors: check.errors,
    warnings: check.warnings,
  };
}

/** The hook settings files, user first, in the loader's order. */
function hookSettingsFiles(
  cwd: string,
  homeDir: string,
  globalDir: string,
): [string, FileReport["scope"], string][] {
  const project = (dir: string, name: string) => path.join(cwd, dir, name);
  return [
    [
      "hooks.user.claude",
      "user",
      path.join(homeDir, ".claude", "settings.json"),
    ],
    ["hooks.user", "user", path.join(globalDir, "settings.json")],
    ["hooks.project.claude", "project", project(".claude", "settings.json")],
    [
      "hooks.project.continue",
      "project",
      project(".continue", "settings.json"),
    ],
    ["hooks.project", "project", project(".continuous", "settings.json")],
    [
      "hooks.project.claude.local",
      "project",
      project(".claude", "settings.local.json"),
    ],
    [
      "hooks.project.continue.local",
      "project",
      project(".continue", "settings.local.json"),
    ],
    [
      "hooks.project.local",
      "project",
      project(".continuous", "settings.local.json"),
    ],
  ];
}

function globalDirVariable(input: DoctorConfigInput): string | undefined {
  if (input.globalDir || input.homeDir) return undefined;
  const env = input.env ?? process.env;
  if (env.CONTINUOUS_GLOBAL_DIR) return "CONTINUOUS_GLOBAL_DIR";
  return env.CONTINUE_GLOBAL_DIR ? "CONTINUE_GLOBAL_DIR" : undefined;
}

function resolveGlobalDir(input: DoctorConfigInput): string {
  if (input.globalDir) return input.globalDir;
  return input.homeDir
    ? path.join(input.homeDir, GLOBAL_DIR_NAME)
    : getGlobalDirPath();
}

function configControl(
  configFile: string,
  check: FileCheck,
  input: DoctorConfigInput,
): ControlReport {
  const explicit = input.configFile ?? input.flags?.config;
  let source: Pick<ControlReport, "source" | "sourceDetail"> = {
    source: "default",
  };
  if (explicit) {
    source = {
      source: "flag",
      sourceDetail: input.configFile ? "config check <file>" : "--config",
    };
  }
  return {
    id: "config.file",
    group: "Configuration",
    label: "Config file",
    value: check.state === "absent" ? "(none; no model is set up)" : configFile,
    ...source,
  };
}

/** Collects the report. Read-only; see doctorControls.ts for the controls. */
export function collectDoctorConfig(
  input: DoctorConfigInput = {},
): DoctorConfigReport {
  const cwd = input.cwd ?? process.cwd();
  const globalDir = resolveGlobalDir(input);
  const variable = globalDirVariable(input);
  const userConfigFile = path.join(globalDir, "config.yaml");
  const explicit = input.configFile ?? input.flags?.config;
  const configFile = explicit ? path.resolve(cwd, explicit) : userConfigFile;

  const config = checkConfigYaml(configFile);
  if (explicit && config.state === "absent") {
    config.state = "broken";
    config.errors.push({ message: "does not exist" });
  }
  const permissionsFile = path.join(globalDir, "permissions.yaml");
  const permissions = checkPermissionsYaml(permissionsFile);
  const files: FileReport[] = [
    fileReport("config", "config", "user", configFile, config),
    fileReport(
      "permissions",
      "permissions",
      "user",
      permissionsFile,
      permissions,
    ),
  ];

  const userHookSettings: ControlContext["userHookSettings"] = [];
  const home = input.homeDir ?? os.homedir();
  for (const [id, scope, file] of hookSettingsFiles(cwd, home, globalDir)) {
    const check = checkHookSettings(file);
    if (scope === "user" && isMapping(check.value)) {
      userHookSettings.push({ path: file, value: check.value });
    }
    // A project file that is not there is not worth a line each.
    if (scope === "user" || check.state !== "absent") {
      files.push(fileReport(id, "hooks", scope, file, check));
    }
  }

  const mcpServers = checkMcpServers(config.value);
  const controls = [
    configControl(configFile, config, input),
    ...collectControls({
      cwd,
      homeDir: input.homeDir,
      globalDir,
      globalDirVariable: variable,
      flags: input.flags ?? {},
      env: input.env ?? process.env,
      userConfigFile,
      permissionsFile,
      permissions: isMapping(permissions.value) ? permissions.value : {},
      userHookSettings,
    }),
  ];

  const problems =
    files.filter((f) => f.state === "broken").length +
    mcpServers.filter((s) => s.state === "broken").length;
  return maskDeep({
    schema: DOCTOR_CONFIG_SCHEMA,
    ok: problems === 0,
    problems,
    globalDir: {
      path: globalDir,
      ...(variable
        ? { source: "env" as const, sourceDetail: variable }
        : { source: "default" as const }),
    },
    cwd,
    files,
    mcpServers,
    controls,
  });
}

function problemLine(problem: FileProblem): string {
  const where =
    problem.line === undefined
      ? ""
      : `line ${problem.line}, column ${problem.column ?? 1}: `;
  return `${where}${problem.key ? `${problem.key}: ` : ""}${problem.message}`;
}

function sourceText(s: {
  source: ControlSource;
  sourceDetail?: string;
}): string {
  const word = SOURCE_WORDS[s.source];
  return s.sourceDetail ? `${word} (${s.sourceDetail})` : word;
}

const FILE_LABELS: Record<FileReport["kind"], string> = {
  config: "config.yaml",
  permissions: "permissions.yaml",
  hooks: "hook settings",
};

function fileLines(report: DoctorConfigReport): string[] {
  const lines = ["Files"];
  for (const file of report.files) {
    const label = `${FILE_LABELS[file.kind]} (${file.scope})`;
    lines.push(`  ${file.state.padEnd(7)} ${label.padEnd(26)} ${file.path}`);
    for (const e of file.errors) lines.push(`          ${problemLine(e)}`);
    for (const w of file.warnings) {
      lines.push(`          note: ${problemLine(w)}`);
    }
  }
  lines.push("", `MCP servers in config.yaml: ${report.mcpServers.length}`);
  for (const server of report.mcpServers) {
    const target = server.target ? `, ${server.target}` : "";
    const env = server.envNames.length
      ? ` env: ${server.envNames.join(", ")}`
      : "";
    lines.push(
      `  ${server.state.padEnd(7)} ${server.name} (${server.transport}${target})${env}`,
    );
    for (const e of server.errors) lines.push(`          ${problemLine(e)}`);
  }
  return lines;
}

/** The report as lines for a terminal. */
export function renderDoctorConfig(report: DoctorConfigReport): string[] {
  const lines: string[] = [
    `Global folder: ${report.globalDir.path} (${sourceText(report.globalDir)})`,
    `Working folder: ${report.cwd}`,
    "",
    ...fileLines(report),
  ];
  let group = "";
  for (const control of report.controls) {
    if (control.group !== group) {
      group = control.group;
      lines.push("", group);
    }
    const value = control.value === null ? "none" : String(control.value);
    lines.push(
      `  ${control.label.padEnd(44)} ${value.padEnd(24)} ${sourceText(control)}`,
    );
  }
  const plural = report.problems === 1 ? "" : "s";
  lines.push(
    "",
    report.ok
      ? "Result: every file that exists was read."
      : `Result: ${report.problems} problem${plural}. A file marked "broken" is not used, or only in part; fix the lines named above.`,
  );
  return lines;
}

export interface DoctorConfigCommandOptions extends DoctorConfigInput {
  json?: boolean;
  write?: (line: string) => void;
}

/** Exit code 0 when nothing is broken, 1 otherwise. */
export function doctorConfigCommand(
  options: DoctorConfigCommandOptions = {},
): number {
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  const report = collectDoctorConfig(options);
  if (options.json) write(JSON.stringify(report, null, 2));
  else renderDoctorConfig(report).forEach(write);
  return report.ok ? 0 : 1;
}
