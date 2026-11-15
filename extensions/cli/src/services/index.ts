import { setProjectConfigTrustedForRun } from "core/config/projectTrust.js";

import { HookService } from "../hooks/HookService.js";
import { setTrustProjectHooksForRun } from "../hooks/hookTrust.js";
import { initializeWithOnboarding } from "../onboarding.js";
import { auditTrust } from "../permissions/policyAudit.js";
import { setBetaSubagentToolEnabled } from "../tools/toolsConfig.js";
import { logger } from "../util/logger.js";

import { AgentFileService } from "./AgentFileService.js";
import { AuthService } from "./AuthService.js";
import { backgroundJobService } from "./BackgroundJobService.js";
import { ChatHistoryService } from "./ChatHistoryService.js";
import { ConfigService } from "./ConfigService.js";
import { FileIndexService } from "./FileIndexService.js";
import { GitAiIntegrationService } from "./GitAiIntegrationService.js";
import { MCPService } from "./MCPService.js";
import { ModelService, type ModelSwitchWhy } from "./ModelService.js";
import { quizService } from "./QuizService.js";
import { ResourceMonitoringService } from "./ResourceMonitoringService.js";
import { SafeModeHookService } from "./SafeModeHookService.js";
import { serviceContainer } from "./ServiceContainer.js";
import { SystemMessageService } from "./SystemMessageService.js";
import {
  InitializeToolServiceOverrides,
  ToolPermissionService,
} from "./ToolPermissionService.js";
import {
  AgentFileServiceState,
  ModelServiceState,
  AuthServiceState,
  ConfigServiceState,
  MCPServiceState,
  SERVICE_NAMES,
  ServiceInitOptions,
} from "./types.js";
import { UpdateService } from "./UpdateService.js";

// Service instances
const authService = new AuthService();
const configService = new ConfigService();
const modelService = new ModelService();
const mcpService = new MCPService();
const fileIndexService = new FileIndexService();
const resourceMonitoringService = new ResourceMonitoringService();
const chatHistoryService = new ChatHistoryService();
const updateService = new UpdateService();
const agentFileService = new AgentFileService();
const toolPermissionService = new ToolPermissionService();
const systemMessageService = new SystemMessageService();
const gitAiIntegrationService = new GitAiIntegrationService();
// Reads no settings file under --safe (see safeMode.ts)
const hookService: HookService = new SafeModeHookService();

/** SessionStart hooks, once the hook service is ready. Never throws. */
async function fireSessionStartOnce(options: object): Promise<void> {
  const { resume, fork } = options as { resume?: boolean; fork?: string };
  try {
    const { runSessionStartHooks } = await import("../hooks/lifecycleHooks.js");
    const modelState = serviceContainer.getSync<ModelServiceState>(
      SERVICE_NAMES.MODEL,
    )?.value;
    await runSessionStartHooks(
      resume || fork ? "resume" : "startup",
      modelState?.model?.model,
    );
  } catch (error) {
    logger.debug("SessionStart hooks failed (ignored)", error as any);
  }
}

/**
 * Initialize all services and register them with the service container
 * Handles onboarding internally for TUI mode unless skipOnboarding is true
 */
