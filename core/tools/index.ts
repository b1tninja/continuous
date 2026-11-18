import { ConfigDependentToolParams, Tool } from "..";
import { isWebSearchConfigured } from "./webSearch/registry";
import { isRecommendedAgentModel } from "../llm/toolSupport";
import { historyAgeingEnabled } from "../util/contextAgeing";
import * as toolDefinitions from "./definitions";

// I'm writing these as functions because we've messed up 3 TIMES by pushing to const, causing duplicate tool definitions on subsequent config loads.
export const getBaseToolDefinitions = () => [
  toolDefinitions.readFileTool,
  toolDefinitions.createNewFileTool,
  toolDefinitions.runTerminalCommandTool,
  toolDefinitions.readCommandOutputTool,
  toolDefinitions.stopCommandTool,
  toolDefinitions.globSearchTool,
  toolDefinitions.viewDiffTool,
  toolDefinitions.readCurrentlyOpenFileTool,
  toolDefinitions.lsTool,
  toolDefinitions.createRuleBlock,
  toolDefinitions.fetchUrlContentTool,
  toolDefinitions.taskListTool,
  toolDefinitions.presentPlanTool,
  toolDefinitions.holdQuestionTool,
  toolDefinitions.remindMeTool,
  toolDefinitions.finishItemTool,
];

export const getConfigDependentToolDefinitions = async (
  params: ConfigDependentToolParams,
): Promise<Tool[]> => {
  const { modelName, enableExperimentalTools, isRemote } = params;
  const tools: Tool[] = [];

  tools.push(await toolDefinitions.requestRuleTool(params));
  tools.push(await toolDefinitions.readSkillTool(params));
  tools.push(await toolDefinitions.subagentTool(params));

  // Only once the person has picked a search provider in web.search of their
  // own config.yaml; there is no default provider, so by default the tool
  // does not exist (core/tools/webSearch/registry.ts).
  if (isWebSearchConfigured()) {
    tools.push(toolDefinitions.searchWebTool);
  }

  // Off by default: the tool list is part of every request's cached prefix
  if (historyAgeingEnabled()) {
    tools.push(toolDefinitions.recallMaskedResultTool);
  }

  // Off by default. When on, the request builder keeps or drops it with the
  // MCP budget (toolSearch.ts); it is never in the list when off.
  if (params.toolSearch === "auto") {
    tools.push(toolDefinitions.searchToolsTool);
  }

  if (enableExperimentalTools) {
    tools.push(
      toolDefinitions.viewRepoMapTool,
      toolDefinitions.viewSubdirectoryTool,
      toolDefinitions.codebaseTool,
      toolDefinitions.readFileRangeTool,
    );
  }

  if (modelName && isRecommendedAgentModel(modelName)) {
    tools.push(toolDefinitions.multiEditTool);
  } else {
    tools.push(toolDefinitions.editFileTool);
    tools.push(toolDefinitions.singleFindAndReplaceTool);
  }

  // Language-server navigation: only IDEs that answer these requests
  const ideType = await params.ide
    ?.getIdeInfo?.()
    .then((info) => info.ideType)
    .catch(() => undefined);
  if (ideType === "vscode") {
    tools.push(toolDefinitions.codeNavigationTool);
  }

  // missing support for remote os calls: https://github.com/microsoft/vscode/issues/252269
  if (!isRemote) {
    tools.push(toolDefinitions.grepSearchTool);
  }

  return tools;
};

export function serializeTool(tool: Tool) {
  const { preprocessArgs, evaluateToolCallPolicy, ...rest } = tool;
  return rest;
}
