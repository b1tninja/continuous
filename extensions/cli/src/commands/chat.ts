import { ModelConfig } from "@continuedev/config-yaml";
import { BaseLlmApi } from "@continuedev/openai-adapters";
import chalk from "chalk";
import { ChatHistoryItem, Session } from "core";

import * as runLimits from "../budget/runLimits.js";
import { compactChatHistory, findCompactionIndex } from "../compaction.js";
import { processCommandFlags } from "../flags/flagProcessor.js";
import * as headless from "../headless/streamJsonHeadless.js";
import { runStopHooks } from "../hooks/lifecycleHooks.js";
import {
  describePromptBlocked,
  runUserPromptSubmitHooks,
} from "../hooks/promptHook.js";
import { safeStderr, safeStdout } from "../init.js";
import { configureLogger } from "../logger.js";
import * as logging from "../logging.js";
import { startModelInfoRefresh } from "../modelInfoRefresh.js";
import { seedPlanBuild } from "../plans/planBuild.js";
import { initializeServices, services } from "../services/index.js";
import { serviceContainer } from "../services/ServiceContainer.js";
import {
  AgentFileServiceState,
  ModelServiceState,
  SERVICE_NAMES,
} from "../services/types.js";
import { loadSession, updateSessionHistory } from "../session.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import { startTUIChat } from "../ui/index.js";
import { initThinkingDisplay } from "../ui/thinkingDisplay.js";
import { exitOnBrokenConfig } from "../util/configFileGate.js";
import { gracefulExit } from "../util/exit.js";
import { formatAnthropicError, formatError } from "../util/formatError.js";
import { logger } from "../util/logger.js";
import { describeNetworkFailure } from "../util/networkError.js";
import { question } from "../util/prompt.js";
import { prependPrompt } from "../util/promptProcessor.js";
import {
  calculateContextUsagePercentage,
  countChatHistoryTokens,
} from "../util/tokenizer.js";

import { ExtendedCommandOptions } from "./BaseCommandOptions.js";
import { processJsonOutput, stripThinkTags } from "./chatOutput.js";
import { handleTitleGeneration } from "./chatTitle.js";
import { printRetirementNotice } from "./retirementNotice.js";

export interface ChatOptions extends ExtendedCommandOptions {
  headless?: boolean;
  resume?: boolean;
  fork?: string; // Fork from an existing session ID
  format?: headless.HeadlessFormat; // Output format for headless mode
  silent?: boolean; // Strip <think></think> tags and excess whitespace
  outputSchema?: string; // --output-schema: a JSON Schema the final answer must match
  thinking?: string; // --thinking: fold, expanded or hide (ui/thinkingDisplay.ts)
  includeReasoning?: boolean; // --include-reasoning: stream-json `reasoning` lines
}

export async function initializeChatHistory(
  options: ChatOptions,
): Promise<ChatHistoryItem[]> {
  let session: Session | null = null;

  // Fork from an existing session if --fork flag is used
  if (options.fork) {
    const { loadSessionById, forkIntoNewSession } =
      await import("../session.js");
    const sessionToFork = loadSessionById(options.fork);
    if (sessionToFork) {
      logger.info(chalk.yellow("Forking from existing session..."));
      const newSession = forkIntoNewSession(sessionToFork);
      return newSession.history;
    } else {
      logger.error(chalk.red(`Session with ID "${options.fork}" not found.`));
      await gracefulExit(1);
    }
  }

  // Load previous session if --resume flag is used
  if (options.resume) {
    session = loadSession();
    if (session) {
      logger.info(chalk.yellow("Resuming previous session..."));
      return session.history;
    } else {
      logger.info(chalk.yellow("No previous session found, starting fresh..."));
    }
  }

  return [];
}

