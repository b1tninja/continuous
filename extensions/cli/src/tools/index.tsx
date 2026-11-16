import { assignMcpToolNames } from "core/tools/mcpToolName.js";
import {
  stableToolOrder,
  stableToolOrderEnabled,
} from "core/tools/stableToolOrder.js";
// @ts-ignore
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";
import { ChatCompletionTool } from "openai/resources.mjs";

import { isModelCapable } from "src/utils/modelCapability.js";

import { loopItemRunning, loopRunGoing } from "../loop/loopSession.js";
import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import type {
  MCPServiceState,
  MCPTool,
  ModelServiceState,
} from "../services/types.js";
import { getSessionTaskPlan } from "../session.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import { logger } from "../util/logger.js";

import { ALL_BUILT_IN_TOOLS } from "./allBuiltIns.js";
import { askQuestionTool } from "./askQuestion.js";
import { checkBackgroundJobTool } from "./checkBackgroundJob.js";
import { editTool } from "./edit.js";
import { fetchTool } from "./fetch.js";
import { listFilesTool } from "./listFiles.js";
import { finishItemTool, holdQuestionTool, remindMeTool } from "./loopTools.js";
import { cliTrustedMcpServers } from "./mcpTrust.js";
import { multiEditTool } from "./multiEdit.js";
import { presentPlanTool } from "./presentPlan.js";
import { readFileTool } from "./readFile.js";
import { cliRoleRefusal, filterCliToolsForRole } from "./roleGate.js";
import { runTerminalCommandTool } from "./runTerminalCommand.js";
import { checkIfRipgrepIsInstalled, searchCodeTool } from "./searchCode.js";
import { applyCliToolSearch } from "./searchTools.js";
import { skillsTool } from "./skills.js";
import { subagentTool } from "./subagent.js";
import { taskListTool } from "./taskList.js";
import { isBetaSubagentToolEnabled } from "./toolsConfig.js";
import {
  type Tool,
  type ToolCall,
  type ToolParametersSchema,
  type ToolRunContext,
  ParameterSchema,
  PreprocessedToolCall,
} from "./types.js";
import { writeChecklistTool } from "./writeChecklist.js";
import { writeFileTool } from "./writeFile.js";

export type { Tool, ToolCall, ToolParametersSchema };

// Base tools that are always available
const BASE_BUILTIN_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  runTerminalCommandTool,
  fetchTool,
  taskListTool,
  checkBackgroundJobTool,
  askQuestionTool,
];

const BUILTIN_SEARCH_TOOLS: Tool[] = [searchCodeTool];

