import {
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  RuleMetadata,
  RuleWithSource,
  TextMessagePart,
  ToolResultChatMessage,
  UserChatMessage,
} from "core";
import { describeToolCall } from "core/llm/contextBreakdown";
import { chatMessageIsEmpty } from "core/llm/messages";
import { getSystemMessageWithRules } from "core/llm/rules/getSystemMessageWithRules";
import { RulePolicies } from "core/llm/rules/types";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  CANCELLED_TOOL_CALL_MESSAGE,
  ERRORED_TOOL_CALL_OUTPUT_MESSAGE,
  NO_TOOL_CALL_OUTPUT_MESSAGE,
} from "core/tools/constants";
import { convertToolCallStatesToSystemCallsAndOutput } from "core/tools/systemMessageTools/convertSystemTools";
import { SystemMessageToolsFramework } from "core/tools/systemMessageTools/types";
import { sendAttachmentsOnce } from "core/util/contextReferences";
import {
  maskRemovedToolResults,
  removedToolResultLabels,
  removedToolResultStub,
  withRemovedParts,
} from "core/util/contextRemoval";
import { findLast, findLastIndex } from "core/util/findLast";
import {
  normalizeToMessageParts,
  renderChatMessage,
  renderContextItems,
  renderContextItemsWithStatus,
} from "core/util/messageContent";
import { toolCallStateToContextItems } from "../../pages/gui/ToolCallDiv/utils";

/**
 * Whether the reasoning at `index` is followed, within its turn (before the
 * next user or tool item), by an assistant answer: text or tool calls.
 */
function hasAnswerAfter(history: ChatHistoryItem[], index: number): boolean {
  for (let i = index + 1; i < history.length; i++) {
    const { message } = withoutIncompleteToolCalls(history[i]);
    if (message.role === "user" || message.role === "tool") return false;
    if (
      message.role === "assistant" &&
      (!!message.toolCalls?.length || !!renderChatMessage(message).trim())
    ) {
      return true;
    }
  }
  return false;
}

// Helper function to render context items and append status information
// Helper function to render context items and append status information

/** A call the model finished naming: it has an id and a tool name. */
function isCompleteToolCall(
  call: { id?: string; function?: { name?: string } } | undefined,
): boolean {
  return !!call?.id && !!call.function?.name;
}

/**
 * The assistant item without tool calls that have no id or no name. A turn
 * cut off mid-call (a stream that stopped, a window that reloaded) can leave
 * one. Providers refuse a tool result with an empty id, and Bedrock turned
 * the call into text ahead of the next real result, which Claude refuses
 * ("tool_use ids were found without tool_result blocks immediately after").
 * The call and its result are left out of the request; they stay on screen.
 */
export function withoutIncompleteToolCalls(
  item: ChatHistoryItem,
): ChatHistoryItem {
  const message = item.message;
  const states = item.toolCallStates;
  const calls = message.role === "assistant" ? message.toolCalls : undefined;
  const keptStates = states?.filter((s) => isCompleteToolCall(s.toolCall));
  const keptCalls = calls?.filter((c) => isCompleteToolCall(c));
  const statesChanged = keptStates?.length !== states?.length;
  const callsChanged = keptCalls?.length !== calls?.length;
  if (!statesChanged && !callsChanged) return item;
  return {
    ...item,
    ...(states && { toolCallStates: keptStates }),
    message:
      message.role === "assistant" && calls
        ? { ...message, toolCalls: keptCalls?.length ? keptCalls : undefined }
        : message,
  };
}

/** Starts the conversation summary appended to the system message. */
export const SUMMARY_MARKER = "\n\nPrevious conversation summary:";