// Helper function to handle manual compaction
async function handleManualCompaction(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
  llmApi: BaseLlmApi,
  isHeadless: boolean,
): Promise<{ compactionIndex?: number | null } | void> {
  if (!isHeadless) {
    console.info(chalk.yellow("Compacting chat history..."));
  }

  try {
    const current = services.chatHistory.getHistory();
    const result = await compactChatHistory(current, model, llmApi);

    // Update service-driven history (persistence handled by service)
    services.chatHistory.compact(
      result.compactedHistory,
      result.compactionIndex,
    );

    if (isHeadless) {
      safeStdout(
        JSON.stringify({
          status: "success",
          message: "Chat history compacted",
          historyLength: services.chatHistory.getHistory().length,
        }) + "\n",
      );
    } else {
      console.info(chalk.green("Chat history compacted successfully."));
    }

    return { compactionIndex: result.compactionIndex };
  } catch (error) {
    const errorMsg = `Compaction error: ${formatError(error)}`;
    if (isHeadless) {
      safeStdout(JSON.stringify({ status: "error", message: errorMsg }) + "\n");
    } else {
      console.error(chalk.red(errorMsg));
    }
    return;
  }
}

// Helper function to get streaming response based on compaction state
async function getStreamingResponse(
  compactionIndex: number | null | undefined,
  model: ModelConfig,
  llmApi: BaseLlmApi,
): Promise<string> {
  const abortController = new AbortController();
  // --format stream-json: the stream hears each reply and finished request
  const { callbacks, options } = headless.streamJsonHooks();
  // The service's history for the LLM after a compaction, else the full one
  const history =
    compactionIndex !== null && compactionIndex !== undefined
      ? services.chatHistory.getHistoryForLLM(compactionIndex)
      : services.chatHistory.getHistory();
  return await streamChatResponse(
    history,
    model,
    llmApi,
    abortController,
    callbacks,
    false,
    options,
  );
}

// Helper function to process and output response in headless mode
function processAndOutputResponse(
  finalResponse: string,
  isHeadless: boolean,
  silent?: boolean,
  format?: headless.HeadlessFormat,
): void {
  // stream-json keeps the answer for its `result` line and prints nothing
  if (headless.noteHeadlessAnswer(finalResponse, silent, format)) return;
  if (isHeadless && finalResponse && finalResponse.trim()) {
    let processedResponse = finalResponse;

    // Strip think tags if --silent flag is enabled
    if (silent) {
      processedResponse = stripThinkTags(processedResponse);
    }

    // Process output based on format
    const outputResponse =
      format === "json"
        ? processJsonOutput(processedResponse)
        : processedResponse;

    safeStdout(outputResponse + "\n");
  }
}

// Helper function to handle auto-compaction for headless mode
async function handleAutoCompaction(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
  llmApi: BaseLlmApi,
  isHeadless: boolean,
  format?: headless.HeadlessFormat,
): Promise<number | null> {
  const { handleAutoCompaction: coreAutoCompaction } =
    await import("../stream/streamChatResponse.autoCompaction.js");

  // Custom callbacks for headless mode console output
  const callbacks = {
    onSystemMessage: (message: string) => {
      if (
        message.includes("Auto-compacting") ||
        message.includes("Approaching")
      ) {
        if (!isHeadless) {
          console.info(chalk.yellow(`\n${message}`));
        } else if (format === "json") {
          safeStdout(
            JSON.stringify({
              status: "info",
              message: "Auto-compacting triggered",
              contextUsage:
                calculateContextUsagePercentage(
                  countChatHistoryTokens(
                    services.chatHistory.getHistory(),
                    model,
                  ),
                  model,
                ) + "%",
            }) + "\n",
          );
        }
      } else if (message.includes("✓")) {
        if (!isHeadless) {
          console.info(chalk.green(message));
        } else if (format === "json") {
          // Omit history length here; service updates occur after compaction completes
          safeStdout(
            JSON.stringify({
              status: "success",
              message: "Auto-compacted successfully",
            }) + "\n",
          );
        }
      } else if (message.includes("Warning:")) {
        if (!isHeadless) {
          console.error(chalk.red(message));
          console.info(chalk.yellow("Continuing without compaction..."));
        } else if (format === "json") {
          safeStdout(
            JSON.stringify({
              status: "warning",
              message: "Auto-compaction failed, continuing without compaction",
            }) + "\n",
          );
        }
      }
    },
  };

  const result = await coreAutoCompaction(
    services.chatHistory.getHistory(),
    model,
    llmApi,
    {
      isHeadless,
      format: format === "json" ? format : undefined,
      callbacks,
    },
  );

  // Update service-driven history
  services.chatHistory.setHistory(result.chatHistory);

  return result.compactionIndex;
}