// Get all builtin tools including dynamic ones, with capability-based filtering
export async function getAllAvailableTools(
  isHeadless: boolean,
): Promise<Tool[]> {
  // Loop mode: while it runs an item, the item reports with FinishItem and
  // asks with HoldQuestion, and the loop owns the task list.
  const loopItem =
    loopItemRunning() && services.toolPermissions.getCurrentMode() !== "plan";
  const tools = loopItem
    ? [
        ...BASE_BUILTIN_TOOLS.filter((t) => t !== taskListTool),
        holdQuestionTool,
        remindMeTool,
        finishItemTool,
      ]
    : [...BASE_BUILTIN_TOOLS];
  // Plan mode does not offer the task list: PresentPlan's to-dos become the
  // list, and a model offered both resent the list instead of planning
  // (research-bedrock-families.md item 3). Outside plan mode the model acts
  // and gets the tool only to keep a list a plan left.
  const mode = services.toolPermissions.getCurrentMode();
  if (mode === "plan" || (!loopItem && !getSessionTaskPlan()?.items.length)) {
    const at = tools.indexOf(taskListTool);
    if (at !== -1) tools.splice(at, 1);
  }

  // A loop's questions go through HoldQuestion. Headless runs and `cn serve`
  // keep AskQuestion in plan mode only: there it does not wait (the question
  // is held in the inbox, src/util/pendingQuestions.ts) and a model that
  // asked in text would otherwise end its turn with no plan. While acting,
  // a headless model decides for itself and reports what it assumed.
  const headlessRun = isHeadless || services.toolPermissions.isHeadless();
  if (
    loopRunGoing() ||
    (headlessRun && services.toolPermissions.getCurrentMode() !== "plan")
  ) {
    tools.splice(tools.indexOf(askQuestionTool), 1);
  }

  const isRipgrepInstalled = await checkIfRipgrepIsInstalled();
  if (isRipgrepInstalled) {
    tools.push(...BUILTIN_SEARCH_TOOLS);
  }

  // If model is capable, exclude editTool in favor of multiEditTool
  const modelState = await serviceContainer.get<ModelServiceState>(
    SERVICE_NAMES.MODEL,
  );
  if (!modelState.model) {
    throw new Error("Model service is not initialized");
  }

  const { provider, name, model } = modelState.model;

  const isCapable = isModelCapable(provider, name, model);
  if (isCapable) {
    tools.push(multiEditTool);
  } else {
    tools.push(editTool);
    logger.debug(
      "Excluded Edit tool for capable model - MultiEdit will be used instead",
    );
  }

  logger.debug("Capability-based tool filtering", {
    provider,
    name,
    isCapable,
  });

  // Exit is not offered to the model. In headless runs and `cn serve` a model
  // that could not ask a question called it and killed the process; the
  // tool stays registered (allBuiltIns) for permission policies that name it.

  // Presenting a plan is how plan mode ends, so only plan mode offers it.
  if (services.toolPermissions.getCurrentMode() === "plan") {
    tools.push(presentPlanTool);
  }

  if (isBetaSubagentToolEnabled()) {
    tools.push(await subagentTool());
  }

  tools.push(await skillsTool());

  const mcpState = await serviceContainer.get<MCPServiceState>(
    SERVICE_NAMES.MCP,
  );
  // MCP servers connect in no fixed order: sorting by name keeps the tool
  // list, the head of every request, the same between requests (C64).
  // CONTINUE_STABLE_TOOL_ORDER=0 keeps the connection order.
  // Each MCP tool keeps its own name unless another server offers it or a
  // built-in has it, then it is qualified by its server: two tools never share
  // a name, so the call the person approves is the call that runs.
  const names = assignMcpToolNames(
    mcpState.tools.map((t) => ({
      serverName: t.serverName ?? "",
      toolName: t.name,
    })),
    {
      bare: true,
      reserved: new Set([
        ...tools.map((t) => t.name),
        ...ALL_BUILT_IN_TOOLS.map((t) => t.name),
        ...TOOL_ALIASES.map((t) => t.name),
      ]),
    },
  );
  const trusted = cliTrustedMcpServers();
  const mcpTools = mcpState.tools.map((t, i) => {
    const tool = convertMcpToolToContinueTool(t, names[i], trusted);
    // Not offered until the person approves it (TR4; the role table drops it)
    const pending = t.serverName
      ? services.mcp?.getPendingApproval?.(t.serverName, t.name)
      : undefined;
    return pending ? { ...tool, mcpPendingApproval: pending } : tool;
  });
  tools.push(
    ...(stableToolOrderEnabled(process.env.CONTINUE_STABLE_TOOL_ORDER)
      ? stableToolOrder(
          mcpTools,
          (t) => t.name,
          () => false,
        )
      : mcpTools),
  );

  // CONTINUE_TOOL_SEARCH=auto: defer MCP tools above a token budget. With it
  // unset this returns `tools` unchanged.
  // The role table: Plan mode offers only the tools its role may use, and
  // only the MCP tools the person marked read-only (roleTools.ts)
  return applyCliToolSearch(filterCliToolsForRole(mode, tools), {
    mode: mode === "plan" ? "plan" : "agent",
    family: name,
    history: services.chatHistory?.getHistory(),
  });
}

/**
 * Tools that are not offered to the model but still run when it calls them by
 * name: `Checklist` maps its markdown list onto `TaskList`, for prompts, rules
 * and resumed sessions that still name it.
 */
export const TOOL_ALIASES: Tool[] = [writeChecklistTool];

export function getToolDisplayName(toolName: string): string {
  const tool = ALL_BUILT_IN_TOOLS.find((t) => t.name === toolName);
  return tool?.displayName || toolName;
}

export function extractToolCalls(
  response: string,
): Array<{ name: string; arguments: Record<string, any> }> {
  const toolCallRegex = /<tool>([\s\S]*?)<\/tool>/g;
  const matches = [...response.matchAll(toolCallRegex)];

  const toolCalls = [];

  for (const match of matches) {
    try {
      const toolCallJson = JSON.parse(match[1]);
      if (toolCallJson.name && toolCallJson.arguments) {
        toolCalls.push({
          name: toolCallJson.name,
          arguments: toolCallJson.arguments,
        });
      }
    } catch {
      logger.error("Failed to parse tool call:", { toolCall: match[1] });
    }
  }

  return toolCalls;
}

