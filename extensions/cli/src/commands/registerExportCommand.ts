import type { Command } from "commander";

import { gracefulExit } from "../util/exit.js";

/**
 * `export <session>`: a session as a masked transcript (Markdown or HTML),
 * never the session JSON. Kept out of index.ts to hold its line limit.
 */
export function registerExportCommand(program: Command): void {
  program
    .command("export <session>")
    .description(
      "Write a session as a masked transcript (Markdown or HTML) to stdout or --out; <session> is an id, the start of one, or last",
    )
    .option("--format <format>", "md (default) or html")
    .option("--out <file>", "Write to this file instead of stdout")
    .option("--force", "Replace --out if it exists")
    .option(
      "--reasoning",
      "Include the model's reasoning (left out by default)",
    )
    .action(async (session: string, options) => {
      const { exportCommand } = await import("../export/exportCommand.js");
      await gracefulExit(
        exportCommand(session, {
          format: options.format,
          out: options.out,
          force: options.force,
          includeReasoning: options.reasoning,
        }),
      );
    });
}
