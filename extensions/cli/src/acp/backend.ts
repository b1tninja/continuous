import type { ChatHistoryItem } from "core/index.js";

import { processCommandFlags } from "../flags/flagProcessor.js";
import { toolPermissionManager } from "../permissions/permissionManager.js";
import {
  getService,
  initializeServices,
  SERVICE_NAMES,
  services,
} from "../services/index.js";
import type {
  ConfigServiceState,
  ModelServiceState,
} from "../services/types.js";
import {
  createSession,
  isSessionInWorkspace,
  listSavedSessions,
  openSavedSession,
  sessionExists,
} from "../session.js";
import { streamChatResponse } from "../stream/streamChatResponse.js";
import type { StreamCallbacks } from "../stream/streamChatResponse.types.js";
import { constructSystemMessage } from "../systemMessage.js";

import type { AcpBackend } from "./agent.js";

/**
 * The real backend: the CLI's services and its streaming turn loop, set up
 * as `cn serve` sets them up, with one difference that matters. Services are
 * not started headless, so a call the policy would ask about reaches
 * `onToolPermissionRequest` (and from there the editor) instead of being
 * refused outright. With no callback set the engine still refuses.
 */
export function createCliBackend(options: any): AcpBackend {
  /** The services of a session rooted at `cwd`, as `cn serve` starts them. */
  async function startServices(cwd: string) {
    // The tools resolve paths against the process working directory
    process.chdir(cwd);
    const { permissionOverrides } = processCommandFlags(options);
    await initializeServices({
      options,
      toolPermissionOverrides: permissionOverrides,
      headless: false,
      skipOnboarding: true,
    });
    const [config, model] = await Promise.all([
      getService<ConfigServiceState>(SERVICE_NAMES.CONFIG),
      getService<ModelServiceState>(SERVICE_NAMES.MODEL),
    ]);
    if (!config.config || !model.llmApi || !model.model) {
      throw new Error("Failed to initialize required services");
    }
    return model.model;
  }

  return {
    async newSession(cwd) {
      const model = await startServices(cwd);
      const systemMessage = await constructSystemMessage(
        services.toolPermissions.getState().currentMode,
        options.rule,
        undefined,
        false,
        model.model,
      );
      const history: ChatHistoryItem[] = systemMessage
        ? [
            {
              message: { role: "system" as const, content: systemMessage },
              contextItems: [],
            },
          ]
        : [];
      const session = createSession(history);
      await services.chatHistory.initialize(session, false);
      return session.sessionId;
    },

    async listSessions() {
      return listSavedSessions();
    },

    inWorkspace(workspaceDirectory, cwd) {
      return isSessionInWorkspace(workspaceDirectory, cwd);
    },

    async openSession(sessionId, cwd) {
      // An unknown id is answered before any service starts
      if (!sessionExists(sessionId)) return undefined;
      await startServices(cwd);
      const session = openSavedSession(sessionId);
      if (!session) return undefined;
      // No system message is stored with a session: each request builds the
      // current one (streamChatResponse), as it does after --resume
      await services.chatHistory.initialize(session, false);
      return session.history;
    },

    async runTurn(_id, text, callbacks: StreamCallbacks, signal) {
      const model = services.model.getState();
      if (!model.llmApi || !model.model) {
        throw new Error("The model service is not ready");
      }
      services.chatHistory.addUserMessage(text);
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort);
      try {
        await streamChatResponse(
          services.chatHistory.getHistory(),
          model.model,
          model.llmApi,
          abort,
          callbacks,
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    resolvePermission(requestId, approved) {
      if (approved) toolPermissionManager.approveRequest(requestId);
      else toolPermissionManager.rejectRequest(requestId);
    },
  };
}
