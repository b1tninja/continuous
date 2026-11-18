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
 * The model's latest turn wrote neither an answer nor a tool call. Thinking
 * is not an answer. A history that still ends on the user or a tool result
 * has not had a model turn yet, so this is false.
 */
export function modelTurnLacksReply(history: readonly TurnItem[]): boolean {
  let sawModelItem = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const role = item.message.role;
    if (role === "user" || role === "tool") break;
    if (role !== "assistant" && role !== "thinking") continue;
    sawModelItem = true;
    if (role === "thinking") continue;
    if (messageText(item.message) || (item.toolCallStates?.length ?? 0) > 0) {
      return false;
    }
  }
  return sawModelItem;
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
  maxTokens?: number;
  contextLength?: number;
}): string | undefined {
  if (!modelTurnLacksReply(input.history)) return undefined;
  if (input.stopReason === "length" || input.stopReason === "max_tokens") {
    const maxOut = input.maxTokens;
    const window = input.contextLength ?? "unknown";
    return (
      `The model stopped without a reply because the output limit was reached` +
      `${maxOut !== undefined ? ` (${maxOut} tokens)` : ""}. ` +
      `The context window in use is ${window} tokens. ` +
      `Change either under Models → Configure → Context & cost.`
    );
  }
  const reasoning = turnHasReasoning(input.history)
    ? " Reasoning from this turn is not a reply."
    : "";
  return `The model stopped without a reply and without a tool call.${reasoning}`;
}