export async function initializeServices(initOptions: ServiceInitOptions = {}) {
  logger.debug("Initializing service registry");

  const commandOptions = initOptions.options || {};

  // Configure beta tools based on command options
  if (commandOptions.betaSubagentTool) {
    setBetaSubagentToolEnabled(true);
  }
  // The flag is the only way to trust project hooks without recording it.
  // It is read before the hook service loads its settings.
  setTrustProjectHooksForRun(!!commandOptions.trustProjectHooks);
  if (commandOptions.trustProjectHooks) {
    auditTrust("hook-trust", "grant", process.cwd(), {
      source: "flag",
      confirmed: "flag",
    });
  }
  // Same for providers, models and other files the project ships. It does not
  // grant hook trust, and hook trust does not grant this.
  setProjectConfigTrustedForRun(!!commandOptions.trustProjectConfig);
  if (commandOptions.trustProjectConfig) {
    auditTrust("project-trust", "grant", process.cwd(), {
      source: "flag",
      confirmed: "flag",
    });
  }
  // Handle onboarding for TUI mode (headless: false) unless explicitly skipped
  if (!initOptions.headless && !initOptions.skipOnboarding) {
    await initializeWithOnboarding(null, commandOptions.config);
  }

  // Handle ANTHROPIC_API_KEY in headless mode when no config path is provided
  if (
    initOptions.headless &&
    !commandOptions.config &&
    process.env.ANTHROPIC_API_KEY
  ) {
    const { createOrUpdateConfig } = await import("../onboarding.js");
    const { env } = await import("../env.js");
    const path = await import("path");

    const CONFIG_PATH = path.join(env.continueHome, "config.yaml");
    await createOrUpdateConfig(process.env.ANTHROPIC_API_KEY);

    // Update options to use the created config
    commandOptions.config = CONFIG_PATH;
  }

  serviceContainer.register(
    SERVICE_NAMES.AUTH,
    async () => {
      return await authService.initialize();
    },
    [], // No dependencies
  );

  serviceContainer.register(
    SERVICE_NAMES.AGENT_FILE,
    async () => {
      const authState = await serviceContainer.get<AuthServiceState>(
        SERVICE_NAMES.AUTH,
      );

      return await agentFileService.initialize(commandOptions.agent, authState);
    },
    [SERVICE_NAMES.AUTH],
  );

  serviceContainer.register(
    SERVICE_NAMES.TOOL_PERMISSIONS,
    async () => {
      const [mcpState, agentFileState] = await Promise.all([
        serviceContainer.get<MCPServiceState>(SERVICE_NAMES.MCP),
        serviceContainer.get<AgentFileServiceState>(SERVICE_NAMES.AGENT_FILE),
      ]);

      // Initialize mode service with tool permission overrides
      if (initOptions.toolPermissionOverrides) {
        const overrides = { ...initOptions.toolPermissionOverrides };

        // Convert mode to boolean flags for ModeService
        const initArgs: InitializeToolServiceOverrides = {
          allow: overrides.allow,
          ask: overrides.ask,
          exclude: overrides.exclude,
          isHeadless: initOptions.headless,
          interactiveDefaults: overrides.interactiveDefaults,
        };
        // Only set the boolean flag that corresponds to the mode
        if (overrides.mode) {
          initArgs.mode = overrides.mode;
        }
        // If mode is "normal" or undefined, no flags are set
        return await toolPermissionService.initialize(
          initArgs,
          agentFileState,
          mcpState,
        );
      } else {
        // Even if no overrides, we need to initialize with defaults
        return await toolPermissionService.initialize(
          {
            isHeadless: initOptions.headless,
          },
          agentFileState,
          mcpState,
        );
      }
    },
    [SERVICE_NAMES.AGENT_FILE, SERVICE_NAMES.MCP],
  );

  // Initialize SystemMessageService with command options
  serviceContainer.register(
    SERVICE_NAMES.SYSTEM_MESSAGE,
    () =>
      systemMessageService.initialize({
        additionalRules: commandOptions.rule,
        format: (commandOptions as any).format, // format option from CLI
        headless: initOptions.headless,
      }),
    [SERVICE_NAMES.TOOL_PERMISSIONS],
  );

  serviceContainer.register(
    SERVICE_NAMES.UPDATE,
    () => updateService.initialize(),
    [], // No dependencies
  );

  serviceContainer.register(
    SERVICE_NAMES.CONFIG,
    async () => {
      const [authState, agentFileState] = await Promise.all([
        serviceContainer.get<AuthServiceState>(SERVICE_NAMES.AUTH),
        serviceContainer.get<AgentFileServiceState>(SERVICE_NAMES.AGENT_FILE),
      ]);

      // Use current config path from ConfigService state if available (for reloads),
      // otherwise use initial options.config (for first initialization)
      // IMPORTANT: Always prefer explicit --config flag over saved state
      const currentState = configService.getState();
      const configPath =
        commandOptions.config ||
        (currentState.configPath === undefined
          ? undefined
          : currentState.configPath);

      return await configService.initialize({
        authConfig: authState.authConfig,
        configPath,
        agentFileState,
        injectedConfigOptions: commandOptions,
        isHeadless: initOptions.headless,
      });
    },
    [SERVICE_NAMES.AUTH, SERVICE_NAMES.AGENT_FILE], // Dependencies
  );

  serviceContainer.register(
    SERVICE_NAMES.MODEL,
    async () => {
      const [configState, authState, agentFileState] = await Promise.all([
        serviceContainer.get<ConfigServiceState>(SERVICE_NAMES.CONFIG),
        serviceContainer.get<AuthServiceState>(SERVICE_NAMES.AUTH),
        serviceContainer.get<AgentFileServiceState>(SERVICE_NAMES.AGENT_FILE),
      ]);

      if (!configState.config) {
        throw new Error("Config not available");
      }

      return modelService.initialize(
        configState.config,
        authState.authConfig,
        agentFileState,
      );
    },
    [SERVICE_NAMES.CONFIG, SERVICE_NAMES.AUTH, SERVICE_NAMES.AGENT_FILE], // Depends on config, auth, and agentFile
  );

  serviceContainer.register(
    SERVICE_NAMES.MCP,
    async () => {
      const configState = await serviceContainer.get<ConfigServiceState>(
        SERVICE_NAMES.CONFIG,
      );

      if (!configState.config) {
        throw new Error("Config not available for MCP service");
      }
      return mcpService.initialize(
        configState.config,
        !!initOptions.options?.agent,
        initOptions.headless,
      );
    },
    [SERVICE_NAMES.CONFIG], // Depends on config
  );

  serviceContainer.register(
    SERVICE_NAMES.FILE_INDEX,
    () => fileIndexService.initialize(),
    [],
  );

  serviceContainer.register(
    SERVICE_NAMES.RESOURCE_MONITORING,
    () => resourceMonitoringService.initialize(),
    [],
  );

  serviceContainer.register(
    SERVICE_NAMES.CHAT_HISTORY,
    () => chatHistoryService.initialize(undefined, initOptions.headless),
    [], // No dependencies for now, but could depend on SESSION in future
  );

  serviceContainer.register(
    SERVICE_NAMES.GIT_AI_INTEGRATION,
    () => gitAiIntegrationService.initialize(),
    [], // No dependencies
  );

  serviceContainer.register(
    SERVICE_NAMES.QUIZ,
    () => quizService.initialize(),
    [], // No dependencies
  );

  serviceContainer.register(
    SERVICE_NAMES.HOOKS,
    () => hookService.initialize(),
    [], // No dependencies
  );

  // Eagerly initialize all services to ensure they're ready when needed
  // This avoids race conditions and "service not ready" errors
  await serviceContainer.initializeAll();
  await fireSessionStartOnce(commandOptions);

  logger.debug("Service registry initialized");
}

