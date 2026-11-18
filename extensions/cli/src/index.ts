#!/usr/bin/env node

// MUST be the first import - intercepts console/stdout/stderr before any dependencies load
import "./init.js";

import { Command } from "commander";
import { parseEnvDetail } from "core/util/environmentSnapshot.js";
import { dismissCurrentNotice } from "core/util/retirementStartup.js";

import { acp } from "./commands/acp.js";
import { agentsCommand } from "./commands/agents.js";
import { auditCommand } from "./commands/audit.js";
import { addAuditSuggestOptions } from "./commands/auditSuggest.js";
import { chat } from "./commands/chat.js";
import { doctorCommand } from "./commands/doctor.js";
import { hooksCommand } from "./commands/hooks.js";
import { listSessionsCommand } from "./commands/ls.js";
import { permissionsCommand } from "./commands/permissions.js";
import { projectCommand } from "./commands/project.js";
import { registerExportCommand } from "./commands/registerExportCommand.js";
import { registerLocalCommands } from "./commands/registerLocalCommands.js";
import { registerRecoveryCommands } from "./commands/registerRecoveryCommands.js";
import { prepareResume, RESUME_FLAG_HELP } from "./commands/resumePicker.js";
import { review } from "./commands/review.js";
import { registerReviewerCommand } from "./commands/reviewEval.js";
import { sandboxCommand } from "./commands/sandbox.js";
import { serve } from "./commands/serve.js";
import { terminalEnvCommand } from "./commands/terminalEnv.js";
import { testConnectionCommand } from "./commands/testConnection.js";
import { setEnvironmentDetail } from "./environmentContext.js";
import {
  handleValidationErrors,
  validateFlags,
} from "./flags/flagValidator.js";
import { configureConsoleForHeadless, safeStderr } from "./init.js";
import { applySafeMode, SAFE_FLAG_HELP } from "./safeMode.js";
import { addRootOptions, mergeParentOptions } from "./shared-options.js";
import { markUnhandledError } from "./util/errorState.js";
import { gracefulExit } from "./util/exit.js";
import { logger } from "./util/logger.js";
import { exitBecause } from "./util/processErrors.js";
import { readStdinSync } from "./util/stdin.js";
import { startupVersion } from "./webAgentVersion.js";

// TUI lifecycle and two-stage exit state management
let tuiUnmount: (() => void) | null;
let showExitMessage: boolean;
let exitMessageCallback: (() => void) | null;
let lastCtrlCTime: number;

// Initialize state immediately to avoid temporal dead zone issues with exported functions
(function initializeTUIState() {
  tuiUnmount = null;
  showExitMessage = false;
  exitMessageCallback = null;
  lastCtrlCTime = 0;
})();

// Register TUI cleanup function for graceful shutdown
export function setTUIUnmount(unmount: () => void) {
  tuiUnmount = unmount;
}

// Register callback to trigger UI updates when exit message state changes
export function setExitMessageCallback(callback: () => void) {
  exitMessageCallback = callback;
}

// Sets up SIGINT handler that requires double Ctrl+C within 1 second to exit
export function enableSigintHandler() {
  // Remove all existing SIGINT listeners first
  process.removeAllListeners("SIGINT");

  process.on("SIGINT", async () => {
    const now = Date.now();
    const timeSinceLastCtrlC = now - lastCtrlCTime;

    if (timeSinceLastCtrlC <= 1000 && lastCtrlCTime !== 0) {
      // Second Ctrl+C within 1 second - exit
      showExitMessage = false;
      if (tuiUnmount) {
        tuiUnmount();
      }
      await gracefulExit(0);
    } else {
      // First Ctrl+C or too much time elapsed - show exit message
      lastCtrlCTime = now;
      showExitMessage = true;
      if (exitMessageCallback) {
        exitMessageCallback();
      }

      // Hide message after 1 second
      setTimeout(() => {
        showExitMessage = false;
        if (exitMessageCallback) {
          exitMessageCallback();
        }
      }, 1000);
    }
  });
}

// Check if "ctrl+c to exit" message should be displayed
export function shouldShowExitMessage(): boolean {
  return showExitMessage;
}

