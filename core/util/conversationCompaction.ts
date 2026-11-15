import {
  ChatHistoryItem,
  ChatMessage,
  ILLM,
  LLMFullCompletionOptions,
  ToolResultChatMessage,
} from "..";
import { HistoryManager } from "./history";
import { stripImages } from "./messageContent";

export interface CompactionParams {
  sessionId: string;
  index: number;
  historyManager: HistoryManager;
  currentModel: ILLM;
  /**
   * The conversation exactly as the chat last sent it: the compiled messages,
   * system message first, and the completion options (tools, reasoning, cache
   * settings). The summary request is these messages plus the summary prompt,
   * so it starts with the same bytes as the conversation's last request and a
   * warm prompt cache is read instead of the history being paid for again at
   * full price. The chat window builds them (core cannot: it has no context
   * items or tool results) and sends them only while the cache is warm. Left
   * out, the request is what it always was: the saved history, no system
   * message, no tools, no cache settings.
   */
  conversationPrefix?: {
    messages: ChatMessage[];
    options: LLMFullCompletionOptions;
  };
  /** Cancels the summary request (a background summary, on activity). */
  signal?: AbortSignal;
}

export interface ApplyCompactionParams extends CompactionParams {
  /**
   * A summary made earlier for exactly this span (planned compaction, C105):
   * saved as it is, with no summary request.
   */
  summary?: string;
}

/** Added when the tools are in the request, since they cannot be forbidden. */
const TEXT_ONLY_NOTE =
  "\n\nAnswer with the summary as plain text. Do not call any tool.";

/** What the summary request asks for. */
const COMPACTION_PROMPT =
  "Create a comprehensive summary of this conversation that captures all essential information needed to continue the work seamlessly. Structure your response to preserve technical accuracy and context continuity.\n\nYour summary should include:\n\n1. **Conversation Overview**: Describe the main topic and progression of the discussion, including any shifts in focus or direction.\n\n2. **Active Development**: Detail what was being implemented, modified, or debugged most recently. Include specific technical approaches and methodologies used.\n\n3. **Technical Stack**: List all relevant technologies, frameworks, libraries, coding patterns, and architectural decisions discussed.\n\n4. **File Operations**: Document all files that were created, modified, or referenced, including their purposes and key changes. Include important code snippets and their locations.\n\n5. **Solutions & Troubleshooting**: Summarize problems encountered and how they were resolved, including any debugging steps or workarounds applied.\n\n6. **Outstanding Work**: Clearly identify any incomplete tasks, pending implementations, or next steps that were discussed. Include direct references to user requests and current progress.\n\nIf there's a previous summary in the conversation, integrate its relevant information while removing outdated details. Focus on technical precision and include specific identifiers (file paths, function names, class names, etc.) that would be essential for continuation. Write in third person and maintain an objective, technical tone.\n\nThe task list, if there is one, is kept separately and sent again after the summary, so do not restate its items; say only which item was being worked on at the end.";

/**
 * Compacts conversation history up to a specified index by generating a summary.
 * This helper function extracts the compaction logic from the main core handler.
 * With `summary`, that summary is saved and no request is sent.
 *
 * @param params - Object containing sessionId, index, historyManager, and currentModel
 * @returns Promise<void> - Updates the session with the conversation summary
 */
export async function compactConversation(
  params: ApplyCompactionParams,
): Promise<void> {
  const { sessionId, index, historyManager } = params;
  const summary = params.summary ?? (await summarizeConversation(params));
  const session = historyManager.load(sessionId);
  if (!session.history[index]) {
    throw new Error(`No message ${index} in this session to compact at`);
  }

  // Update the target message with the conversation summary. Every message
  // stays in the session: the summary only changes what is sent.
  const updatedHistory = [...session.history];
  updatedHistory[index] = {
    ...updatedHistory[index],
    conversationSummary: summary,
  };

  // Update the session with the new history. The saved prompt cache record
  // described the old, longer conversation; the next request builds a new one.
  const updatedSession = {
    ...session,
    history: updatedHistory,
    promptCache: undefined,
  };

  historyManager.save(updatedSession);
}