/**
 * Helper to generate and update session title after first assistant response
 */
interface ProcessMessageOptions {
  userInput: string;
  chatHistory: ChatHistoryItem[];
  model: ModelConfig;
  llmApi: BaseLlmApi;
  isHeadless: boolean;
  format?: headless.HeadlessFormat;
  silent?: boolean;
  compactionIndex?: number | null;
  firstAssistantResponse?: boolean;
}

async function processMessage(
  options: ProcessMessageOptions,
): Promise<{ compactionIndex?: number | null } | void> {
  const {
    userInput: typedInput,
    chatHistory,
    model,
    llmApi,
    isHeadless,
    format,
    silent,
    compactionIndex: initialCompactionIndex,
    firstAssistantResponse = false,
  } = options;
  let userInput = typedInput;
  let compactionIndex = initialCompactionIndex;
  // Check for slash commands in headless mode
  if (userInput.trim() === "/compact") {
    return handleManualCompaction(chatHistory, model, llmApi, isHeadless);
  }

  // Track user prompt
  telemetryService.logUserPrompt(userInput.length, userInput);

  // UserPromptSubmit hooks can stop the prompt or add context to it. Headless
  // has no one to show a refusal to, so it fails the run with the reason.
  const promptHook = await runUserPromptSubmitHooks(userInput);
  if (promptHook.blockedReason) {
    const message = describePromptBlocked(promptHook.blockedReason);
    if (isHeadless) throw new Error(message);
    console.info(chalk.red(message));
    return;
  }
  userInput = promptHook.prompt;

  // Check if auto-compacting is needed BEFORE adding user message
  // The handleAutoCompaction function decides whether compaction is actually needed
  const autoCompactionResult = await handleAutoCompaction(
    chatHistory,
    model,
    llmApi,
    isHeadless,
    format,
  );
  if (autoCompactionResult !== null) {
    compactionIndex = autoCompactionResult;
    // Service already updated in handleAutoCompaction via setHistory
  }

  // Add user message to history AFTER potential compaction
  services.chatHistory.addUserMessage(userInput);

  // Get AI response with potential tool usage
  if (!isHeadless) {
    console.info(`\n${chalk.bold.blue("Assistant:")}`);
  }

  try {
    // Get AI response with potential tool usage
    const finalResponse = await getStreamingResponse(
      compactionIndex,
      model,
      llmApi,
    );

    // Generate session title after first assistant response
    if (firstAssistantResponse && finalResponse && finalResponse.trim()) {
      await handleTitleGeneration(finalResponse, llmApi, model);
    }

    // Process and output response in headless mode
    processAndOutputResponse(finalResponse, isHeadless, silent, format);

    await runStopHooks(finalResponse);

    // Save session after each successful response
    updateSessionHistory(services.chatHistory.getHistory());
  } catch (e: any) {
    const error = e instanceof Error ? e : new Error(String(e));

    // In headless mode, don't output JSON here - let error bubble up to main handler
    if (!isHeadless) {
      // Non-headless mode: use colored console output
      if (model.provider === "anthropic") {
        logger.error(`\n${chalk.red(`Error: ${formatAnthropicError(error)}`)}`);
      } else {
        logger.error(`\n${chalk.red(`Error: ${formatError(error)}`)}`);
      }

      logger.info(
        chalk.dim(
          `Chat history:\n${JSON.stringify(
            services.chatHistory.getHistory(),
            null,
            2,
          )}`,
        ),
      );
    }

    // In headless mode, re-throw the error to bubble up to main error handler
    // This preserves downstream logic like telemetry cleanup
    if (isHeadless) {
      throw error;
    }
  }
}