// Add global error handlers to prevent uncaught errors from crashing the process
process.on("unhandledRejection", (reason, promise) => {
  // Mark that an unhandled error occurred - this will cause non-zero exit
  markUnhandledError();

  // Extract useful information from the reason
  const errorDetails = {
    promiseString: String(promise),
    reasonType: typeof reason,
    reasonConstructor: reason?.constructor?.name,
  };

  // If reason is an Error, use it directly for better stack traces
  if (reason instanceof Error) {
    logger.error("Unhandled Promise Rejection", reason, errorDetails);
  } else {
    // Convert non-Error reasons to Error for consistent handling
    const error = new Error(`Unhandled rejection: ${String(reason)}`);
    logger.error("Unhandled Promise Rejection", error, {
      ...errorDetails,
      originalReason: String(reason),
    });
  }

  // Don't exit the process immediately, but hasUnhandledError will cause non-zero exit later
});

process.on("uncaughtException", (error) => {
  const asError = error instanceof Error ? error : new Error(String(error));
  // Leave: staying up after an uncaught exception leaves serve idle with no
  // listener.
  exitBecause(asError, "Uncaught Exception:");
});

// keyboard interruption handler for non-TUI flows
process.on("SIGINT", async () => {
  await gracefulExit(130);
});

// Exported for tests that run the real option wiring without a network.
export const program = new Command();

program
  .name("continuous")
  .description(
    "Continuous CLI - AI-powered development assistant. Starts an interactive session by default, use -p/--print for non-interactive output.",
  )
  .version(startupVersion(), "-v, --version", "Display version number");

// Root command - chat functionality (default)
// Add common options to the root command
addRootOptions(program)
  .option("--safe", SAFE_FLAG_HELP)
  .argument("[prompt]", "Optional prompt to send to the assistant")
  .option("-p, --print", "Print response and exit (useful for pipes)")
  .option(
    "--format <format>",
    "Output format for headless mode: json, or stream-json (one JSON event per line on stdout). Only works with -p/--print flag.",
  )
  .option(
    "--output-schema <file>",
    "Headless (-p): check the final answer against this JSON Schema file; exit 6 when it does not match",
  )
  .option(
    "--silent",
    "Strip <think></think> tags and excess whitespace from output. Only works with -p/--print flag.",
  )
  .option("--resume [sessionId]", RESUME_FLAG_HELP)
  .option("--fork <sessionId>", "Fork from an existing session ID")
  .option(
    "--beta-subagent-tool",
    "Enable beta Subagent tool for invoking subagents",
  )
  .option(
    "--trust-project-hooks",
    "Run this project's hooks for this session without asking (see `continuous hooks`)",
  )
  .option(
    "--ignore-broken-config",
    "Headless (-p, serve): continue when a hook settings file or permissions.yaml is present but unparseable, with that file ignored. Without it the run exits with code 2",
  )
  .option(
    "--trust-project-config",
    "Use this project's Continuous configuration for this session without asking (see `continuous project`)",
  )
  .action(async (prompt, options) => {
    // Handle piped input - detect it early and decide on mode
    let stdinInput = null;

    if (!options.print) {
      // Check if there's piped input available
      stdinInput = readStdinSync();
      if (stdinInput) {
        // Use piped input as the initial prompt
        if (prompt) {
          // Combine stdin and prompt argument
          prompt = `${stdinInput}\n\n${prompt}`;
        } else {
          // Only stdin input, use as initial prompt
          prompt = stdinInput;
        }

        // We have piped input but want to use TUI mode
        // Store a flag to pass custom stdin to TUI
        (options as any).hasPipedInput = true;
      }
    }

    // Configure console overrides FIRST, before any other logging
    const isHeadless = options.print;
    configureConsoleForHeadless(isHeadless);
    logger.configureHeadlessMode(isHeadless);

    // Validate all command line flags
    const validation = validateFlags({
      print: options.print,
      format: options.format,
      outputSchema: options.outputSchema,
      silent: options.silent,
      readonly: options.readonly,
      auto: options.auto,
      config: options.config,
      resume: options.resume,
      fork: options.fork,
      sessionPersistence: options.sessionPersistence,
      allow: options.allow,
      ask: options.ask,
      exclude: options.exclude,
      isRootCommand: true,
      commandName: "cn",
    });

    if (!validation.isValid) {
      handleValidationErrors(validation.errors);
    }

    // --safe, before anything reads a settings or project file
    applySafeMode(options);

    if (options.verbose) {
      logger.setLevel("debug");
      const logPath = logger.getLogPath();
      const sessionId = logger.getSessionId();
      // In headless mode, suppress these verbose logs
      if (!isHeadless) {
        console.log(`Verbose logging enabled (session: ${sessionId})`);
        console.log(`Logs: ${logPath}`);
        console.log(
          `Filter this session: grep '\\[${sessionId}\\]' ${logPath}`,
        );
      }
      logger.debug("Verbose logging enabled");
    }

    // --env-detail: how much the model is told about the machine (ENV18)
    if (options.envDetail !== undefined) {
      const detail = parseEnvDetail(options.envDetail);
      if (!detail) {
        safeStderr(
          `--env-detail must be minimal, standard or full (got "${options.envDetail}")\n`,
        );
        process.exit(1);
      }
      setEnvironmentDetail(detail);
    }

    // Handle piped input for headless mode (only if we haven't already read it)
    if (options.print && !stdinInput) {
      const headlessStdinInput = readStdinSync();
      if (headlessStdinInput) {
        if (prompt) {
          // Combine stdin and prompt argument - stdin comes first in XML block
          prompt = `<stdin>\n${headlessStdinInput}\n</stdin>\n\n${prompt}`;
        } else {
          // Only stdin input, use as-is
          prompt = headlessStdinInput;
        }
      }
    }

    // --resume <id>, or the session picker (commands/resumePicker.ts)
    prompt = await prepareResume(options, prompt);

    // In headless mode, ensure we have a prompt unless using --agent flag or --resume flag
    // Agent files can provide their own prompts, and resume can work without new input
    if (options.print && !prompt && !options.agent && !options.resume) {
      safeStderr(
        "Error: A prompt is required when using the -p/--print flag, unless --agent or --resume is provided.\n\n",
      );
      safeStderr("Usage examples:\n");
      safeStderr('  cn -p "please review my current git diff"\n');
      safeStderr('  echo "hello" | cn -p\n');
      safeStderr('  cn -p "analyze the code in src/"\n');
      safeStderr("  cn -p --agent ./agents/my-agent.md\n");
      safeStderr("  cn -p --prompt ./notes.md 'summarize these notes'\n");
      safeStderr("  cn -p --resume\n");
      await gracefulExit(1);
    }

    // Map --print to headless mode
    options.headless = options.print;
    options.print = undefined;
    await chat(prompt, options);
  });