/**
 * Get a service from the container (async)
 */
export function getService<T>(serviceName: string): Promise<T> {
  return serviceContainer.get<T>(serviceName);
}

/**
 * Get service state synchronously
 */
export function getServiceSync<T>(serviceName: string) {
  return serviceContainer.getSync<T>(serviceName);
}

/**
 * Reload a specific service
 */
export function reloadService(serviceName: string) {
  return serviceContainer.reload(serviceName);
}

/**
 * Check if all core services are ready
 */
export function areServicesReady(): boolean {
  return Object.values(SERVICE_NAMES).every((name) =>
    serviceContainer.isReady(name),
  );
}

/**
 * Get service states for debugging
 */
export function getServiceStates() {
  return serviceContainer.getServiceStates();
}

/**
 * Direct access to service instances for complex operations
 */
export const services = {
  auth: authService,
  config: configService,
  model: modelService,
  mcp: mcpService,
  fileIndex: fileIndexService,
  resourceMonitoring: resourceMonitoringService,
  systemMessage: systemMessageService,
  chatHistory: chatHistoryService,
  updateService: updateService,
  agentFile: agentFileService,
  toolPermissions: toolPermissionService,
  gitAiIntegration: gitAiIntegrationService,
  backgroundJobs: backgroundJobService,
  quiz: quizService,
  hooks: hookService,
} as const;

export type ServicesType = typeof services;

/** The use a permission mode's turns are: Plan plans, the others act. */
export function modelUseForMode(mode: string): "plan" | "agent" {
  return mode === "plan" ? "plan" : "agent";
}