async function runHeadlessMode(
  prompt: string | undefined,
  options: ChatOptions,
): Promise<void> {
  // A broken hooks or permissions file stops the start (exit code 2)
  await exitOnBrokenConfig(options);

  // Initialize services for headless mode
  const { permissionOverrides } = processCommandFlags(options);

  await initializeServices({
    options,
    headless: true,
    toolPermissionOverrides: permissionOverrides,
  });

  seedPlanBuild();

  // Get required services from the service container
  const modelState = await serviceContainer.get<ModelServiceState>(
    SERVICE_NAMES.MODEL,
  );
  const { llmApi, model } = modelState;

  if (!model) {
    throw headless.configError("No models were found.");
  }

  if (!llmApi) {
    throw headless.configError("No LLM API instance found.");
  }

  // Run limits (--max-budget-usd, --max-turns, --max-duration): refuses a
  // dollar budget on an unpriced model before anything is sent
  runLimits.startRunLimits(options, {
    provider: model.provider,
    model: model.model,
    pricing: model.pricing,
  });

  // Initialize service-driven history (resume if requested)
  const chatHistory = await initializeChatHistory(options);
  let compactionIndex: number | null = null;
  if (options.resume || options.fork) {
    services.chatHistory.setHistory(chatHistory);
    compactionIndex = findCompactionIndex(chatHistory);
  }
  headless.startStreamJsonRun(options.format, model); // stream-json: the `init` line

  // Handle additional prompts from --prompt flags
  const { processAndCombinePrompts } =
    await import("../util/promptProcessor.js");
  const agentFileState = await serviceContainer.get<AgentFileServiceState>(
    SERVICE_NAMES.AGENT_FILE,
  );

  const initialPrompt = prependPrompt(
    agentFileState?.agentFile?.prompt,
    prompt,
  );
  const initialUserInput = await processAndCombinePrompts(
    options.prompt,
    initialPrompt,
  );

  // Critical validation: Ensure we have actual prompt text in headless mode
  // This prevents the CLI from hanging in TTY-less environments when question() is called
  // We check AFTER processing all prompts (including agent files) to ensure we have real content
  // EXCEPTION: Allow empty prompts when resuming/forking since they may just want to view history
  if (!initialUserInput || !initialUserInput.trim()) {
    // If resuming or forking, allow empty prompt - just exit successfully after showing history
    if (options.resume || options.fork) {
      // For resume/fork with no new input, we've already loaded the history above
      // Just exit successfully (the history was already loaded into chatHistory)
      await gracefulExit(0);
      return;
    }

    throw new Error(
      'Headless mode requires a prompt. Use: cn -p "your prompt"\n' +
        'Or pipe input: echo "prompt" | cn -p\n' +
        "Or use agent files: cn -p --agent my-org/my-agent\n" +
        "Note: Agent files must contain a prompt field.",
    );
  }

  let isFirstMessage = true;
  while (true) {
    // When in headless mode, don't ask for user input
    if (!isFirstMessage && initialUserInput && options.headless) {
      break;
    }

    // Get user input
    const userInput =
      isFirstMessage && initialUserInput
        ? initialUserInput
        : await question(`\n${chalk.bold.green("You:")} `);

    isFirstMessage = false;

    const result = await processMessage({
      userInput,
      chatHistory,
      model,
      llmApi,
      isHeadless: true,
      format: options.format,
      silent: options.silent,
      compactionIndex,
      firstAssistantResponse: isFirstMessage && !options.resume, // Only generate title for new conversations
    });

    // Update compaction index if compaction occurred
    if (result && result.compactionIndex !== undefined) {
      compactionIndex = result.compactionIndex;
    }
  }

  // exit after headless mode completes: a run limit has its own exit code
  await gracefulExit(headless.endHeadlessRun(options.format));
}