/**
 * The summary of the session's history up to and including `index`, without
 * saving anything: what "Compact" stores, and what a background summary
 * (planned compaction) prepares ahead of time.
 */
export async function summarizeConversation({
  sessionId,
  index,
  historyManager,
  currentModel,
  conversationPrefix,
  signal = new AbortController().signal,
}: CompactionParams): Promise<string> {
  // Get the current session
  const session = historyManager.load(sessionId);
  const historyUpToIndex = session.history.slice(0, index + 1);

  // Apply the same filtering logic as in constructMessages, but exclude the target message
  // if it already has a summary (we're re-compacting)
  let summaryContent = "";
  let filteredHistory = historyUpToIndex;

  // First, check if the target message already has a summary and ignore it
  const targetMessageHasSummary = historyUpToIndex[index].conversationSummary;
  const searchHistory = targetMessageHasSummary
    ? historyUpToIndex.slice(0, index)
    : historyUpToIndex;

  // Find the most recent conversation summary (excluding target if it has one)
  for (let i = searchHistory.length - 1; i >= 0; i--) {
    const summary = searchHistory[i].conversationSummary;
    if (summary) {
      summaryContent = summary;
      // Only include messages that come AFTER the message with the summary
      filteredHistory = historyUpToIndex.slice(i + 1);
      break;
    }
  }

  const messages: ChatHistoryItem["message"][] = [];

  // add cancelled chat messages explicitly for cancelled tool calls
  filteredHistory.forEach((item) => {
    // An old turn removed with "Choose what to keep" is not summarised
    if (item.removedByUser?.turn) return;
    messages.push(item.message);
    // toolcalls only exist in an assistant message
    if (item.message.role === "assistant" && item.message.toolCalls) {
      // for every toolcall, if there is no tool message with a tool call id already, add a chat message saying that it is empty
      item.message.toolCalls.forEach((toolCall) => {
        if (
          !filteredHistory.find(
            (item) =>
              item.message.role === "tool" &&
              item.message.toolCallId === toolCall.id,
          )
        ) {
          messages.push({
            role: "tool",
            content: "Tool cancelled",
            toolCallId: toolCall.id,
          } as ToolResultChatMessage);
        }
      });
    }
  });

  // If there's a previous summary, include it as a user message at the beginning
  if (summaryContent) {
    messages.unshift({
      role: "user",
      content: `Previous conversation summary:\n\n${summaryContent}`,
    });
  }

  const compactionPrompt = {
    role: "user" as const,
    content: COMPACTION_PROMPT,
  };

  let response;
  if (conversationPrefix) {
    // The tools stay in the request because they are part of the cached prefix,
    // and nothing can forbid calling one (toolChoice can only force a named
    // tool), so the prompt asks for text. A reply with no text is not a summary:
    // fall back to the request as it was before.
    response = await currentModel.chat(
      [
        ...conversationPrefix.messages,
        {
          ...compactionPrompt,
          content:
            COMPACTION_PROMPT +
            TEXT_ONLY_NOTE +
            spanNote(session.history, index),
        },
      ],
      signal,
      { ...conversationPrefix.options },
    );
    if (!stripImages(response.content).trim()) response = undefined;
  }
  response ??= await currentModel.chat(
    [...messages, compactionPrompt],
    signal,
    {},
  );

  return stripImages(response.content);
}

/** How much of a quoted message the span note shows. */
const SPAN_QUOTE_CHARS = 200;

/**
 * For a summary of only the start of the conversation (planned compaction:
 * the prefix is the whole conversation, so its cache is read, but the newest
 * turns stay verbatim after the summary): where the summary ends. Empty when
 * the whole conversation is summarised.
 */
export function spanNote(history: ChatHistoryItem[], index: number): string {
  if (index >= history.length - 1) return "";
  const last = stripImages(history[index].message.content)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SPAN_QUOTE_CHARS);
  const where = last
    ? `the message that begins "${last}"`
    : `message ${index + 1} of the conversation`;
  return (
    `\n\nSummarise only the conversation up to and including ${where}. ` +
    "The messages after it stay in the conversation word for word, after the summary, so leave them out of the summary."
  );
}