interface MessageWithContextItems {
  ctxItems: ContextItemWithId[];
  message: ChatMessage;
}
export function constructMessages(
  history: ChatHistoryItem[],
  baseSystemMessage: string | undefined,
  availableRules: RuleWithSource[],
  rulePolicies: RulePolicies,
  useSystemToolsFramework?: SystemMessageToolsFramework,
): {
  messages: ChatMessage[];
  appliedRules: RuleMetadata[];
  appliedRuleIndex: number;
} {
  // Find the most recent conversation summary and filter history accordingly
  let summaryContent = "";
  let filteredHistory = history;

  for (let i = history.length - 1; i >= 0; i--) {
    const summary = history[i].conversationSummary;
    if (summary) {
      summaryContent = summary;
      // Only include messages that come AFTER the message with the summary
      filteredHistory = history.slice(i + 1);
      break;
    }
  }

  // What the person removed with "Choose what to keep" is sent as stubs
  // (core/util/contextRemoval.ts); a removed old turn is left out whole.
  const removedToolResults = removedToolResultLabels(filteredHistory, (state) =>
    describeToolCall(
      state.toolCall?.function?.name ?? "tool",
      state.parsedArgs ?? state.toolCall?.function?.arguments,
    ),
  );
  // A file attached again with the same content is sent once, at its first
  // attachment; later copies are a one-line stub (contextReferences.ts)
  const historyCopy = sendAttachmentsOnce(
    filteredHistory.map(withRemovedParts),
  );

  const msgs: MessageWithContextItems[] = [];
  let appliedRuleIndex = -1;
  let index = -1;
  for (const original of historyCopy) {
    index++;
    const item = withoutIncompleteToolCalls(original);
    if (
      item.removedByUser?.turn ||
      item.message.role === "system" ||
      item.message.role === "tool" ||
      chatMessageIsEmpty(item.message)
    ) {
      // Tool messages will be re-inserted
      continue;
    }

    if (item.message.role === "user") {
      appliedRuleIndex = index;
      // Gather context items for user messages
      let content = normalizeToMessageParts(item.message);

      const ctxItemParts = item.contextItems
        .map((ctxItem) => {
          return {
            type: "text",
            text: `${ctxItem.content}\n`,
          } as TextMessagePart;
        })
        .filter((part) => !!part.text.trim());

      content = [...ctxItemParts, ...content];
      msgs.push({
        ctxItems: item.contextItems,
        message: {
          ...item.message,
          content,
        },
      });
    } else if (item.message.role === "thinking") {
      // Reasoning from a turn stopped or failed before any answer stays on
      // screen but is not sent: alone it would be an assistant turn holding
      // only reasoning, which providers reject or turn into an empty turn
      if (!hasAnswerAfter(historyCopy, index)) continue;
      msgs.push({
        ctxItems: item.contextItems,
        message: item.message,
      });
    } else if (item.message.role === "assistant") {
      // When using system message tools, convert tool calls/states to text content
      if (item.toolCallStates?.length && useSystemToolsFramework) {
        const { userMessage, assistantMessage } =
          convertToolCallStatesToSystemCallsAndOutput(
            item.message,
            (item.toolCallStates ?? []).map((state) => {
              const label = removedToolResults.get(state.toolCallId);
              if (label === undefined || !state.output) return state;
              const chars = renderContextItems(state.output).length;
              return {
                ...state,
                output: [
                  {
                    name: "Removed",
                    description: "",
                    content: removedToolResultStub(label, chars),
                  },
                ],
              };
            }),
            useSystemToolsFramework,
          );
        msgs.push({
          message: assistantMessage,
          ctxItems: [],
        });
        msgs.push({
          message: userMessage,
          ctxItems: [],
        });
        continue;
      }

      msgs.push({
        ctxItems: item.contextItems,
        message: item.message,
      });

      // Add a tool message for each tool call
      if (item.toolCallStates?.length) {
        // If the assistant message has tool calls, we need to insert tool messages
        for (const toolCallState of item.toolCallStates) {
          const { output, status, toolCall } = toolCallState;
          let content: string = NO_TOOL_CALL_OUTPUT_MESSAGE;

          if (status === "canceled") {
            content = CANCELLED_TOOL_CALL_MESSAGE;
          } else if (output) {
            if (
              toolCall.function?.name == BuiltInToolNames.RunTerminalCommand
            ) {
              // Add status for tools containing detailed status outcomes per context item
              content = renderContextItemsWithStatus(output);
            } else {
              content = renderContextItems(output);
            }
          } else if (toolCallState.status === "errored") {
            content = ERRORED_TOOL_CALL_OUTPUT_MESSAGE;
          }

          msgs.push({
            ctxItems: toolCallStateToContextItems(toolCallState),
            message: {
              role: "tool",
              content,
              toolCallId: toolCall.id!,
            },
          });
        }
      } else if (item.toolCallStates && item.toolCallStates.length > 0) {
        // This case indicates a potential mismatch - we have tool call states but no message.toolCalls
        console.error(
          "ERROR constructMessages: Assistant message has toolCallStates but no message.toolCalls:",
          {
            toolCallStates: item.toolCallStates.length,
            toolCallIds: item.toolCallStates.map((s) => s.toolCallId),
            messageContent:
              typeof item.message.content === "string"
                ? item.message.content?.substring(0, 50) + "..."
                : "Non-string content",
          },
        );
      }
    }
  }

  // Some rules only apply to the last user or tool message
  const lastUserOrToolMsg = findLast(
    msgs,
    (item) => item.message.role === "user" || item.message.role === "tool",
  )?.message as UserChatMessage | ToolResultChatMessage;

  // Some rules apply to all context items since the last user message, inclusiv
  const lastUserMsgIndex = findLastIndex(
    msgs,
    (item) => item.message.role === "user",
  );
  const itemsBackToLastUserMessage = msgs
    .slice(lastUserMsgIndex, msgs.length)
    .filter(
      (item) => item.message.role === "tool" || item.message.role === "user",
    );
  const rulesContextItems = itemsBackToLastUserMessage
    .map((item) => item.ctxItems)
    .flat();

  // Rules that matched an earlier turn stay applied (see earlierTurns)
  const earlierTurns = msgs
    .slice(0, Math.max(lastUserMsgIndex, 0))
    .filter(
      (item) => item.message.role === "user" || item.message.role === "tool",
    )
    .map((item) => ({
      userMessage: item.message as UserChatMessage | ToolResultChatMessage,
      contextItems: item.ctxItems,
    }));

  const { systemMessage, appliedRules } = getSystemMessageWithRules({
    baseSystemMessage,
    availableRules,
    userMessage: lastUserOrToolMsg,
    contextItems: rulesContextItems,
    rulePolicies,
    earlierTurns,
  });

  // Append conversation summary to system message if it exists
  let finalSystemMessage = systemMessage;
  if (summaryContent) {
    finalSystemMessage = systemMessage
      ? `${systemMessage}${SUMMARY_MARKER}\n\n ${summaryContent}`
      : `Previous conversation summary:\n\n ${summaryContent}`;
  }

  if (finalSystemMessage.trim()) {
    msgs.unshift({
      ctxItems: [],
      message: {
        role: "system",
        content: finalSystemMessage,
      },
    });
  }

  const messages = maskRemovedToolResults(
    msgs.map((m) => m.message),
    removedToolResults,
  ).messages;
  return {
    messages,
    appliedRules,
    appliedRuleIndex,
  };
}
