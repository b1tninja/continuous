import type { Command } from "commander";

import { gracefulExit } from "../util/exit.js";

import { doctorConfigCommand } from "./doctorConfig.js";
import { resetCommand } from "./reset.js";

/**
 * Subcommands for getting out of a broken state. Kept out of index.ts to hold
 * its line limit.
 *
 * `config check [file]` is `doctor config` under the name people look for
 * when a config file does not load. `reset` moves one scope of the
 * product's own state to a backup folder; a dry run unless --yes.
 */
export function registerRecoveryCommands(program: Command): void {
  program
    .command("config [action] [file]")
    .description(
      "config check [file]: do config.yaml, permissions.yaml, the hook settings and the MCP server entries parse, and what is each control's value and source (same as doctor config)",
    )
    .option("--json", "Machine-readable output")
    .action(
      async (
        action: string | undefined,
        file: string | undefined,
        options: { json?: boolean },
      ) => {
        if (action !== "check") {
          process.stderr.write("Usage: continuous config check [file]\n");
          await gracefulExit(1);
          return;
        }
        const code = doctorConfigCommand({
          json: options.json,
          configFile: file,
          flags: program.opts(),
        });
        await gracefulExit(code);
      },
    );

  program
    .command("reset")
    .description(
      "Put this product's own state back to as installed, one scope at a time, keeping your models and keys. A dry run unless --yes; with --yes each entry is moved to a backup folder in the global folder, never deleted. Never touches ~/.continue",
    )
    .option("--sessions", "Saved sessions and the prompt input history")
    .option(
      "--trust",
      "Trusted projects, trusted hooks and pinned MCP tool definitions",
    )
    .option(
      "--permissions",
      "permissions.yaml: levels, rules, floor and Protection switches",
    )
    .option("--caches", "The code index, the Bedrock model list and diffs")
    .option("--all", "All of the above")
    .option("--yes", "Move the files (without it nothing changes)")
    .option("--json", "Machine-readable output")
    .action(async (options) => {
      await gracefulExit(resetCommand(options));
    });
}
