import type { ChatMessage } from "core";
import { renderChatMessage } from "core/util/messageContent";

/** One history item, as far as an empty stop needs to see it. */
export interface TurnItem {
  message: { role: string; content?: unknown };
  toolCallStates?: readonly unknown[];
  reasoning?: { text?: string };
}

function messageText(message: TurnItem["message"]): string {
  if (message.content == null) return "";
  return renderChatMessage(message as ChatMessage).trim();
}

/**
 * Sizes of the latest model turn, back to the last user message or tool
 * result. Thinking is not an answer. A history that still ends on the user
 * or a tool result has not had a model turn yet, so lacksReply is false.
 */
export function measureModelTurn(history: readonly TurnItem[]): {
  thinkingChars: number;
  answerChars: number;
  toolCalls: number;
  lacksReply: boolean;
} {
  let thinkingChars = 0;
  let answerChars = 0;
  let toolCalls = 0;
  let sawModelItem = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const role = item.message.role;
    if (role === "user" || role === "tool") break;
    if (role !== "assistant" && role !== "thinking") continue;
    sawModelItem = true;
    if (role === "thinking") {
      thinkingChars += messageText(item.message).length;
      continue;
    }
    answerChars += messageText(item.message).length;
    toolCalls += item.toolCallStates?.length ?? 0;
    const reasoning = item.reasoning?.text?.trim();
    if (reasoning) thinkingChars += reasoning.length;
  }
  return {
    thinkingChars,
    answerChars,
    toolCalls,
    lacksReply: sawModelItem && answerChars === 0 && toolCalls === 0,
  };
}

export function modelTurnLacksReply(history: readonly TurnItem[]): boolean {
  return measureModelTurn(history).lacksReply;
}

function turnHasReasoning(history: readonly TurnItem[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const role = item.message.role;
    if (role === "user" || role === "tool") break;
    if (role === "thinking" && messageText(item.message)) return true;
    if (item.reasoning?.text?.trim()) return true;
  }
  return false;
}

/**
 * What to show when the model finished with no answer and no tool call.
 * Undefined when the turn has either. An output-limit stop keeps the
 * sentence that names the cap. Any other stop says the turn produced no reply.
 */
export function emptyStopDetail(input: {
  history: readonly TurnItem[];
  stopReason?: string;
  /** Cap that was sent. */
  maxTokens?: number;
  /** Configured cap, when it was higher than what was sent. */
  askedMaxTokens?: number;
  contextLength?: number;
}): string | undefined {
  if (!modelTurnLacksReply(input.history)) return undefined;
  if (input.stopReason === "model_context_window_exceeded") {
    const window = input.contextLength ?? "unknown";
    const maxOut = input.maxTokens ?? "unknown";
    return (
      `The model stopped because the reply hit the context window (${window} tokens). ` +
      `The output cap sent with the request was ${maxOut} tokens.`
    );
  }
  if (input.stopReason === "length" || input.stopReason === "max_tokens") {
    const maxOut = input.maxTokens;
    const window = input.contextLength ?? "unknown";
    const asked =
      input.askedMaxTokens !== undefined && input.askedMaxTokens !== maxOut
        ? `, config asked for ${input.askedMaxTokens}`
        : "";
    return (
      `The model stopped without a reply because the output limit was reached` +
      `${maxOut !== undefined ? ` (${maxOut} tokens${asked})` : ""}. ` +
      `The context window in use is ${window} tokens. ` +
      `Change either under Models → Configure → Context & cost.`
    );
  }
  const reasoning = turnHasReasoning(input.history)
    ? " Reasoning from this turn is not a reply."
    : "";
  const stop = input.stopReason ? ` Stop reason: ${input.stopReason}.` : "";
  return `The model stopped without a reply and without a tool call.${reasoning}${stop}`;
}
