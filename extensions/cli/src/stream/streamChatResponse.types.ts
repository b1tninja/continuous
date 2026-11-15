import { CompletionOptions } from "@continuedev/config-yaml";
import type { ChatHistoryItem, ToolStatus } from "core/index.js";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources.mjs";

import { ToolCallPreview } from "../tools/types.js";

import type { StreamedReasoning } from "./reasoning.js";

export interface StreamCallbacks {
  onContent?: (content: string) => void;
  onContentComplete?: (content: string) => void;
  /**
   * The model's reasoning as it streams, one piece at a time. Never part of
   * the reply's content; the terminal UI shows it dimmed while the model
   * thinks.
   */
  onReasoning?: (text: string) => void;
  /**
   * A reply's whole reasoning, once, after its stream ends (and after the
   * request's `onRequest`) and before `onContentComplete`. Not called for a
   * reply without reasoning.
   */
  onReasoningComplete?: (reasoning: StreamedReasoning) => void;
  /**
   * `toolCallId` on the four tool callbacks is the model's id for the call.
   * Calls of one turn can run at the same time, and two of them can be the
   * same tool, so a consumer that pairs a result with its call uses the id,
   * not the name. It is absent only where the caller has no call (a prompt
   * raised from inside a tool, such as a subagent's).
   */
  onToolStart?: (toolName: string, toolArgs?: any, toolCallId?: string) => void;
  onToolResult?: (
    result: string,
    toolName: string,
    status: ToolStatus,
    toolCallId?: string,
  ) => void;
  onToolError?: (error: string, toolName?: string, toolCallId?: string) => void;
  onToolPermissionRequest?: (
    toolName: string,
    toolArgs: any,
    requestId: string,
    preview?: ToolCallPreview[],
    toolCallId?: string,
  ) => void;
  onSystemMessage?: (message: string) => void;
  /**
   * A short notice about the request for the person, not the model: for
   * example that the reply was cut off at the output limit. The TUI shows it
   * on its status line; `cn serve` writes it to its log.
   */
  onStatusMessage?: (message: string) => void;
  /**
   * The reply is being held back while recovery looks for a tool call the
   * model wrote as text (`true`), or the hold is over (`false`). Called once
   * for each; never called when recovery is off.
   */
  onRecoveryHold?: (holding: boolean) => void;
  /**
   * Called after a round of tool calls has finished and before the next model
   * request. A returned item (a user message the person asked to steer with)
   * is appended to the conversation, so the model reads it in the same turn.
   */
  onToolBoundary?: () => Promise<ChatHistoryItem | undefined>;
  /**
   * True while the model's reply streams, false once it has ended (before any
   * of its tool calls run). "Steer now" interrupts only while it is true, so a
   * running tool is never cut short.
   */
  onModelStreaming?: (streaming: boolean) => void;
}

export function getDefaultCompletionOptions(
  opts?: CompletionOptions,
): Partial<ChatCompletionCreateParamsStreaming> {
  if (!opts) return {};
  return {
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    frequency_penalty: opts.frequencyPenalty,
    presence_penalty: opts.presencePenalty,
    top_p: opts.topP,
  };
}
