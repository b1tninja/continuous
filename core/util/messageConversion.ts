/**
 * Message conversion utilities for transitioning to unified ChatHistoryItem type.
 *
 * This module provides conversion functions between the OpenAI ChatCompletionMessageParam
 * format and the unified ChatHistoryItem format from the core package.
 */

import type { ChatCompletionMessageParam } from "openai/resources.mjs";
import type {
  AssistantChatMessage,
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  MessageContent,
  ToolCall,
  ToolCallState,
  ToolStatus,
} from "../index.js";

/**
 * Convert ChatCompletionMessageParam to ChatMessage
 */
export function convertToUnifiedMessage(
  message: ChatCompletionMessageParam,
): ChatMessage {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: typeof message.content === "string" ? message.content : "",
      };

    case "user":
      return {
        role: "user",
        content: convertMessageContent(message.content),
      };

    case "assistant": {
      const assistantMessage: AssistantChatMessage = {
        role: "assistant",
        content: convertMessageContent(message.content || ""),
      };

      // Convert tool calls if present
      if ("tool_calls" in message && message.tool_calls) {
        assistantMessage.toolCalls = message.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "",
          },
          ...(tc.extra_content && { extra_content: tc.extra_content }),
        }));
      }

      return assistantMessage;
    }

    case "tool":
      return {
        role: "tool",
        content: typeof message.content === "string" ? message.content : "",
        toolCallId: message.tool_call_id,
      };

    default:
      throw new Error(`Unsupported message role: ${(message as any).role}`);
  }
}

/**
 * Convert ChatMessage to ChatCompletionMessageParam
 */
export function convertFromUnifiedMessage(
  message: ChatMessage,
): ChatCompletionMessageParam | null {
  switch (message.role) {
    case "system":
      return {
        role: "system",
        content: message.content,
      };

    case "user":
      return {
        role: "user",
        content: convertFromMessageContent(message.content),
      };

    case "assistant": {
      const assistantMessage: ChatCompletionMessageParam = {
        role: "assistant",
        content: convertFromMessageContent(message.content),
      };

      // Convert tool calls if present
      if (message.toolCalls && message.toolCalls.length > 0) {
        (assistantMessage as any).tool_calls = message.toolCalls.map(
          (tc: any) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            },
            ...(tc.extra_content && { extra_content: tc.extra_content }),
          }),
        );
      }

      return assistantMessage;
    }

    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };

    case "thinking":
      // No OpenAI message carries reasoning back. Sent as assistant text it
      // would make two assistant turns in a row and show the reasoning as
      // part of the answer, so it is left out.
      return null;

    default:
      throw new Error(`Unsupported message role: ${(message as any).role}`);
  }
}

/**
 * Convert OpenAI message content to unified MessageContent format
 */
function convertMessageContent(
  content: string | null | Array<any>,
): MessageContent {
  if (content === null) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text") {
        return {
          type: "text" as const,
          text: part.text,
        };
      } else if (part.type === "image_url") {
        return {
          type: "imageUrl" as const,
          imageUrl: { url: part.image_url.url },
        };
      }
      throw new Error(`Unsupported content part type: ${part.type}`);
    });
  }

  throw new Error(`Unsupported content type: ${typeof content}`);
}

/**
 * Convert unified MessageContent to OpenAI format
 */
function convertFromMessageContent(
  content: MessageContent,
): string | Array<any> {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (part.type === "text") {
        return {
          type: "text",
          text: part.text,
        };
      } else if (part.type === "imageUrl") {
        return {
          type: "image_url",
          image_url: { url: part.imageUrl.url },
        };
      }
      throw new Error(`Unsupported content part type: ${part.type}`);
    });
  }

  throw new Error(`Unsupported content type: ${typeof content}`);
}

/**
 * Create a ChatHistoryItem from a ChatMessage
 */
export function createHistoryItem(
  message: ChatMessage,
  contextItems: ContextItemWithId[] = [],
  toolCallStates?: ToolCallState[],
): ChatHistoryItem {
  return {
    message,
    contextItems,
    ...(toolCallStates && { toolCallStates }),
  };
}

/**
 * Handle tool result message by updating the corresponding tool call state
 */
