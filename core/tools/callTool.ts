import type { RepairNote } from "@continuedev/openai-adapters";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ContextItem, McpUiState, Tool, ToolCall, ToolExtras } from "..";
import { MCPManagerSingleton } from "../context/mcp/MCPManagerSingleton";
import { mcpToolCallTimeout } from "../context/mcp/mcpTimeouts";
import { ContinueError, ContinueErrorReason } from "../util/errors";
import { canParseUrl } from "../util/url";
import { BuiltInToolNames } from "./builtIn";

import { CommandOutputToolNames } from "./definitions/commandOutput";
import { codebaseToolImpl } from "./implementations/codebaseTool";
import {
  readCommandOutputImpl,
  stopCommandImpl,
} from "./implementations/commandOutputTools";
import { createNewFileImpl } from "./implementations/createNewFile";
import { createRuleBlockImpl } from "./implementations/createRuleBlock";
import {
  multiEditImpl,
  singleFindAndReplaceImpl,
} from "./implementations/exactEdits";
import { fetchUrlContentImpl } from "./implementations/fetchUrlContent";
import { fileGlobSearchImpl } from "./implementations/globSearch";
import { grepSearchImpl } from "./implementations/grepSearch";
import { lsToolImpl } from "./implementations/lsTool";
import { readCurrentlyOpenFileImpl } from "./implementations/readCurrentlyOpenFile";
import { readFileImpl } from "./implementations/readFile";

import { codeNavigationImpl } from "./implementations/codeNavigation";
import { readFileRangeImpl } from "./implementations/readFileRange";
import { readSkillImpl } from "./implementations/readSkill";
import { recallMaskedResultImpl } from "./implementations/recallMaskedResult";
import { requestRuleImpl } from "./implementations/requestRule";
import { runTerminalCommandImpl } from "./implementations/runTerminalCommand";
import { searchToolsImpl } from "./implementations/searchTools";
import { searchWebImpl } from "./implementations/searchWeb";
import { viewDiffImpl } from "./implementations/viewDiff";
import { viewRepoMapImpl } from "./implementations/viewRepoMap";
import { viewSubdirectoryImpl } from "./implementations/viewSubdirectory";
import {
  coerceArgsToSchema,
  coerceStringArgsToSchema,
  safeParseToolCallArgs,
} from "./parseArgs";
import { noteCoreToolResult } from "./taintResult";

async function callHttpTool(
  url: string,
  args: any,
  extras: ToolExtras,
): Promise<ContextItem[]> {
  const response = await extras.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      arguments: args,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to call tool at ${url}:\n${JSON.stringify(data)}`);
  }

  return data.output;
}

export function encodeMCPToolUri(mcpId: string, toolName: string): string {
  return `mcp://${encodeURIComponent(mcpId)}/${encodeURIComponent(toolName)}`;
}

export function decodeMCPToolUri(uri: string): [string, string] | null {
  const url = new URL(uri);
  if (url.protocol !== "mcp:") {
    return null;
  }
  return [
    decodeURIComponent(url.hostname),
    decodeURIComponent(url.pathname).slice(1), // to remove leading '/'
  ];
}

async function callToolFromUri(
  uri: string,
  args: any,
  extras: ToolExtras,
): Promise<{
  contextItems: ContextItem[];
  mcpUiState?: McpUiState;
}> {
  const parseable = canParseUrl(uri);
  if (!parseable) {
    throw new Error(`Invalid URI: ${uri}`);
  }
  const parsedUri = new URL(uri);

  switch (parsedUri?.protocol) {
    case "http:":
    case "https:":
      return {
        contextItems: await callHttpTool(uri, args, extras),
      };
    case "mcp:":
      const decoded = decodeMCPToolUri(uri);
      if (!decoded) {
        throw new Error(`Invalid MCP tool URI: ${uri}`);
      }
      const [mcpId, toolName] = decoded;
      const client = MCPManagerSingleton.getInstance().getConnection(mcpId);

      if (!client) {
        throw new Error("MCP connection not found");
      }
      const coercedArgs = coerceArgsToSchema(
        args,
        extras.tool?.function?.parameters,
      );
      const response = await client.client.callTool(
        {
          name: toolName,
          arguments: coercedArgs,
        },
        CallToolResultSchema,
        { timeout: mcpToolCallTimeout(client.options) },
      );

      // It ran, so it was approved: pin its definition (mcpToolPins.ts)
      await client.recordToolUse(toolName);

      if (response.isError === true) {
        throw new Error(JSON.stringify(response.content));
      }

      let mcpUiState: McpUiState | undefined = undefined;
      const uiResourceUri =
        extras.tool?.mcpMeta?.ui?.resourceUri ||
        extras.tool?.mcpMeta?.["ui/resourceUri"];
      if (uiResourceUri) {
        try {
          const resource = await client.getResource(uiResourceUri);
          // only single content supported for UI for now
          if (resource.contents?.length) {
            for (const c of resource.contents) {
              if ("text" in c && typeof c.text === "string") {
                mcpUiState = {
                  content: c,
                };
              }
            }
          }

          if (!mcpUiState) {
            console.error(
              "Invalid MCP UI resource content",
              JSON.stringify(resource),
            );
          }
        } catch (e) {
          console.error("Error fetching MCP UI resource", e);
        }
      }

      const contextItems: ContextItem[] = [];
      (response.content as any).forEach((item: any) => {
        if (item.type === "text") {
          contextItems.push({
            name: extras.tool.displayTitle,
            description: "Tool output",
            content: item.text,
            icon: extras.tool.faviconUrl,
          });
        } else if (item.type === "resource") {
          // TODO resource change subscribers https://modelcontextprotocol.io/docs/concepts/resources
          if (item.resource?.blob) {
            contextItems.push({
              name: extras.tool.displayTitle,
              description: "MCP Item Error",
              content:
                "Error: tool call received unsupported blob resource item",
              icon: extras.tool.faviconUrl,
            });
          }
          // TODO account for mimetype? // const mimeType = item.resource.mimeType
          // const uri = item.resource.uri;
          contextItems.push({
            name: extras.tool.displayTitle,
            description: "Tool output",
            content: item.resource.text,
            icon: extras.tool.faviconUrl,
          });
        } else {
          contextItems.push({
            name: extras.tool.displayTitle,
            description: "MCP Item Error",
            content: `Error: tool call received unsupported item of type "${item.type}"`,
            icon: extras.tool.faviconUrl,
          });
        }
      });
      return { contextItems, mcpUiState };
    default:
      throw new Error(`Unsupported protocol: ${parsedUri?.protocol}`);
  }
}

