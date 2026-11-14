import { Command } from "commander";

import { applyDebugPromptLogFlag } from "./util/debugPromptLog.js";

// Function to add common options to any command
export function addCommonOptions(command: Command): Command {
  return command
    .option("--config <path>", "Path to the config.yaml file to use")
    .option(
      "--org <slug>",
      "Organization slug to use for this session (supported only in headless mode)",
    )
    .option("--readonly", "Start in plan mode (read-only tools)")
    .option("--auto", "Start in auto mode (all tools allowed)")
    .option(
      "--auto-review",
      "Experimental: a model with the 'reviewer' role decides tool calls your rules and --allow/--ask/--exclude leave open. Needs a reviewer model in config.yaml. With -p, calls it will not allow are refused.",
    )
    .option(
      "--policy <spec>",
      "Who decides what a rule leaves open, per area (context, tools, edits, plan, questions): a preset (careful, acceptEdits, handsOff, reviewer, idgaf) or area=level pairs such as tools=permissive,plan=manual. Levels: manual, cautious, automatic, permissive, idgaf.",
    )
    .option("--verbose", "Enable verbose logging")
    .option(
      "--debug-prompt-log",
      "Keep each request's full prompt in ~/.continuous/logs/prompts/ (secrets masked, 50 MB, 14 days). Off by default",
    )
    .on("option:debug-prompt-log", () =>
      applyDebugPromptLogFlag({ debugPromptLog: true }),
    )
    .option("--beta-status-tool", "Enable beta status tool")
    .option(
      "--rule <rule>",
      "Add a rule: the rule text, or a path to a rule file (starting with ./, / or ~). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--mcp <url-or-path>",
      "Add an MCP server: an http(s) URL, or a path to a YAML file that defines one (starting with ./, / or ~). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--model <path>",
      "Add a model from a YAML file that defines one (path starting with ./, / or ~). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--prompt <prompt>",
      "Add to the initial user message: the text, or a path to a file that holds it (starting with ./ or /). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--allow <tool>",
      "Allow specified tool (overrides default policies). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--ask <tool>",
      "Ask for permission before using specified tool (overrides default policies). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--exclude <tool>",
      "Exclude specified tool from use (overrides default policies). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option("--agent <path>", "Load an agent file (path to a .md file)");
}

// Function to merge parent options into subcommand options
export function mergeParentOptions(parentCommand: Command, options: any): any {
  const parentOpts = parentCommand.opts();
  const mergedOptions = { ...options };

  // List of options to inherit from parent if not present in subcommand
  const inheritableOptions = [
    "config",
    "org",
    "readonly",
    "auto",
    "autoReview",
    "policy",
    "verbose",
    "rule",
    "mcp",
    "model",
    "prompt",
    "allow",
    "ask",
    "exclude",
    "agent",
    "betaSubagentTool",
    "trustProjectConfig",
    "trustProjectHooks",
    "ignoreBrokenConfig",
    "maxBudgetUsd",
    "maxTurns",
    "maxDuration",
    "budgetAllowUnpriced",
  ];

  for (const optName of inheritableOptions) {
    if (
      parentOpts[optName] !== undefined &&
      mergedOptions[optName] === undefined
    ) {
      mergedOptions[optName] = parentOpts[optName];
    }
  }

  return mergedOptions;
}
