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
import { cancelledEditResult } from "core/edit/editFailure";
import { describeToolCall } from "core/llm/contextBreakdown";
import { chatMessageIsEmpty } from "core/llm/messages";
import {
  getApplicableRules,
  getSystemMessageWithRules,
} from "core/llm/rules/getSystemMessageWithRules";
import { RulePolicies } from "core/llm/rules/types";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  CANCELLED_TOOL_CALL_MESSAGE,
  ERRORED_TOOL_CALL_OUTPUT_MESSAGE,
  NO_TOOL_CALL_OUTPUT_MESSAGE,
} from "core/tools/constants";
import { unfinishedToolCallOutput } from "core/tools/unfinishedCall";
import { convertToolCallStatesToSystemCallsAndOutput } from "core/tools/systemMessageTools/convertSystemTools";
import { SystemMessageToolsFramework } from "core/tools/systemMessageTools/types";
import { sendAttachmentsOnce } from "core/util/contextReferences";
import { summaryMessageText } from "core/util/summaryMessage";
import {
  maskRemovedToolResults,
  removedToolResultLabels,
  removedToolResultStub,
  withRemovedParts,
} from "core/util/contextRemoval";
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

/** A rule first matched by a later message, sent with that message. */
export function ruleNoteText(rule: RuleWithSource): string {
  const name = rule.name ? ` name="${rule.name}"` : "";
  return `<rule${name}>\n${rule.rule}\n</rule>`;
}

function ruleSortKey(rule: RuleWithSource): string {
  return [
    rule.sourceFile ?? "",
    rule.slug ?? "",
    rule.name ?? "",
    rule.source ?? "",
    rule.rule,
  ].join("\u0000");
}

/** A fixed order for rules, by file, name and text: code-unit order, no locale. */
export function compareRules(a: RuleWithSource, b: RuleWithSource): number {
  const ka = ruleSortKey(a);
  const kb = ruleSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * Which rules go in the system message and which with a message. Mutates
 * `msgs`: a rule a later user or tool message is the first to match is
 * appended to that message (a text part, or a paragraph of a tool result).
 * The result is a function of the messages alone, so a message's bytes are
 * the same in every request that carries it.
 */
function rulesForMessages(
  msgs: MessageWithContextItems[],
  baseSystemMessage: string | undefined,
  configRules: RuleWithSource[],
  rulePolicies: RulePolicies,
  /**
   * The messages a compaction summarised, in front of `msgs`. The rules are
   * decided over the whole conversation, so the system message and the kept
   * messages are the same bytes as before the compaction. A rule that a
   * summarised message was the first to match is returned in `spanNotes`, to
   * travel with the summary.
   */
  span: MessageWithContextItems[] = [],
): {
  systemMessage: string;
  appliedRules: RuleMetadata[];
  spanNotes: string;
} {
  // In a fixed order, not the config's: a reload can list the same rules in
  // another order (a colocated rules.md that changed goes to the end of the
  // list until the next full scan), and two rules that swap places leave the
  // prompt the same length but different after the tools
  const availableRules = [...configRules].sort(compareRules);
  const all = [...span, ...msgs];
  const firstIndex = all.findIndex((m) => m.message.role === "user");
  const first = firstIndex >= 0 ? all[firstIndex] : undefined;
  const system = getSystemMessageWithRules({
    baseSystemMessage,
    availableRules,
    userMessage: first?.message as UserChatMessage | undefined,
    contextItems: first?.ctxItems ?? [],
    rulePolicies,
  });
  // The same rules getSystemMessageWithRules matched for the first message
  const seen = new Set<RuleWithSource>(
    getApplicableRules(
      first?.message as UserChatMessage | undefined,
      availableRules,
      first?.ctxItems ?? [],
      rulePolicies,
    ),
  );
  const later: RuleMetadata[] = [];
  const spanNotes: string[] = [];
  all.forEach((item, index) => {
    if (index <= firstIndex) return;
    const role = item.message.role;
    if (role !== "user" && role !== "tool") return;
    const matched = getApplicableRules(
      item.message as UserChatMessage | ToolResultChatMessage,
      availableRules,
      item.ctxItems,
      rulePolicies,
    ).filter((rule) => !seen.has(rule));
    if (!matched.length) return;
    for (const rule of matched) {
      seen.add(rule);
      const { rule: _text, ...meta } = rule;
      later.push(meta);
    }
    const notes = matched.map(ruleNoteText).join("\n\n");
    if (index < span.length) {
      spanNotes.push(notes);
      return;
    }
    item.message =
      role === "tool"
        ? {
            ...(item.message as ToolResultChatMessage),
            content: `${renderChatMessage(item.message)}\n\n${notes}`,
          }
        : {
            ...(item.message as UserChatMessage),
            content: [
              ...normalizeToMessageParts(item.message),
              { type: "text", text: `\n\n${notes}` } as TextMessagePart,
            ],
          };
  });
  return {
    systemMessage: system.systemMessage,
    appliedRules: [...system.appliedRules, ...later],
    spanNotes: spanNotes.join("\n\n"),
  };
}

interface MessageWithContextItems {
  ctxItems: ContextItemWithId[];
  message: ChatMessage;
}

/** The newest item that carries a conversation summary, or -1. */
export function summaryIndexOf(history: ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) return i;
  }
  return -1;
}