export async function chat(prompt?: string, options: ChatOptions = {}) {
  // Configure logger based on headless mode
  configureLogger(options.headless ?? false);

  // Configure headless-aware logging system
  logging.configureLogger({ headless: options.headless ?? false });

  try {
    // Model information updates: a background refresh of a stale OpenRouter
    // list when the setting is automatic, and of the community catalogue
    // while the run's model has no better price. Sets timers only.
    startModelInfoRefresh(undefined, undefined, {
      currentModel: () => services.model?.getModelId?.(),
    });

    // Record session start
    telemetryService.recordSessionStart();

    // Start active time tracking
    telemetryService.startActiveTime();

    // Critical routing: Explicit separation of headless and interactive modes
    if (options.headless) {
      // Headless path - no Ink, no TUI, works in TTY-less environments
      logger.debug("Running in headless mode (TTY-less compatible)");
      headless.beginHeadlessRun(options);
      await runHeadlessMode(prompt, options);
      return;
    }

    runLimits.assertLimitsEnforceable(options);
    initThinkingDisplay(options.thinking);

    // Interactive path - requires TTY for Ink rendering
    // If not in headless mode, use unified initialization with TUI
    if (!options.headless) {
      // Process flags for TUI mode
      const { permissionOverrides } = processCommandFlags(options);
      // Initialize services with onboarding handled internally
      await initializeServices({
        options,
        headless: false,
        toolPermissionOverrides: permissionOverrides,
      });

      printRetirementNotice();
      seedPlanBuild();

      const agentFileState = await serviceContainer.get<AgentFileServiceState>(
        SERVICE_NAMES.AGENT_FILE,
      );

      const initialPrompt = prependPrompt(
        agentFileState?.agentFile?.prompt,
        prompt,
      );

      // Start TUI with skipOnboarding since we already handled it
      const tuiOptions: any = {
        initialPrompt,
        resume: options.resume,
        fork: options.fork,
        config: options.config,
        org: options.org,
        rule: options.rule,
        prompt: options.prompt,
        toolPermissionOverrides: permissionOverrides,
        skipOnboarding: true,
      };

      // If we detected piped input, create a custom stdin for TUI
      if ((options as any).hasPipedInput) {
        const fs = await import("fs");
        const { ReadStream } = await import("tty");
        const ttyFd = fs.openSync("/dev/tty", "r");
        const customStdin = new ReadStream(ttyFd);
        tuiOptions.customStdin = customStdin;
        logger.debug("Created custom TTY stdin for TUI mode");
      }

      await startTUIChat(tuiOptions);
      return;
    }

    // Run headless mode
    await runHeadlessMode(prompt, options);
  } catch (error: any) {
    const err = error instanceof Error ? error : new Error(String(error));

    const network = describeNetworkFailure(err);

    // In headless mode, output error as JSON to stdout
    if (options.headless && network && options.format !== "json") {
      safeStderr(`Error: ${network.message}\n`);
    } else if (options.headless) {
      const errorOutput = network
        ? { status: "error", ...network }
        : { status: "error", message: err.message || String(err) };
      safeStderr(JSON.stringify(errorOutput) + "\n");
    } else {
      // Use headless-aware error logging for non-headless mode
      logging.error(chalk.red(`Fatal error: ${formatError(err)}`));
    }

    // Stop active time tracking BEFORE graceful exit
    telemetryService.stopActiveTime();

    await gracefulExit(headless.failHeadlessRun(options, err));
  } finally {
    // Stop active time tracking for normal completion
    telemetryService.stopActiveTime();
  }
}
