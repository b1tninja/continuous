import type { Command } from "commander";

import { gracefulExit } from "../util/exit.js";

import { mcpCommand } from "./mcp.js";

/** `continuous mcp add | add-json | list | test | remove` (MCPW7). */
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp [action] [args...]")
    .description(
      "Manage MCP servers. add <paste-or-file>: read a README snippet, show what would run, test it after you agree, then save it to your config.yaml (or --scope project). add-json <name> <json>, list, test <name>, remove <name>",
    )
    .option(
      "--scope <scope>",
      "user (your own config.yaml, the default) or project (.continuous/mcpServers/<name>.yaml)",
    )
    .option("--json", "list: print the servers as JSON")
    .option(
      "--dry-run",
      "Show the review and the entry; start nothing, write nothing",
    )
    .option(
      "--name <name>",
      "The server's name, or which one to add when the paste has several",
    )
    .option("--skip-test", "Save without the test connection")
    .option(
      "--yes-run",
      "Run the test without asking (refused for an unpinned package)",
    )
    .action(
      async (
        action: string | undefined,
        args: string[] | undefined,
        options,
      ) => {
        const code = await mcpCommand(action, args ?? [], {
          dryRun: options.dryRun,
          name: options.name,
          skipTest: options.skipTest,
          yesRun: options.yesRun,
          scope: options.scope,
          json: options.json,
        });
        await gracefulExit(code);
      },
    );
}