export function convertToolToChatCompletionTool(
  tool: Tool,
): ChatCompletionTool {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        required: tool.parameters.required,
        properties: tool.parameters.properties,
      },
    },
  };
}

export function convertMcpToolToContinueTool(
  mcpTool: MCPTool & { serverName?: string },
  name: string = mcpTool.name,
  trustedServers: ReadonlySet<string> = new Set(),
): Tool {
  const serverName = mcpTool.serverName;
  return {
    name,
    ...(serverName ? { mcpServer: serverName, mcpToolName: mcpTool.name } : {}),
    displayName: serverName ? `${serverName}: ${mcpTool.name}` : mcpTool.name,
    description: mcpTool.description ?? "",
    parameters: {
      type: "object",
      properties: (mcpTool.inputSchema.properties ?? {}) as Record<
        string,
        ParameterSchema
      >,
      required: mcpTool.inputSchema.required,
    },
    // A server's own word that the tool changes nothing, believed only for a
    // server the person trusts (a hint from any other server is ignored)
    readonly:
      mcpTool.annotations?.readOnlyHint === true &&
      !!serverName &&
      trustedServers.has(serverName)
        ? true
        : undefined,
    isBuiltIn: false,
    run: async (args: any) => {
      // Runs on the server this tool was listed under, never on whichever
      // server answers to the name
      const result = serverName
        ? await services.mcp?.runTool(mcpTool.name, args, serverName)
        : await services.mcp?.runTool(mcpTool.name, args);
      return JSON.stringify(result?.content) ?? "";
    },
  };
}

export async function executeToolCall(
  toolCall: PreprocessedToolCall,
  options: Omit<ToolRunContext, "toolCallId"> = { parallelToolCallCount: 1 },
): Promise<string> {
  const startTime = Date.now();

  // The role table again, at execution: a call to a tool the mode's role may
  // not use is refused however it got here
  const roleRefusal = cliRoleRefusal(
    services.toolPermissions?.getCurrentMode?.(),
    toolCall.tool,
  );
  if (roleRefusal) {
    telemetryService.logToolResult({
      toolName: toolCall.name,
      success: false,
      durationMs: 0,
      error: roleRefusal,
      errorReason: ContinueErrorReason.Unspecified,
      toolParameters: JSON.stringify(toolCall.arguments),
    });
    throw new Error(roleRefusal);
  }

  try {
    logger.debug("Executing tool", {
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      parallelToolCallCount: options.parallelToolCallCount,
    });

    // Track edits if Git AI is enabled (no-op if not enabled)
    await services.gitAiIntegration.trackToolUse(toolCall, "PreToolUse");

    const context: ToolRunContext = {
      toolCallId: toolCall.id,
      parallelToolCallCount: options.parallelToolCallCount,
      abortSignal: options.abortSignal,
      onToolPermissionRequest: options.onToolPermissionRequest,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };

    // IMPORTANT: if preprocessed args are present, uses preprocessed args instead of original args
    // Preprocessed arg names may be different
    const result = await toolCall.tool.run(
      toolCall.preprocessResult?.args ?? toolCall.arguments,
      context,
    );
    const duration = Date.now() - startTime;

    // Track edits if Git AI is enabled (no-op if not enabled)
    await services.gitAiIntegration.trackToolUse(toolCall, "PostToolUse");

    telemetryService.logToolResult({
      toolName: toolCall.name,
      success: true,
      durationMs: duration,
      toolParameters: JSON.stringify(toolCall.arguments),
    });
    logger.debug("Tool execution completed", {
      toolName: toolCall.name,
      resultLength: result?.length || 0,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorReason =
      error instanceof ContinueError
        ? error.reason
        : ContinueErrorReason.Unknown;

    telemetryService.logToolResult({
      toolName: toolCall.name,
      success: false,
      durationMs: duration,
      error: errorMessage,
      errorReason,
      toolParameters: JSON.stringify(toolCall.arguments),
    });
    throw error;
  }
}

// Only checks top-level required
export function validateToolCallArgsPresent(toolCall: ToolCall, tool: Tool) {
  const requiredParams = tool.parameters.required ?? [];
  for (const paramName of requiredParams) {
    if (
      toolCall.arguments[paramName] === undefined ||
      toolCall.arguments[paramName] === null
    ) {
      throw new Error(
        `Required parameter "${paramName}" missing for tool "${toolCall.name}"`,
      );
    }
  }
}
