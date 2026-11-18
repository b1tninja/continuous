import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { promisify } from "util";

import chalk from "chalk";
import {
  decideFromFiles,
  readScopeFilesFromDisk,
} from "core/config/projectTrust.js";

const execAsync = promisify(exec);

import { getGlobalDir } from "../hooks/hookTrust.js";
import { formatError } from "../util/formatError.js";
import { logger } from "../util/logger.js";

interface EnvironmentConfig {
  install?: string;
}

/**
 * The user's own switch, in `settings.json` in their Continuous folder (never
 * the project's): `{ "environmentInstall": false }` stops `serve` from running
 * an `install` command from a project's environment.json, trusted or not.
 */
function environmentInstallDisabled(cwd: string): boolean {
  const dir = getGlobalDir(cwd);
  if (!dir) return false;
  const file = path.join(dir, "settings.json");
  try {
    if (!existsSync(file)) return false;
    return (
      JSON.parse(readFileSync(file, "utf-8"))?.environmentInstall === false
    );
  } catch {
    return false;
  }
}

/**
 * Finds environment.json and returns its config only when the project is
 * trusted for it (see core/config/projectTrust.ts: `continuous project trust`,
 * or --trust-project-config for one run). The file that was fingerprinted is
 * the file that is parsed, so it cannot change in between.
 */
function findEnvironmentFile(
  cwd: string,
  globalDir?: string,
): EnvironmentConfig | null {
  const files = readScopeFilesFromDisk(cwd, "environment");
  if (files.length === 0) {
    logger.debug("No environment.json file found");
    return null;
  }

  const { trusted } = decideFromFiles(cwd, "environment", files, globalDir);
  if (!trusted) {
    const names = files
      .map((file) => path.relative(cwd, file.path).split(path.sep).join("/"))
      .join(", ");
    process.stderr.write(
      `Not running the install command in ${names}: this folder is not trusted for it. Review the file, then run \`continuous project trust\` (or pass --trust-project-config for this run).\n`,
    );
    return null;
  }

  for (const file of files) {
    try {
      const config = JSON.parse(file.content) as EnvironmentConfig;
      logger.debug(`Found environment.json at: ${file.path}`);
      return config;
    } catch (error) {
      logger.error(
        `Failed to parse environment.json at ${file.path}: ${formatError(error)}`,
      );
      return null;
    }
  }
  return null;
}

/**
 * Runs the install script from environment.json if present
 * Now runs asynchronously to avoid blocking server startup
 */
export async function runEnvironmentInstall(
  cwd: string = process.cwd(),
  globalDir?: string,
): Promise<void> {
  if (environmentInstallDisabled(cwd)) {
    logger.debug("environmentInstall is off in your settings, skipping...");
    return;
  }
  const environmentConfig = findEnvironmentFile(cwd, globalDir);

  if (!environmentConfig || !environmentConfig.install) {
    logger.debug("No install script found in environment.json, skipping...");
    return;
  }

  const installScript = environmentConfig.install;
  logger.debug(
    chalk.blue(
      `\nRunning environment install script: ${chalk.dim(installScript)}`,
    ),
  );

  try {
    await execAsync(installScript, {
      cwd,
      encoding: "utf-8",
    });

    logger.debug(
      chalk.green("✓ Environment install script completed successfully"),
    );
  } catch (error) {
    logger.error(`Environment install script failed: ${formatError(error)}`);
    throw new Error(
      `Failed to run environment install script: ${formatError(error)}`,
    );
  }
}

/**
 * Runs the install script from environment.json if present, with error handling
 * This version doesn't throw errors to avoid blocking server startup
 */
export async function runEnvironmentInstallSafe(
  cwd: string = process.cwd(),
  globalDir?: string,
): Promise<void> {
  try {
    await runEnvironmentInstall(cwd, globalDir);
  } catch (error) {
    logger.error(
      chalk.yellow("Warning: Environment install script failed:"),
      formatError(error),
    );
    logger.error(
      chalk.dim("Server will continue to run without the install script."),
    );
  }
}

/**
 * Gets the environment configuration if available
 */
export function getEnvironmentConfig(
  cwd: string = process.cwd(),
): EnvironmentConfig | null {
  return findEnvironmentFile(cwd);
}