// List sessions subcommand
program
  .command("ls")
  .description("List recent chat sessions and select one to resume")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    await listSessionsCommand({
      format: options.json ? "json" : undefined,
    });
  });

// Export subcommand: a masked transcript, never the session JSON
registerExportCommand(program);

// Serve subcommand
program
  .command("serve [prompt]", { hidden: true })
  .description("Start an HTTP server with /state and /message endpoints")
  .option(
    "--timeout <seconds>",
    "Inactivity timeout in seconds (default: 300)",
    "300",
  )
  .option("--port <port>", "Port to run the server on (default: 8000)", "8000")
  .option(
    "--host <host>",
    "Interface to listen on (default: 127.0.0.1). Anything else listens beyond this computer and requires --token",
    "127.0.0.1",
  )
  .option(
    "--token <token>",
    "Require this bearer token on every request, at least 16 characters (also read from CONTINUOUS_SERVE_TOKEN). Optional on loopback, required off it",
  )
  .option(
    "--allow-origin <origin...>",
    "A browser origin that may call the server, exactly (http://localhost:3000). Default: none",
  )
  .option("--safe", SAFE_FLAG_HELP)
  .action(async (prompt, options) => {
    // Merge parent options with subcommand options
    const mergedOptions = mergeParentOptions(program, options);
    // `cn --safe serve` and `cn serve --safe` are the same
    if (program.opts().safe) mergedOptions.safe = true;
    applySafeMode(mergedOptions);

    if (mergedOptions.verbose) {
      logger.setLevel("debug");
      logger.debug("Verbose logging enabled");
    }

    await serve(prompt, mergedOptions);
  });

// ACP subcommand: the Agent Client Protocol on stdio, for editors that run ACP agents
program
  .command("acp")
  .description(
    "Run as an Agent Client Protocol agent on stdin and stdout (for Zed, JetBrains and other ACP editors)",
  )
  .action(async (options) => {
    const mergedOptions = mergeParentOptions(program, options);
    await acp(mergedOptions);
  });