export async function callBuiltInTool(
  functionName: string,
  args: any,
  extras: ToolExtras,
): Promise<ContextItem[]> {
  switch (functionName) {
    case BuiltInToolNames.ReadFile:
      return await readFileImpl(args, extras);
    case BuiltInToolNames.ReadFileRange:
      return await readFileRangeImpl(args, extras);
    case BuiltInToolNames.CodeNavigation:
      return await codeNavigationImpl(args, extras);
    case BuiltInToolNames.CreateNewFile:
      return await createNewFileImpl(args, extras);
    case BuiltInToolNames.GrepSearch:
      return await grepSearchImpl(args, extras);
    case BuiltInToolNames.FileGlobSearch:
      return await fileGlobSearchImpl(args, extras);
    case BuiltInToolNames.RunTerminalCommand:
      return await runTerminalCommandImpl(args, extras);
    case CommandOutputToolNames.ReadCommandOutput:
      return await readCommandOutputImpl(args, extras);
    case CommandOutputToolNames.StopCommand:
      return await stopCommandImpl(args, extras);
    case BuiltInToolNames.SearchWeb:
      return await searchWebImpl(args, extras);
    case BuiltInToolNames.FetchUrlContent:
      return await fetchUrlContentImpl(args, extras);
    case BuiltInToolNames.ViewDiff:
      return await viewDiffImpl(args, extras);
    case BuiltInToolNames.LSTool:
      return await lsToolImpl(args, extras);
    case BuiltInToolNames.ReadCurrentlyOpenFile:
      return await readCurrentlyOpenFileImpl(args, extras);
    case BuiltInToolNames.CreateRuleBlock:
      return await createRuleBlockImpl(args, extras);
    case BuiltInToolNames.RequestRule:
      return await requestRuleImpl(args, extras);
    case BuiltInToolNames.CodebaseTool:
      return await codebaseToolImpl(args, extras);
    case BuiltInToolNames.RecallMaskedResult:
      return await recallMaskedResultImpl(args, extras);
    case BuiltInToolNames.SearchTools:
      return await searchToolsImpl(args, extras);
    case BuiltInToolNames.ReadSkill:
      return await readSkillImpl(args, extras);
    case BuiltInToolNames.ViewRepoMap:
      return await viewRepoMapImpl(args, extras);
    case BuiltInToolNames.ViewSubdirectory:
      return await viewSubdirectoryImpl(args, extras);
    // Client tools in the person's checkout (diff review); core applies them
    // only for a call with a working directory of its own (a Loop worker)
    case BuiltInToolNames.SingleFindAndReplace:
      return await singleFindAndReplaceImpl(args, extras);
    case BuiltInToolNames.MultiEdit:
      return await multiEditImpl(args, extras);
    default:
      throw new Error(`Tool "${functionName}" not found`);
  }
}

// Handles calls for core/non-client tools
// Returns an error context item if the tool call fails
// Note: Edit tool is handled on client
export async function callTool(
  tool: Tool,
  toolCall: ToolCall,
  extras: ToolExtras,
): Promise<{
  contextItems: ContextItem[];
  errorMessage: string | undefined;
  errorReason?: ContinueErrorReason;
  mcpUiState?: McpUiState;
  /** Strings read as the value the tool's schema declares, when any were */
  argRepairs?: RepairNote[];
}> {
  let argRepairs: RepairNote[] | undefined;
  try {
    // Some models send an array, boolean or number as a string
    const { args, repairs } = coerceStringArgsToSchema(
      safeParseToolCallArgs(toolCall),
      tool.function.parameters,
    );
    if (repairs.length > 0) {
      argRepairs = repairs;
    }
    const { contextItems, mcpUiState } = tool.uri
      ? await callToolFromUri(tool.uri, args, extras)
      : {
          contextItems: await callBuiltInTool(tool.function.name, args, extras),
        };
    await noteCoreToolResult(tool, toolCall.id, args, extras);
    if (tool.faviconUrl) {
      contextItems.forEach((item) => {
        item.icon = tool.faviconUrl;
      });
    }

    return {
      contextItems,
      errorMessage: undefined,
      mcpUiState,
      ...(argRepairs ? { argRepairs } : {}),
    };
  } catch (e) {
    let errorMessage = `${e}`;
    let errorReason: ContinueErrorReason | undefined;

    if (e instanceof ContinueError) {
      errorMessage = e.message;
      errorReason = e.reason;
    } else if (e instanceof Error) {
      errorMessage = e.message;
    }

    return {
      contextItems: [],
      errorMessage,
      errorReason,
      ...(argRepairs ? { argRepairs } : {}),
    };
  }
}