/**
 * The messages a stretch of history is sent as, before rules and the system
 * message: what "Choose what to keep" removed as stubs, repeated attachments
 * as stubs, tool results after their calls.
 */
function historyToMessages(
  history: ChatHistoryItem[],
  useSystemToolsFramework: SystemMessageToolsFramework | undefined,
): {
  msgs: MessageWithContextItems[];
  appliedRuleIndex: number;
  removedToolResults: Map<string, string>;
} {
  // What the person removed with "Choose what to keep" is sent as stubs
  // (core/util/contextRemoval.ts); a removed old turn is left out whole.
  const removedToolResults = removedToolResultLabels(history, (state) =>
    describeToolCall(
      state.toolCall?.function?.name ?? "tool",
      state.parsedArgs ?? state.toolCall?.function?.arguments,
    ),
  );
  // A file attached again with the same content is sent once, at its first
  // attachment; later copies are a one-line stub (contextReferences.ts)
  const historyCopy = sendAttachmentsOnce(history.map(withRemovedParts));

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
            // A cancelled edit says the file is as it was
            content =
              cancelledEditResult(
                toolCall.function?.name,
                toolCallState.parsedArgs,
              ) ?? CANCELLED_TOOL_CALL_MESSAGE;
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
          } else {
            // No output and not finished: say what that means, not "No tool output"
            content = unfinishedToolCallOutput(toolCallState.status);
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
  return { msgs, appliedRuleIndex, removedToolResults };
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
  // The newest conversation summary: only the items after it are sent
  const summaryAt = summaryIndexOf(history);
  const summaryContent =
    summaryAt >= 0 ? (history[summaryAt].conversationSummary ?? "") : "";
  const { msgs, appliedRuleIndex, removedToolResults } = historyToMessages(
    summaryAt >= 0 ? history.slice(summaryAt + 1) : history,
    useSystemToolsFramework,
  );
  // What the summary replaced, as it was sent before the compaction: only
  // the rules are decided from it
  const span =
    summaryAt >= 0
      ? historyToMessages(
          history.slice(0, summaryAt + 1),
          useSystemToolsFramework,
        ).msgs
      : [];

  // Rules (C62, and docs: "Why a turn re-reads the whole prompt"). The
  // system message carries the rules that always apply and those the first
  // message matched. A rule that a later message or tool result matches is
  // sent with that message, after its content, and stays there in every
  // later request. Putting it in the system message instead rewrote the
  // front of the conversation: a local server's chat template puts the
  // system message right after the tools, so the whole conversation was
  // read again, minutes at 400k tokens. After a compaction the first
  // message is still the conversation's first, so the system message does
  // not change; a rule a summarised message matched goes with the summary.
  const { systemMessage, appliedRules, spanNotes } = rulesForMessages(
    msgs,
    baseSystemMessage,
    availableRules,
    rulePolicies,
    span,
  );

  // The summary is the first message after the system message, never part
  // of it (C104, plans/research/cache-friendly-context-trimming.md D4): a
  // compaction then leaves the tools and the system message the same bytes,
  // so the provider's cached head survives it (an Anthropic or Bedrock
  // breakpoint on the system prompt, Strata's system-prompt checkpoint), and
  // only the summary and what follows it are read again.
  if (summaryContent) {
    msgs.unshift({
      ctxItems: [],
      message: {
        role: "user",
        content: summaryMessageText(
          spanNotes ? `${summaryContent}\n\n${spanNotes}` : summaryContent,
        ),
      },
    });
  }

  if (systemMessage.trim()) {
    msgs.unshift({
      ctxItems: [],
      message: {
        role: "system",
        content: systemMessage,
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
