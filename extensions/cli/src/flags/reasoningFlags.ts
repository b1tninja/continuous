import type { Command } from "commander";

/**
 * The root command's reasoning flags: `--thinking` (how the terminal UI
 * shows reasoning, ui/thinkingDisplay.ts) and `--include-reasoning` (the
 * stream-json `reasoning` lines, headless/streamJsonHeadless.ts).
 */
export function addReasoningFlags(command: Command): Command {
  return command
    .option(
      "--thinking <mode>",
      "How the terminal UI shows the model's reasoning: fold (live, then one line after the answer; the default), expanded, or hide",
    )
    .option(
      "--include-reasoning",
      "Headless (-p) with --format stream-json: also write each reply's reasoning as a `reasoning` line (left out by default)",
    );
}
