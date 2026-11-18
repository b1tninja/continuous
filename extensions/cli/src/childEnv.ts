import * as fs from "node:fs";

import { terminalEnvironment } from "core/util/terminalEnvironment.js";
import dotenv from "dotenv";

import { startupEnv } from "./startupEnv.js";

/**
 * Names that select code to run, or that change where programs and libraries
 * are loaded. A .env file must not be able to set these. Child processes
 * inherit the values from process start (see startupEnv), not a later value.
 *
 * On Windows the match is case-insensitive, because the process environment is.
 */
const STARTUP_ONLY_ENV_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "GEM_HOME",
  "GEM_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PATH",
  "PATHEXT",
  "CLASSPATH",
  "GIT_EXEC_PATH",
  "GIT_SSH_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
]);

function envKeyForMatch(key: string): string {
  return process.platform === "win32" ? key.toUpperCase() : key;
}

export function isStartupOnlyEnvKey(key: string): boolean {
  const name = envKeyForMatch(key);
  if (name.startsWith("DYLD_")) return true;
  if (name.startsWith("LD_PRELOAD")) return true;
  return STARTUP_ONLY_ENV_NAMES.has(name);
}

function stringEntries(source: NodeJS.ProcessEnv): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") entries.push([key, value]);
  }
  return entries;
}

/**
 * Environment for a shell command. Ordinary variables come from the current
 * process. Variables that can change which code runs keep the value they had
 * when the CLI started.
 */
export function shellChildEnv(
  current: NodeJS.ProcessEnv = process.env,
  baseline: NodeJS.ProcessEnv = startupEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of stringEntries(current)) {
    if (isStartupOnlyEnvKey(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of stringEntries(baseline)) {
    if (!isStartupOnlyEnvKey(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Environment for a stdio MCP server: the same rules as a shell command, then
 * the server's own `env` block (that block is explicit configuration).
 */
export function mcpStdioEnv(
  serverEnv: Record<string, string> | undefined,
  current: NodeJS.ProcessEnv = process.env,
  baseline: NodeJS.ProcessEnv = startupEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  // The host's own variables pass through the same scrub as a command's; the
  // server's `env` block below is the person's explicit choice and is not
  for (const [key, value] of stringEntries(
    terminalEnvironment(shellChildEnv(current, baseline)),
  )) {
    if (value.length > 0) env[key] = value;
  }
  for (const [key, value] of Object.entries(serverEnv ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/** Parse a .env file. A missing or unreadable file is an empty map. */
export function readDotEnvFile(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return dotenv.parse(fs.readFileSync(filePath));
  } catch {
    return {};
  }
}
