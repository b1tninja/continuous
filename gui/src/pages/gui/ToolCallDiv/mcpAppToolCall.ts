import { maskArgsForDisplay } from "core/tools/permissions/displayMask";
import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { Tool, ToolCallState } from "core";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import {
  getToolNameFromMCPServer,
  isBuiltInToolName,
} from "core/tools/mcpToolName";
import { generateOpenAIToolCallId } from "core/tools/systemMessageTools/systemToolUtils";
import { renderContextItems } from "core/util/messageContent";

import { IIdeMessenger } from "../../../context/IdeMessenger";
import { selectSelectedChatModel } from "../../../redux/slices/configSlice";
import {
  selectApprovalSettings,
  selectAutoApproval,
} from "../../../redux/selectors/selectAutoApproval";
import { selectActiveTools } from "../../../redux/selectors/selectActiveTools";
import {
  submitEditorAndInitAtIndex,
  updateHistoryItemAtIndex,
} from "../../../redux/slices/sessionSlice";
import {
  AppThunkDispatch,
  RootState,
  ThunkApiType,
} from "../../../redux/store";
import {
  buildReviewHistory,
  evaluateToolPolicies,
} from "../../../redux/thunks/evaluateToolPolicies";
import { streamNormalInput } from "../../../redux/thunks/streamNormalInput";
import { streamThunkWrapper } from "../../../redux/thunks/streamThunkWrapper";
import {
  MCP_APP_MESSAGE_SOURCE,
  mcpAppServerLabel,
  mcpAppTurnContent,
} from "./mcpAppTurnContent";

export interface McpAppApproval {
  /** The tool's display title. */
  title: string;
  /** Why the call is waiting, when a rule or protected path says so. */
  note?: string;
  /** The arguments, shortened, so the person can see the call. */
  detail?: string;
}

export interface McpAppToolText {
  type: "text";
  text: string;
}

export type McpAppToolResult =
  { ok: true; content: McpAppToolText[] } | { ok: false; error: string };

/**
 * The tool an MCP app may call: one of its own server's tools. A built-in
 * name, or another server's tool, is not returned.
 */
export function findMcpAppTool(
  tools: Tool[],
  serverName: string,
  requestedName: string,
): Tool | undefined {
  if (!serverName || !requestedName) return undefined;
  const fullName = getToolNameFromMCPServer(serverName, requestedName);
  if (isBuiltInToolName(fullName)) return undefined;
  return tools.find(
    (tool) =>
      tool.function.name === fullName &&
      !isBuiltInToolName(tool.function.name) &&
      tool.group === serverName &&
      tool.group !== BUILT_IN_GROUP_NAME &&
      !!tool.uri?.startsWith("mcp:"),
  );
}