// Review subcommand
program
  .command("review")
  .description("Run AI-powered reviews on your changes")
  .option("--base <ref>", "Base git ref to diff against (default: auto-detect)")
  .option("--format <format>", "Output format")
  .option("--fix", "Automatically apply suggested fixes")
  .option("--patch", "Show patches")
  .option("--fail-fast", "Stop on first failure")
  .option("--review-agents <agents...>", "Specific review agents to run")
  .option("--verbose", "Enable verbose logging")
  .action(async (options) => {
    await review(options);
  });

// Project configuration trust
program
  .command("project [action]")
  .description(
    "Show, trust or revoke this project's Continuous configuration (list, trust, revoke)",
  )
  .option("-y, --yes", "Trust without asking, for scripts")
  .action(async (action: string | undefined, options) => {
    const code = await projectCommand(action, { yes: options.yes });
    await gracefulExit(code);
  });

// Hooks subcommand
program
  .command("hooks [action] [event]")
  .description(
    "Show, trust or revoke hooks (list, trust, revoke), or try the hooks for a sample event without running a tool (test <event>)",
  )
  .option("-y, --yes", "Trust without asking, for scripts")
  .option(
    "--tool <name>",
    "test: the tool name for a tool event (default Bash)",
  )
  .option("--server <name>", "test: the MCP server, for a tool event")
  .option(
    "--input <json>",
    "test: a JSON object merged over the sample hook input",
  )
  .action(
    async (action: string | undefined, event: string | undefined, options) => {
      const code = await hooksCommand(action, {
        yes: options.yes,
        event,
        tool: options.tool,
        server: options.server,
        input: options.input,
      });
      await gracefulExit(code);
    },
  );

// Connection diagnostics
program
  .command("doctor [topic] [urls...]")
  .description(
    "Read-only diagnostics: doctor config (settings files and each control's value and source), doctor network [url...] (proxy and certificates), doctor env (what the agent is told about this machine)",
  )
  .option("--json", "config and env: machine-readable output")
  .option(
    "--surface <surface>",
    "doctor env: preview another surface (cli, ide-agent, subagent, ...)",
  )
  .option(
    "--detail <level>",
    "doctor env: preview another detail level (minimal, standard, full)",
  )
  .action(
    async (
      topic: string | undefined,
      urls: string[],
      opts: { json?: boolean; surface?: string; detail?: string },
    ) => {
      const code = await doctorCommand(topic, urls, {
        json: opts.json,
        flags: program.opts(),
        env: { json: opts.json, surface: opts.surface, detail: opts.detail },
      });
      await gracefulExit(code);
    },
  );

// Reviewer evaluation: dry by default, --run sends the requests
registerReviewerCommand(program, gracefulExit);

// Terminal environment subcommand
program
  .command("terminal-env [action]")
  .description(
    "Show whether commands inherit your environment variables and secrets (show)",
  )
  .action(async (action: string | undefined) => {
    const code = terminalEnvCommand(action);
    await gracefulExit(code);
  });

