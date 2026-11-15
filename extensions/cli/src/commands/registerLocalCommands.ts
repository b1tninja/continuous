import type { Command } from "commander";

import { registerCleanCommand } from "./clean.js";
import { registerModelsCommand } from "./models.js";
import { registerPlanCommand } from "./plan.js";
import { registerSecretsCommand } from "./secrets.js";
import { registerSessionsCommand } from "./sessionsClean.js";

/**
 * Subcommands that work on local files and need no login: `secrets` (scan
 * files for secrets, exit 3 on a finding), `clean` (retention for the
 * product's own persisted files, dry run unless --yes), `sessions clean`
 * (old prompt logs out of saved sessions, dry run unless --yes) and `plan`
 * (`plan list` / `plan build`) and `models` (`models refresh` / `models list`,
 * the one explicit request for OpenRouter's public model list). Kept out of index.ts to hold its line limit.
 */
export function registerLocalCommands(program: Command): void {
  registerSecretsCommand(program);
  registerCleanCommand(program);
  registerSessionsCommand(program);
  registerPlanCommand(program);
  registerModelsCommand(program);
}
