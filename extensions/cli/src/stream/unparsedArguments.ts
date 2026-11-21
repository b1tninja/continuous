import {
  incompleteToolCallResult,
  isTruncatedJson,
  stoppedForLength,
  truncatedToolCallResult,
} from "core/util/truncatedJson.js";

import type { ToolCall } from "../tools/types.js";

/**
 * Whether the argument text a call streamed is not JSON. A call that sent no
 * argument text has no arguments, which is a valid call.
 */
export function argumentsUnparsed(argumentsStr: string): boolean {
  if (!argumentsStr.trim()) return false;
  try {
    JSON.parse(argumentsStr);
    return false;
  } catch {
    return true;
  }
}

/**
 * What the model is told when a call's arguments did not parse, in core's
 * words (the IDE's refuseTruncatedToolCalls). A reply that hit its output
 * limit was cut off; one that stopped for any other reason sent incomplete
 * arguments, and smaller pieces would not help. With no stop reason, the
 * text itself decides: one that stops part-way through a value was cut off.
 */
export function unparsedArgumentsResult(
  toolName: string,
  argumentsStr: string,
  finishReason: string | undefined,
  maxTokens: number | undefined,
): string {
  const cutOff =
    stoppedForLength(finishReason) ?? isTruncatedJson(argumentsStr);
  return cutOff
    ? truncatedToolCallResult(toolName, maxTokens)
    : incompleteToolCallResult(toolName);
}

/**
 * Marks the calls of a finished reply whose arguments did not parse, so they
 * are answered and not run. The parse while streaming keeps the last text
 * that parsed, or `{}`, and a tool with no required parameter ran with that.
 */
export function markUnparsedArguments(
  toolCalls: ToolCall[],
  finishReason: string | undefined,
  model: { defaultCompletionOptions?: { maxTokens?: number } },
): void {
  for (const toolCall of toolCalls) {
    if (!argumentsUnparsed(toolCall.argumentsStr)) continue;
    toolCall.arguments = {};
    toolCall.unparsedArguments = unparsedArgumentsResult(
      toolCall.name,
      toolCall.argumentsStr,
      finishReason,
      model.defaultCompletionOptions?.maxTokens,
    );
  }
}