// Permissions subcommand
program
  .command("permissions [action] [args...]")
  .description(
    "List every permission rule with its source and state, or test a call against them (list, test <tool> <arg...>, add <never|ask|always> <rule>, remove <rule>, adopt <rule> --from <file>)",
  )
  .option("--json", "Machine-readable output")
  .option(
    "--area <area>",
    "list: only context, tools, edits, plan or questions",
  )
  .option("--mode <mode>", "test: agent, plan or chat")
  .option(
    "--level <area=level>",
    "test: use this level for an area (repeatable)",
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option("--output <text>", "test: text a tool returned, to check the notice")
  .option("--decision <list>", "remove, adopt: never, ask or always")
  .option("--from <file>", "adopt: the workspace or assistant file")
  .option("--yes", "remove: confirm removing a Never or loosening a rule")
  .option(
    "--yes-allow-everything",
    "add, adopt: confirm a rule that allows everything or a broad wildcard",
  )
  .option("--dry-run", "add, remove, adopt: show the change, write nothing")
  .option("--probe <text>", "add, adopt: a sample call to show what changes")
  .action(
    async (action: string | undefined, args: string[] | undefined, options) => {
      const code = permissionsCommand(action, args ?? [], options);
      await gracefulExit(code);
    },
  );

// Local-file subcommands: secrets, clean, plan
registerLocalCommands(program);

// Recovery subcommands: config check
registerRecoveryCommands(program);

// Sandbox status subcommand
program
  .command("sandbox [action]")
  .description(
    "Show whether the srt sandbox runtime could run here and the policy it would get; a status probe, nothing is sandboxed (status)",
  )
  .option("--json", "Machine-readable output")
  .option("--model-host <host>", "The model host the network allowlist names")
  .option("--workspace <dir>", "The workspace the policy preview is for")
  .action(async (action: string | undefined, options) => {
    const code = sandboxCommand(action, {
      json: options.json,
      modelHost: options.modelHost,
      workspace: options.workspace,
    });
    await gracefulExit(code);
  });

// Agents subcommand: the agents of a running `cn serve`
program
  .command("agents [action]")
  .description("List the agents of a running cn serve (list)")
  .option("--json", "Machine-readable output")
  .option(
    "--url <url>",
    "The server's address (default: http://127.0.0.1:8000)",
  )
  .option(
    "--token <token>",
    "The server's bearer token (also read from CONTINUOUS_SERVE_TOKEN)",
  )
  .action(async (action: string | undefined, options) => {
    const code = await agentsCommand(action, options);
    await gracefulExit(code);
  });

// Audit subcommand
addAuditSuggestOptions(
  program
    .command("audit [action] [session]")
    .description(
      "Read the audit trail of tool call decisions (list, show <session>, changes, inbox, suggest, shadow, prune)",
    )
    .option("--json", "Machine-readable output")
    .option("--session <id>", "Only this session")
    .option("--decision <d>", "allow, ask, deny or reviewer")
    .option("--tool <name>", "Only this tool")
    .option("--agent <who>", "Only this agent (role, id or kind)")
    .option("--since <date>", "From this date (inclusive)")
    .option("--until <date>", "Up to this date (inclusive)")
    .option(
      "--limit <n>",
      "Only the last n calls (shadow: disagreements shown)",
    )
    .option("--model <name>", "shadow: only this reviewer model")
    .option("--days <n>", "prune: delete files older than this many days")
    .option("--dry-run", "prune: say what would be deleted"),
).action(
  async (action: string | undefined, session: string | undefined, options) => {
    const code = auditCommand(action, session, options);
    await gracefulExit(code);
  },
);

// Test connection for an OpenAI-compatible endpoint
program
  .command("test-connection")
  .description(
    "Check an endpoint: models listed, and with --model how it answers a tool call (Anthropic: whether the model is deprecated or retiring)",
  )
  .option(
    "--provider <name>",
    "Provider (openai, anthropic, ollama, llama.cpp, ...)",
  )
  .option("--api-base <url>", "API base URL (defaults per provider)")
  .option("--api-key-env <name>", "Environment variable holding the API key")
  .option("--model <id>", "Also send one tool-call probe to this model")
  .option("--json", "Machine-readable output")
  .option("--no-record", "Do not write the result to the local facts file")
  .action(async (options) => {
    const code = await testConnectionCommand(options);
    await gracefulExit(code);
  });

// Hide the retirement notice for a model (it is shown at start-up once a day)
program
  .command("dismiss-notice <model>")
  .description(
    "Hide the deprecation or retirement notice shown at start-up for an Anthropic model",
  )
  .action(async (model: string) => {
    const hidden = dismissCurrentNotice({ provider: "anthropic", model });
    console.log(
      hidden ? `Notice for ${model} hidden.` : `No notice for ${model}.`,
    );
    await gracefulExit(0);
  });

// Handle unknown commands
program.on("command:*", () => {
  console.error(`Error: Unknown command '${program.args.join(" ")}'\n`);
  program.outputHelp();
  void gracefulExit(1);
});

export async function runCli(): Promise<void> {
  // Handle internal worker subprocess for cn review
  if (process.argv.includes("--internal-review-worker")) {
    const { runReviewWorker } =
      await import("./commands/review/reviewWorker.js");
    await runReviewWorker();
    return;
  }
  // A worker of Loop mode's parallel wave (src/loop/loopWorker.ts)
  if (process.argv.includes("--internal-loop-worker")) {
    const { runLoopWorker } = await import("./loop/loopWorker.js");
    await runLoopWorker();
    return;
  }

  // Parse arguments and handle errors
  try {
    program.parse();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  process.on("SIGTERM", async () => {
    await gracefulExit(0);
  });
}
