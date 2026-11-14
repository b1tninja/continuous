import { AssistantUnrolled, ModelConfig } from "@continuedev/config-yaml";
import type { LoopItemModel, ModelUse } from "core/index.js";
import { resolveToolPermissions } from "core/tools/permissions/ruleTrust.js";
import { modeModelFor, modelForLoopItem } from "core/util/modelUse.js";
import { resolveTerminalSettings } from "core/util/terminalEnvironment.js";
import { readUserTerminalSettings } from "core/util/userTerminalSettings.js";
import { readUserToolPermissions } from "core/util/userToolPermissions.js";

import { AuthConfig, getModelName } from "../auth/workos.js";
import { createLlmApi, getLlmApi } from "../config.js";
import { logger } from "../util/logger.js";
import { userNotice } from "../util/userNotice.js";

import { BaseService, ServiceWithDependencies } from "./BaseService.js";
import { checkModeModelsForCli } from "./modeModelsCheck.js";
import { AgentFileServiceState, ModelServiceState } from "./types.js";

/**
 * Service for managing LLM and model state
 * Depends on auth config and assistant config
 */
export class ModelService
  extends BaseService<ModelServiceState>
  implements ServiceWithDependencies
{
  private availableModels: ModelConfig[] = [];
  private assistant: AssistantUnrolled | null = null;
  private authConfig: AuthConfig | null = null;
  /** The effort a use's `modeModels` entry last put on the current model. */
  private appliedEffort: string | undefined;

  constructor() {
    super("ModelService", {
      llmApi: null,
      model: null,
      assistant: null,
      authConfig: null,
    });
  }

  /**
   * Declare dependencies on other services
   */
  getDependencies(): string[] {
    return ["auth", "config", "agentFile"];
  }

  /**
   * Initialize the model service
   */
  async doInitialize(
    assistant: AssistantUnrolled,
    authConfig: AuthConfig,
    agentFileServiceState: AgentFileServiceState | undefined,
  ): Promise<ModelServiceState> {
    logger.debug("ModelService.doInitialize called", {
      hasAssistant: !!assistant,
      hasAuthConfig: !!authConfig,
      assistantModelsCount: assistant?.models?.length || 0,
    });

    // Only the person's own config.yaml may add allow rules; deny and ask
    // from the assistant are kept. The notices are logged, not fatal.
    const ruleTrust = resolveToolPermissions(
      readUserToolPermissions(),
      assistant.toolPermissions,
    );
    for (const notice of ruleTrust.notices) logger.warn(notice);
    if (ruleTrust.notices.length > 0) {
      assistant = { ...assistant, toolPermissions: ruleTrust.permissions };
    }
    this.assistant = assistant;
    // Only the person's own config.yaml may loosen what commands inherit.
    for (const notice of resolveTerminalSettings(
      readUserTerminalSettings(),
      assistant.terminal,
    ).notices) {
      logger.warn(notice);
    }
    this.authConfig = authConfig;
    reportModeModelsProblems(assistant);
    this.availableModels = (assistant.models?.filter(
      (model) =>
        model && (model.roles?.includes("chat") || model.roles === undefined),
    ) || []) as ModelConfig[];

    let preferredModelName: string | null | undefined = null;
    let modelSource = "default";

    // Priority = agentFile -> last selected model
    if (agentFileServiceState?.agentFileModel?.name) {
      preferredModelName = agentFileServiceState.agentFileModel?.name;
      modelSource = "agentFile";
    } else {
      const persistedName = getModelName(authConfig);
      if (persistedName) {
        preferredModelName = persistedName;
        modelSource = "persisted";
      }
    }

    // Try to use the preferred model (agent file or persisted)
    if (preferredModelName) {
      // During initialization, we need to check against availableModels directly
      const modelIndex = this.availableModels.findIndex((model) => {
        const name = (model as any).name || (model as any).model;
        return name === preferredModelName;
      });
      if (modelIndex === -1) {
        // Preferred model not found, use default model selection
        const [llmApi, model] = getLlmApi(assistant, authConfig);
        return {
          llmApi,
          model,
          assistant,
          authConfig,
        };
      } else {
        // Use the preferred model - but we need to handle initialization specially
        // During init, currentState isn't set yet, so switchModel would fail
        // Instead, we'll manually switch here
        const selectedModel = this.availableModels[modelIndex];
        logger.debug(`Using ${modelSource} model during initialization`, {
          modelIndex,
          provider: selectedModel.provider,
          name: (selectedModel as any).name || "unnamed",
          modelSource,
        });

        const llmApi = createLlmApi(selectedModel, authConfig);
        if (!llmApi) {
          throw new Error(`Failed to initialize LLM with ${modelSource} model`);
        }

        return {
          llmApi,
          model: selectedModel,
          assistant,
          authConfig,
        };
      }
    } else {
      // Use default model selection
      const [llmApi, model] = getLlmApi(assistant, authConfig);
      return {
        llmApi,
        model,
        assistant,
        authConfig,
      };
    }
  }

  /**
   * Override isReady to check for required state
   */
  override isReady(): boolean {
    return (
      super.isReady() &&
      this.currentState.llmApi !== null &&
      this.currentState.model !== null
    );
  }

  /** The active model's provider and API model id (not its display name). */
  getModelId(): { provider: string; model: string } | null {
    const m = this.currentState.model as { provider?: string; model?: string };
    return m?.provider && m?.model
      ? { provider: m.provider, model: m.model }
      : null;
  }

  /**
   * Get model information for display
   */
  getModelInfo(): { provider: string; name: string } | null {
    if (!this.currentState.model) {
      return null;
    }

    return {
      provider: this.currentState.model.provider,
      name: (this.currentState.model as any).name || "unnamed",
    };
  }

  /**
   * Get list of available chat models
   */
  getAvailableChatModels(): Array<{
    provider: string;
    name: string;
    index: number;
  }> {
    // Get assistant from state to ensure we have the latest data
    const { assistant } = this.getState();
    if (!assistant || !assistant.models) {
      return [];
    }

    // Filter for chat models
    const chatModels = (assistant.models.filter(
      (model) =>
        model && (model.roles?.includes("chat") || model.roles === undefined),
    ) || []) as ModelConfig[];

    return chatModels.map((model, index) => ({
      provider: model.provider,
      name: (model as any).name || (model as any).model || "unnamed",
      index,
    }));
  }

  /**
   * Switch to a different chat model by index
   */
  async switchModel(
    modelIndex: number,
    effort?: string,
  ): Promise<ModelServiceState> {
    // Get assistant and authConfig from state, but fall back to instance properties
    // This is needed during initialization when state isn't set yet
    const stateValues = this.getState();
    const assistant = stateValues.assistant || this.assistant;
    const authConfig = stateValues.authConfig || this.authConfig;

    // Debug logging to understand the state
    logger.debug("switchModel: Checking state", {
      hasStateAssistant: !!stateValues.assistant,
      hasStateAuthConfig: !!stateValues.authConfig,
      hasInstanceAssistant: !!this.assistant,
      hasInstanceAuthConfig: !!this.authConfig,
      isInitialized: this.isReady(),
      isReady: this.isReady(),
      modelIndex,
    });

    if (!assistant) {
      logger.error("switchModel: Missing assistant data", {
        assistant: !!assistant,
        authConfig: !!authConfig,
        stateKeys: Object.keys(stateValues),
        currentState: {
          hasLlmApi: !!stateValues.llmApi,
          hasModel: !!stateValues.model,
          hasAssistant: !!stateValues.assistant,
          hasAuthConfig: !!stateValues.authConfig,
        },
      });
      throw new Error("ModelService not initialized - assistant data missing");
    }

    // Get available models from assistant in state
    const availableModels = (assistant.models?.filter(
      (model) =>
        model && (model.roles?.includes("chat") || model.roles === undefined),
    ) || []) as ModelConfig[];

    if (modelIndex < 0 || modelIndex >= availableModels.length) {
      throw new Error(
        `Invalid model index: ${modelIndex}. Available models: 0-${availableModels.length - 1}`,
      );
    }

    const selectedModel = withReasoningEffort(
      availableModels[modelIndex],
      effort,
    );
    this.appliedEffort = effort;
    logger.debug("Switching to model", {
      modelIndex,
      provider: selectedModel.provider,
      name: (selectedModel as any).name || "unnamed",
    });

    try {
      const llmApi = createLlmApi(selectedModel, authConfig);

      if (!llmApi) {
        throw new Error("Failed to initialize LLM with selected model");
      }

      this.setState({
        llmApi,
        model: selectedModel,
        assistant,
        authConfig,
      });

      logger.debug("Model switched successfully", {
        modelProvider: selectedModel.provider,
        modelName: (selectedModel as any).name || "unnamed",
      });

      return this.getState();
    } catch (error: any) {
      logger.error("Failed to switch model:", error);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * The chat model `modeModels` gives a use (a mode, a Loop item or re-plan,
   * a subagent), as an index into the available models; -1 when the config
   * names none for it (and its fallback) or the name is not a chat model.
   */
  modelIndexForUse(use: ModelUse): number {
    const entry = this.entryForUse(use);
    return entry ? this.getModelIndexByName(entry.name) : -1;
  }

  /** The model name and reasoning effort `modeModels` gives a use. */
  private entryForUse(
    use: ModelUse,
  ): { name: string; effort?: string } | undefined {
    const assistant = this.getState().assistant ?? this.assistant;
    // The config names models (`model`, or the first of `models`); the shared
    // helper reads resolved titles, so each name stands in as its title
    const raw = (assistant?.modeModels ?? {}) as Record<
      string,
      | { model?: string; models?: string[]; reasoningEffort?: string }
      | undefined
    >;
    const named: Parameters<typeof modeModelFor>[0] = {};
    for (const [key, entry] of Object.entries(raw)) {
      const name = entry?.model ?? entry?.models?.[0];
      if (name) {
        named[key as ModelUse] = {
          title: name,
          reasoningEffort: entry?.reasoningEffort as any,
        };
      }
    }
    const entry = modeModelFor(named, use);
    return entry && { name: entry.title, effort: entry.reasoningEffort };
  }

  /**
   * The chat models as the shared resolver reads them: the config's `name`
   * as the title, with each one's index among the chat models.
   */
  private chatModelCandidates() {
    const assistant = this.getState().assistant ?? this.assistant;
    const available = (assistant?.models?.filter(
      (model) =>
        model && (model.roles?.includes("chat") || model.roles === undefined),
    ) ?? []) as ModelConfig[];
    return available.map((model, index) => ({
      title: String((model as any).name ?? model.model),
      model: String(model.model ?? ""),
      provider: model.provider,
      index,
    }));
  }

  /**
   * The model a use's turn goes to, as an index into the chat models (-1:
   * keep the current one). With `itemModel`, a Loop item's own model
   * (TaskItem.model): that model when it is configured, else the use's (or
   * the current one), with what the item's run records about it.
   */
  resolveModelForUse(
    use: ModelUse,
    itemModel?: string,
  ): { index: number; record?: LoopItemModel } {
    const useIndex = this.modelIndexForUse(use);
    if (!itemModel?.trim()) return { index: useIndex };
    const candidates = this.chatModelCandidates();
    const fallbackIndex =
      useIndex === -1 ? this.getCurrentModelIndex() : useIndex;
    const chosen = modelForLoopItem(
      { model: itemModel },
      candidates,
      candidates[fallbackIndex],
    );
    return { index: chosen.model?.index ?? -1, record: chosen.record };
  }

  /**
   * Switch to the model configured for a use, when there is one and it is not
   * the current model or effort; a Loop item's own model (`itemModel`) wins
   * over the use's, and the use's `reasoningEffort` reaches the server as
   * `reasoning_effort` (see `withReasoningEffort`). Returns true when
   * something changed. The choice is not persisted as the person's: it
   * follows the config, as a mode's model does in the IDE.
   */
  async switchToModelForUse(
    use: ModelUse,
    itemModel?: string,
  ): Promise<boolean> {
    const { index } = this.resolveModelForUse(use, itemModel);
    const effort = this.entryForUse(use)?.effort;
    if (index === -1) return false;
    if (
      index === this.getCurrentModelIndex() &&
      effort === this.appliedEffort
    ) {
      return false;
    }
    await this.switchModel(index, effort);
    logger.debug("Model switched for use", { use, itemModel, index, effort });
    return true;
  }

  /**
   * Get current model index
   */
  getCurrentModelIndex(): number {
    const state = this.getState();
    if (!state.model || !state.assistant) {
      return -1;
    }

    // Get available models from state
    const availableModels = (state.assistant.models?.filter(
      (model) =>
        model && (model.roles?.includes("chat") || model.roles === undefined),
    ) || []) as ModelConfig[];

    return availableModels.findIndex(
      (model) =>
        model.provider === state.model?.provider &&
        (model as any).name === (state.model as any).name,
    );
  }

  /**
   * Get model index by name and provider
   */
  getModelIndexByName(modelName: string, provider?: string): number {
    const state = this.getState();
    if (!state.assistant) {
      return -1;
    }

    // Get available models from state
    const availableModels = (state.assistant.models?.filter(
      (model) =>
        model && (model.roles?.includes("chat") || model.roles === undefined),
    ) || []) as ModelConfig[];

    return availableModels.findIndex((model) => {
      const name = (model as any).name || (model as any).model;
      const nameMatches = name === modelName;

      if (provider) {
        return nameMatches && model.provider === provider;
      }

      return nameMatches;
    });
  }

  static getSubagentModels(modelState: ModelServiceState) {
    if (!modelState.assistant) {
      return [];
    }
    const subagentModels = modelState.assistant.models
      ?.filter((model) => !!model)
      .filter((model) => !!model.name) // filter out models without a name
      .filter((model) => model.roles?.includes("subagent")) // filter with role subagent
      .filter((model) => !!model.chatOptions?.baseSystemMessage); // filter those with a system message

    if (!subagentModels) {
      return [];
    }
    return subagentModels?.map((model) => ({
      llmApi: createLlmApi(model, modelState.authConfig),
      model,
      assistant: modelState.assistant,
      authConfig: modelState.authConfig,
    }));
  }
}

/**
 * The model with a use's reasoning effort set as `reasoning_effort` in its
 * request body (`requestOptions.extraBodyProperties`, which the OpenAI adapter
 * sends). The use's setting wins over a catalog variant's. `off` and no effort
 * leave the model as configured: there is no portable "off" value, and the
 * token budgets the IDE maps efforts to do not apply to this field.
 */
export function withReasoningEffort(
  model: ModelConfig,
  effort: string | undefined,
): ModelConfig {
  if (!effort || effort === "off") return model;
  return {
    ...model,
    requestOptions: {
      ...model.requestOptions,
      extraBodyProperties: {
        ...model.requestOptions?.extraBodyProperties,
        reasoning_effort: effort,
      },
    },
  } as ModelConfig;
}

let configLoads = 0;

/**
 * The `modeModels` entries the CLI skips, and the efforts it does not send
 * (M8): one notice per config load, naming each entry and model. Without it
 * the CLI keeps the current model, or sends no effort, and says nothing.
 */
export function reportModeModelsProblems(assistant: AssistantUnrolled): void {
  configLoads++;
  const problems = checkModeModelsForCli(
    (assistant as { modeModels?: Record<string, any> }).modeModels,
    (assistant.models ?? []).filter((m): m is ModelConfig => !!m),
  );
  if (problems.length === 0) return;
  userNotice(
    ["The CLI skips part of modeModels in this config:", ...problems].join(
      "\n- ",
    ),
    `modeModels#${configLoads}`,
  );
}