function snapshotArgs(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
      return undefined;
    }
    return cloned as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function argPreview(args: Record<string, unknown>): string | undefined {
  const text = JSON.stringify(maskArgsForDisplay(args));
  if (!text || text === "{}") return undefined;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function sameTool(a: Tool, b: Tool): boolean {
  return (
    a.function.name === b.function.name &&
    a.group === b.group &&
    a.uri === b.uri
  );
}

/**
 * Run one tool call from an MCP app through the same policy check as a call
 * the model made. A call that must be approved waits for `approve`. A refusal
 * does not call the tool.
 */
export async function runMcpAppToolCall(input: {
  ideMessenger: IIdeMessenger;
  dispatch: AppThunkDispatch;
  state: RootState;
  serverName: string;
  requestedName: string;
  toolArguments: unknown;
  approve: (approval: McpAppApproval) => Promise<boolean>;
}): Promise<McpAppToolResult> {
  const tool = findMcpAppTool(
    input.state.config.config.tools,
    input.serverName,
    input.requestedName,
  );
  if (!tool) {
    return { ok: false, error: "Not this server's tool." };
  }

  const active = selectActiveTools(input.state);
  if (!active.some((candidate) => sameTool(candidate, tool))) {
    return { ok: false, error: "This tool is turned off." };
  }

  const parsedArgs = snapshotArgs(input.toolArguments);
  if (!parsedArgs) {
    return { ok: false, error: "Could not read the tool arguments." };
  }

  const toolCallId = generateOpenAIToolCallId();
  const toolCallState: ToolCallState = {
    toolCallId,
    toolCall: {
      id: toolCallId,
      type: "function",
      function: {
        name: tool.function.name,
        arguments: JSON.stringify(parsedArgs),
      },
    },
    parsedArgs,
    status: "generated",
    tool,
  };

  const pre = await input.ideMessenger.request("tools/preprocessArgs", {
    toolName: tool.function.name,
    args: parsedArgs,
  });
  if (pre.status === "error") {
    return {
      ok: false,
      error: pre.error || "Could not prepare this tool call.",
    };
  }
  if (pre.content.errorMessage || pre.content.errorReason) {
    return {
      ok: false,
      error: pre.content.errorMessage || "Could not prepare this tool call.",
    };
  }
  if (pre.content.preprocessedArgs) {
    toolCallState.processedArgs = pre.content.preprocessedArgs;
  }

  const auto = selectAutoApproval(input.state);
  const [policy] = await evaluateToolPolicies(
    input.dispatch,
    input.ideMessenger,
    active,
    [toolCallState],
    input.state.ui.toolSettings,
    auto.active
      ? {
          sessionId: input.state.session.id,
          history: buildReviewHistory(input.state.session.history),
          onceGrants: input.state.blockedCalls.grants,
        }
      : undefined,
    selectApprovalSettings(input.state),
    input.state.session.mode,
  );

  if (!policy || policy.policy === "disabled") {
    return {
      ok: false,
      error: policy?.reason
        ? `Refused: ${policy.reason}`
        : "This tool call was refused.",
    };
  }

  if (policy.policy === "allowedWithPermission") {
    const detail = argPreview(parsedArgs);
    const allowed = await input.approve({
      title: tool.displayTitle || tool.function.name,
      ...(policy.reason ? { note: policy.reason } : {}),
      ...(detail ? { detail } : {}),
    });
    if (!allowed) {
      return { ok: false, error: "The person rejected this tool call." };
    }
  }

  const output = await input.ideMessenger.request("tools/call", {
    toolCall: toolCallState.toolCall,
  });
  if (output.status === "error") {
    return { ok: false, error: output.error || "The tool call failed." };
  }
  if (output.content.errorMessage) {
    return { ok: false, error: output.content.errorMessage };
  }
  return {
    ok: true,
    content: (output.content.contextItems ?? []).map((item) => ({
      type: "text" as const,
      text: renderContextItems([item]),
    })),
  };
}

function editorStateFor(text: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

/**
 * Start an agent turn from text an MCP app sent. The history item is marked
 * as the app's, and the text the model sees says the person did not write it.
 * A turn already in progress is left alone.
 */
export const sendMcpAppTurn = createAsyncThunk<
  void,
  { serverName: string; text: string },
  ThunkApiType
>(
  "chat/sendMcpAppTurn",
  async ({ serverName, text }, { dispatch, getState }) => {
    if (!text.trim()) return;
    await dispatch(
      streamThunkWrapper(async () => {
        const state = getState();
        if (state.session.isStreaming) return;
        if (!selectSelectedChatModel(state)) {
          throw new Error("No chat model selected");
        }
        const content = mcpAppTurnContent(serverName, text);
        const label = mcpAppServerLabel(serverName);
        const index = state.session.history.length;
        dispatch(
          submitEditorAndInitAtIndex({
            index,
            editorState: editorStateFor(content),
          }),
        );
        const created = getState().session.history[index]?.message;
        dispatch(
          updateHistoryItemAtIndex({
            index,
            updates: {
              message: {
                role: "user",
                content,
                id: created && "id" in created ? created.id : "",
                metadata: {
                  source: MCP_APP_MESSAGE_SOURCE,
                  mcpServerName: label,
                },
              },
              contextItems: [],
            },
          }),
        );
        unwrapResult(await dispatch(streamNormalInput({})));
      }),
    );
  },
);
