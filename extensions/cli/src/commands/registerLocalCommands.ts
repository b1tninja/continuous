import type { Command } from "commander";

import { registerCleanCommand } from "./clean.js";
import { registerModelsCommand } from "./models.js";
import { registerPlanCommand } from "./plan.js";
import { registerMcpCommand } from "./registerMcpCommand.js";
import { registerRewindCommand } from "./rewind.js";
import { registerSecretsCommand } from "./secrets.js";
import { registerSessionsCommand } from "./sessionsClean.js";

/**
 * Subcommands that work on local files and need no login: `secrets` (scan
 * files for secrets, exit 3 on a finding), `clean` (retention for the
 * product's own persisted files, dry run unless --yes), `sessions clean`
 * (old prompt logs out of saved sessions, dry run unless --yes), `plan`
 * (`plan list` / `plan build`), `rewind` (a session's checkpoints), `models`
 * (`models refresh` / `models list`, the one explicit request for OpenRouter's
 * public model list) and `mcp` (add, add-json, list, test and remove MCP
 * servers in config.yaml). Kept out of index.ts to hold its line limit.
 */
export function registerLocalCommands(program: Command): void {
  registerSecretsCommand(program);
  registerCleanCommand(program);
  registerSessionsCommand(program);
  registerPlanCommand(program);
  registerRewindCommand(program);
  registerModelsCommand(program);
  registerMcpCommand(program);
}