/**
 * Switch the chat model to the one `modeModels` gives a use (or to a Loop
 * item's own model, `itemModel`, when its to-do names one), and let the TUI
 * see it (the container's state is what the hooks read). Errors are logged:
 * a model that cannot be built must not stop the turn, which then goes to the
 * model already selected.
 */
export async function applyModelForUse(
  use: Parameters<ModelService["switchToModelForUse"]>[0],
  itemModel?: string,
): Promise<void> {
  try {
    if (await modelService.switchToModelForUse(use, itemModel)) {
      serviceContainer.set(SERVICE_NAMES.MODEL, modelService.getState());
    }
  } catch (error) {
    logger.error("Could not switch the model for this use", { use, error });
  }
}

function currentModelName(): string | undefined {
  const model = modelService.getState().model as { name?: string } | undefined;
  return model?.name;
}

/**
 * Switch to a chat model by its name, when it exists and is not current.
 * `why` is what the record of the model in use says (M7): by default, coming
 * back from a Loop item's own model.
 */
export async function applyModelNamed(
  name: string,
  why: ModelSwitchWhy = { reason: "restore" },
): Promise<void> {
  try {
    const index = modelService.getModelIndexByName(name);
    if (index === -1 || index === modelService.getCurrentModelIndex()) return;
    await modelService.switchModel(index, undefined, why);
    serviceContainer.set(SERVICE_NAMES.MODEL, modelService.getState());
  } catch (error) {
    logger.error("Could not switch back to the model", { name, error });
  }
}

/**
 * Switch the model for a Loop turn: the use's model (`modeModels`), or the
 * item's own (`itemModel`, TaskItem.model) when its to-do names one. Without
 * a configured model for the use, an own model switches away from the model
 * the person had selected; `modelBefore` is that model, left by an earlier
 * own-model item, and every turn comes back to it first. Returns the model
 * this turn leaves, for the next one to come back to, or undefined.
 */
export async function applyModelForLoopTurn(
  use: Parameters<ModelService["switchToModelForUse"]>[0],
  itemModel: string | undefined,
  modelBefore: string | undefined,
): Promise<string | undefined> {
  let configured = false;
  try {
    configured = modelService.modelIndexForUse(use) !== -1;
  } catch {
    // not initialized: nothing to switch
  }
  if (!configured && modelBefore) await applyModelNamed(modelBefore);
  const before = currentModelName();
  await applyModelForUse(use, itemModel);
  if (configured || !itemModel) return undefined;
  const after = currentModelName();
  return before && after && before !== after ? before : undefined;
}

/**
 * The `name` of the chat model a Loop item's worker runs on: the item's own
 * (TaskItem.model) when it is configured, else the loop's (`modeModels.loop`
 * with its fallback), else undefined, and the worker keeps its default.
 */
export function loopWorkerModelName(
  itemModel: string | undefined,
): string | undefined {
  try {
    const { index } = modelService.resolveModelForUse("loop", itemModel);
    if (index === -1) return undefined;
    return modelService.getAvailableChatModels()[index]?.name;
  } catch (error) {
    logger.error("Could not resolve the worker's model", { itemModel, error });
    return undefined;
  }
}

/**
 * What a Loop item's run records about its model when its to-do names one
 * (TaskItem.model): the model it goes to, and why its own was not used.
 * Undefined for an item that names none.
 */
export function loopItemModelRecord(
  itemModel: string | undefined,
): ReturnType<ModelService["resolveModelForUse"]>["record"] {
  if (!itemModel) return undefined;
  try {
    return modelService.resolveModelForUse("loop", itemModel).record;
  } catch (error) {
    logger.error("Could not resolve the item's model", { itemModel, error });
    return undefined;
  }
}

// Switching mode (Plan, normal, auto) switches the model as the IDE does
// (`modeModels.plan` / `.agent`). Loop turns refine this in loopSession.ts.
toolPermissionService.on("modeChanged", (mode: string) => {
  void applyModelForUse(modelUseForMode(mode));
});

// Export the service container for advanced usage
export { serviceContainer };

// Export service names and types
export type * from "./types.js";
export { SERVICE_NAMES } from "./types.js";
