import chalk from "chalk";
import type { ChatHistoryItem } from "core/index.js";
import { maskCommandForDisplay } from "core/tools/permissions/displayMask.js";
import express, { Request, Response } from "express";

import { ToolPermissionServiceState } from "src/services/ToolPermissionService.js";
import { prependPrompt } from "src/util/promptProcessor.js";

import { startRunLimits } from "../budget/runLimits.js";
import { runEnvironmentInstallSafe } from "../environment/environmentHandler.js";
import { processCommandFlags } from "../flags/flagProcessor.js";
import { loopWaveRunning } from "../loop/loopSession.js";
import { toolPermissionManager } from "../permissions/permissionManager.js";
import { isSafeMode } from "../safeMode.js";
import {
  getService,
  initializeServices,
  SERVICE_NAMES,
  services,
} from "../services/index.js";
import {
  AgentFileServiceState,
  ConfigServiceState,
  ModelServiceState,
} from "../services/types.js";
import { createSession } from "../session.js";
import { messageQueue } from "../stream/messageQueue.js";
import { constructSystemMessage } from "../systemMessage.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import { exitOnBrokenConfig } from "../util/configFileGate.js";
import { gracefulExit } from "../util/exit.js";
import { formatError } from "../util/formatError.js";
import { getGitDiffSnapshot } from "../util/git.js";
import { logger } from "../util/logger.js";
import { exitBecause } from "../util/processErrors.js";
import { readStdinSync } from "../util/stdin.js";

import { ExtendedCommandOptions } from "./BaseCommandOptions.js";
import { registerAgentsRoute } from "./serve.agents.js";
import {
  jsonErrorHandler,
  MAX_BODY_BYTES,
  refuseUpgrades,
} from "./serve.auth.js";
import { installServeGuards, type ServerState } from "./serve.helpers.js";
import {
  processMessages,
  registerMessageRoutes,
  type ServeMessageContext,
} from "./serve.messages.js";
import { prepareServeAccessOrExit, printServeBanner } from "./serve.startup.js";

interface ServeOptions extends ExtendedCommandOptions {
  timeout?: string;
  port?: string;
  /** Interface to listen on; loopback unless told otherwise */
  host?: string;
  /** Bearer token every request must carry. Optional on loopback, required off it */
  token?: string;
  /** Browser origins that may call the server, exactly */
  allowOrigin?: string[];
}

/**
 * Decide whether to enqueue the initial prompt on server startup.
 * We only want to send it when starting a brand-new session; if any non-system
 * messages already exist (e.g., after resume), skip to avoid replaying.
 */
export function shouldQueueInitialPrompt(
  history: ChatHistoryItem[],
  prompt?: string | null,
): boolean {
  if (!prompt) {
    return false;
  }

  // If there are any non-system messages, we already have conversation context
  const hasConversation = history.some(
    (item) => item.message.role !== "system",
  );
  return !hasConversation;
}

/** The startup lines: which assistant, model and config file serve runs with. */
function logServeConfiguration(
  assistantName: string | undefined,
  model: { provider: string; model: string },
  configFile: string | undefined,
): void {
  console.log(chalk.blue(`\nConfiguration:`));
  console.log(chalk.dim(`  Assistant: ${assistantName}`));
  console.log(chalk.dim(`  Model: ${model.provider}/${model.model}`));
  if (configFile) {
    console.log(chalk.dim(`  Config file: ${configFile}`));
  }
}