function handleToolResult(
  unifiedMessage: ChatMessage & { role: "tool" },
  pendingToolCalls: Map<string, ToolCall>,
  historyItems: ChatHistoryItem[],
): void {
  const toolCall = pendingToolCalls.get(unifiedMessage.toolCallId);
  if (!toolCall) return;

  // Add tool result as context to the previous assistant message
  let lastAssistantIndex = -1;
  for (let i = historyItems.length - 1; i >= 0; i--) {
    if (historyItems[i].message.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) return;
  if (!historyItems[lastAssistantIndex].toolCallStates) return;

  const toolState = historyItems[lastAssistantIndex].toolCallStates?.find(
    (ts: ToolCallState) => ts.toolCallId === unifiedMessage.toolCallId,
  );

  if (toolState) {
    toolState.output = [
      {
        content: unifiedMessage.content as string,
        name: `Tool Result: ${toolCall.function.name}`,
        description: "Tool execution result",
      },
    ];
  }
}

/**
 * Convert array of ChatCompletionMessageParam to ChatHistoryItem array
 */
export function convertToUnifiedHistory(
  messages: ChatCompletionMessageParam[],
): ChatHistoryItem[] {
  const historyItems: ChatHistoryItem[] = [];
  const pendingToolCalls: Map<string, ToolCall> = new Map();

  for (const message of messages) {
    const unifiedMessage = convertToUnifiedMessage(message);

    if (unifiedMessage.role === "assistant" && unifiedMessage.toolCalls) {
      // Store tool calls for matching with results
      const toolCallStates: ToolCallState[] = unifiedMessage.toolCalls.map(
        (tc: any) => {
          const toolCall: ToolCall = {
            id: tc.id || "",
            type: "function",
            function: {
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            },
            ...(tc.extra_content && { extra_content: tc.extra_content }),
          };
          pendingToolCalls.set(toolCall.id, toolCall);

          return {
            toolCallId: toolCall.id,
            toolCall,
            status: "done" as ToolStatus, // Historical calls are complete
            parsedArgs: tryParseJson(toolCall.function.arguments),
          };
        },
      );

      historyItems.push(createHistoryItem(unifiedMessage, [], toolCallStates));
    } else if (unifiedMessage.role === "tool") {
      // Tool result - handle separately to reduce nesting
      handleToolResult(unifiedMessage, pendingToolCalls, historyItems);
      // Don't add tool messages as separate history items
    } else {
      historyItems.push(createHistoryItem(unifiedMessage));
    }
  }

  return historyItems;
}

/**
 * Convert ChatHistoryItem array to ChatCompletionMessageParam array
 */
export function convertFromUnifiedHistory(
  historyItems: ChatHistoryItem[],
): ChatCompletionMessageParam[] {
  return convertChatMessagesToOpenAI(
    chatMessagesFromUnifiedHistory(historyItems).messages,
  );
}

/**
 * The messages a history stands for, before conversion to the OpenAI format:
 * each item's message (a user message with its context items in front), then
 * a result for each of its tool call states ("Tool cancelled" for one with no
 * output). `itemIndex[i]` is the index of the history item `messages[i]` came
 * from. The CLI normalises these (core/llm/normalizeTurns.ts) before
 * converting them.
 */
export function chatMessagesFromUnifiedHistory(
  historyItems: ChatHistoryItem[],
): { messages: ChatMessage[]; itemIndex: number[] } {
  const messages: ChatMessage[] = [];
  const itemIndex: number[] = [];

  historyItems.forEach((item, index) => {
    let message = item.message;

    // If this is a user message with context items, expand the content.
    // Array content keeps its format.
    if (
      message.role === "user" &&
      item.contextItems &&
      item.contextItems.length > 0 &&
      typeof message.content === "string"
    ) {
      const contextContent = item.contextItems
        .map(
          (contextItem: ContextItemWithId) =>
            `<context name="${contextItem.name}">\n${contextItem.content}\n</context>\n\n`,
        )
        .join("");
      message = { ...message, content: contextContent + message.content };
    }

    messages.push(message);
    itemIndex.push(index);

    // Add tool result messages if there are completed tool calls, and fallback when tool output is missing
    for (const toolState of item.toolCallStates ?? []) {
      messages.push({
        role: "tool",
        content:
          toolState.output && toolState.output.length > 0
            ? toolState.output.map((o: any) => o.content).join("\n")
            : "Tool cancelled",
        toolCallId: toolState.toolCallId,
      });
      itemIndex.push(index);
    }
  });

  return { messages, itemIndex };
}

/** ChatMessages in the OpenAI format; reasoning turns are left out. */
export function convertChatMessagesToOpenAI(
  messages: ChatMessage[],
): ChatCompletionMessageParam[] {
  return messages
    .map(convertFromUnifiedMessage)
    .filter((m): m is ChatCompletionMessageParam => m !== null);
}

/**
 * Convert ChatHistoryItem array to ChatCompletionMessageParam array with injected system message
 * @param historyItems - The chat history items
 * @param systemMessage - The system message to inject at the beginning
 */
export function convertFromUnifiedHistoryWithSystemMessage(
  historyItems: ChatHistoryItem[],
  systemMessage: string,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  // Inject system message at the beginning
  messages.push({
    role: "system",
    content: systemMessage,
  });

  // Convert the rest of the history
  const convertedMessages = convertFromUnifiedHistory(historyItems);
  messages.push(...convertedMessages);

  return messages;
}

/**
 * Extract tool call information from a ChatHistoryItem
 */
export function extractToolCallInfo(historyItem: ChatHistoryItem): {
  hasToolCalls: boolean;
  toolCalls?: ToolCall[];
  toolStates?: ToolCallState[];
} {
  const hasToolCalls = !!(
    historyItem.toolCallStates && historyItem.toolCallStates.length > 0
  );

  return {
    hasToolCalls,
    toolCalls: historyItem.toolCallStates?.map((ts: any) => ts.toolCall),
    toolStates: historyItem.toolCallStates,
  };
}

/**
 * Helper to safely parse JSON
 */
function tryParseJson(str: string): any {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