export async function serve(prompt?: string, options: ServeOptions = {}) {
  // Check if prompt should come from stdin instead of parameter
  let actualPrompt = prompt;
  if (!prompt) {
    // Try to read from stdin (for piped input like: cat file | cn serve)
    const stdinInput = readStdinSync();
    if (stdinInput) {
      actualPrompt = stdinInput;
    }
  }

  const timeoutSeconds = parseInt(options.timeout || "300", 10);
  const timeoutMs = timeoutSeconds * 1000;
  const port = parseInt(options.port || "8000", 10);
  // Loopback unless told otherwise. A token is optional on loopback; off
  // loopback one of at least 16 characters is required.
  const { host, auth, token, allowedOrigins } =
    prepareServeAccessOrExit(options);

  // Environment install script will be deferred until after server startup to avoid blocking

  // A broken hooks or permissions file stops the start (exit code 2)
  await exitOnBrokenConfig(options);

  // Initialize services with tool permission overrides
  const { permissionOverrides } = processCommandFlags(options);

  await initializeServices({
    options,
    toolPermissionOverrides: permissionOverrides,
    headless: true, // Skip onboarding in serve mode
  });

  // Get initialized services from the service container
  const [configState, modelState, permissionsState, agentFileState] =
    await Promise.all([
      getService<ConfigServiceState>(SERVICE_NAMES.CONFIG),
      getService<ModelServiceState>(SERVICE_NAMES.MODEL),
      getService<ToolPermissionServiceState>(SERVICE_NAMES.TOOL_PERMISSIONS),
      getService<AgentFileServiceState>(SERVICE_NAMES.AGENT_FILE),
    ]);

  if (!configState.config || !modelState.llmApi || !modelState.model) {
    throw new Error("Failed to initialize required services");
  }

  const { config, llmApi, model } = {
    config: configState.config,
    llmApi: modelState.llmApi,
    model: modelState.model,
  };

  logServeConfiguration(config.name, model, options.config);

  // Run limits cover the whole serve process; see docs/cli/run-limits.mdx
  startRunLimits(options, {
    provider: model.provider,
    model: model.model,
    pricing: model.pricing,
  });

  // Initialize session with system message
  const systemMessage = await constructSystemMessage(
    permissionsState.currentMode,
    options.rule,
    undefined,
    true,
    model.model,
  );

  const initialHistory: ChatHistoryItem[] = [];
  if (systemMessage) {
    initialHistory.push({
      message: { role: "system" as const, content: systemMessage },
      contextItems: [],
    });
  }

  const session = createSession(initialHistory);

  // Align ChatHistoryService with server session and enable remote mode
  try {
    await services.chatHistory.initialize(session, false);
  } catch {
    // Fallback: continue even if service init fails; stream will still work with arrays
  }

  // Initialize server state. The model is read when a turn is sent, not
  // once here: a mode change or a Loop turn may have switched it
  // (`modeModels`), and the switch lives in the model service's state.
  const state: ServerState = {
    session,
    config,
    get model() {
      return services.model.getState().model ?? model;
    },
    isProcessing: false,
    lastActivity: Date.now(),
    currentAbortController: null,
    serverRunning: true,
    pendingPermission: null,
  };

  const syncSessionHistory = () => {
    try {
      state.session.history = services.chatHistory.getHistory();
    } catch (e) {
      logger.debug(
        `Failed to sync session history from ChatHistoryService: ${formatError(e)}`,
      );
    }
  };

  // Record session start
  telemetryService.recordSessionStart();
  telemetryService.startActiveTime();

  const app = express();
  // Host and Origin are checked, then the bearer token, before the body is read.
  installServeGuards(app, {
    boundHost: host,
    token,
    port,
    allowedOrigins,
  });
  app.use(express.json({ limit: MAX_BODY_BYTES }));

  const messageCtx: ServeMessageContext = {
    state,
    get llmApi() {
      return services.model.getState().llmApi ?? llmApi;
    },
    syncSessionHistory,
  };
  registerMessageRoutes(app, messageCtx);
  registerAgentsRoute(app, state);

  // POST /permission - Approve or reject pending tool permission
  app.post("/permission", async (req: Request, res: Response) => {
    state.lastActivity = Date.now();

    const { requestId, approved } = req.body ?? {};

    if (!state.pendingPermission) {
      return res.status(400).json({ error: "No pending permission request" });
    }

    if (state.pendingPermission.requestId !== requestId) {
      return res.status(400).json({ error: "Invalid request ID" });
    }

    // Remove the permission request message if it exists
    // Permission requests are handled separately in unified format

    // Send the permission response to the toolPermissionManager
    if (approved) {
      toolPermissionManager.approveRequest(requestId);
    } else {
      toolPermissionManager.rejectRequest(requestId);
    }

    // Clear pending permission state
    state.pendingPermission = null;

    res.json({
      success: true,
      approved,
    });
  });

  // GET /diff - Return git diff against main branch
  app.get("/diff", async (_req: Request, res: Response) => {
    state.lastActivity = Date.now();

    try {
      const diffResult = await getGitDiffSnapshot();

      if (!diffResult.repoFound) {
        res.status(404).json({
          error: "Not in a git repository or main branch doesn't exist",
          diff: "",
        });
        return;
      }

      // Masked: a diff can hold a key somebody just pasted into a file
      res.json({
        diff: maskCommandForDisplay(diffResult.diff),
      });
    } catch (error) {
      logger.error(`Git diff error: ${formatError(error)}`);
      res.status(500).json({
        error: `Failed to get git diff: ${formatError(error)}`,
        diff: "",
      });
    }
  });

  // Track intervals for cleanup
  let inactivityChecker: NodeJS.Timeout | null = null;

  // POST /exit - Gracefully shut down the server
  app.post("/exit", async (_req: Request, res: Response) => {
    console.log(
      chalk.yellow("\nReceived exit request, shutting down server..."),
    );

    // Respond immediately before shutting down
    res.json({
      message: "Server shutting down",
      success: true,
    });

    // Set server running flag to false to stop processing
    state.serverRunning = false;

    // Abort any current processing
    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }

    // Clean up intervals
    if (inactivityChecker) {
      clearInterval(inactivityChecker);
      inactivityChecker = null;
    }

    // Give a moment for the response to be sent
    const handleExitResponse = async () => {
      server.close(async () => {
        telemetryService.stopActiveTime();

        gracefulExit(0).catch((err) => {
          logger.error(`Graceful exit failed: ${formatError(err)}`);
          process.exit(1);
        });
      });
    };
    setTimeout(handleExitResponse, 100);
  });

  const server = app.listen(port, host, async () => {
    printServeBanner({
      host,
      port,
      auth,
      allowedOrigins,
      timeoutSeconds,
    });

    // Run environment install script after server startup (not under --safe:
    // it is a command from a project file)
    if (!isSafeMode()) runEnvironmentInstallSafe();

    // If initial prompt provided, queue it for processing
    const initialPrompt = prependPrompt(
      agentFileState?.agentFile?.prompt,
      actualPrompt,
    );

    if (initialPrompt) {
      const existingHistory =
        (() => {
          try {
            return services.chatHistory.getHistory();
          } catch {
            return state.session.history;
          }
        })() ?? [];

      if (shouldQueueInitialPrompt(existingHistory, initialPrompt)) {
        logger.info(chalk.dim("\nProcessing initial prompt..."));
        await messageQueue.enqueueMessage(initialPrompt);
        void processMessages(messageCtx);
      } else {
        logger.info(
          chalk.dim(
            "Skipping initial prompt because existing conversation history was found.",
          ),
        );
      }
    }
  });

  refuseUpgrades(server);
  app.use(jsonErrorHandler);

  // EADDRINUSE and other bind failures are emitted here, not thrown. Without
  // a listener they become an uncaught exception and the process stays up.
  server.on("error", (err) => {
    exitBecause(err, "Server failed to listen:");
  });

  // Check for inactivity and shutdown. A wave of loop workers counts as
  // activity: they run beside the server and report back to it.
  inactivityChecker = setInterval(() => {
    if (
      !state.isProcessing &&
      !loopWaveRunning() &&
      Date.now() - state.lastActivity > timeoutMs
    ) {
      console.log(
        chalk.yellow(
          `\nShutting down due to ${timeoutSeconds} seconds of inactivity`,
        ),
      );
      state.serverRunning = false;
      server.close(async () => {
        telemetryService.stopActiveTime();

        gracefulExit(0).catch((err) => {
          logger.error(`Graceful exit failed: ${formatError(err)}`);
          process.exit(1);
        });
      });
      if (inactivityChecker) {
        clearInterval(inactivityChecker);
        inactivityChecker = null;
      }
    }
  }, 1000);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\nShutting down server..."));
    state.serverRunning = false;
    if (inactivityChecker) {
      clearInterval(inactivityChecker);
      inactivityChecker = null;
    }
    server.close(async () => {
      telemetryService.stopActiveTime();

      gracefulExit(0).catch((err) => {
        logger.error(`Graceful exit failed: ${formatError(err)}`);
        process.exit(1);
      });
    });
  });
}
