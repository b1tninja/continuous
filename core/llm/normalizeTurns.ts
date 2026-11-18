import { CONVERSE_LEADING_USER_TEXT } from "@continuedev/openai-adapters";

import type {
  AssistantChatMessage,
  ChatMessage,
  MessageContent,
  MessagePart,
  ToolCallDelta,
  ToolResultChatMessage,
  UserChatMessage,
} from "../index.js";
import {
  CANCELLED_TOOL_CALL_MESSAGE,
  NO_TOOL_CALL_OUTPUT_MESSAGE,
} from "../tools/constants.js";

/**
 * The name of one repair `normalizeTurns` made. A history that needed none
 * is returned as it came.
 */
export type TurnRepair =
  /** `toolCalls: []` removed. */
  | "removed-empty-tool-calls"
  /** A tool call with no function name removed. */
  | "removed-unnamed-tool-call"
  /** A tool call with no id given `call_<message index>_<call index>`. */
  | "added-tool-call-id"
  /** A tool result with no id matched to the call that had none. */
  | "matched-tool-result-id"
  /** An assistant turn with no text, image or tool call dropped. */
  | "dropped-empty-assistant"
  /** Reasoning with no answer or tool call after it dropped. */
  | "dropped-orphan-thinking"
  /** A user turn with no text or image dropped. */
  | "dropped-empty-user"
  /** A tool call that had no result answered as cancelled. */
  | "added-cancelled-tool-result"
  /** A tool result that answers no call turned into user text. */
  | "orphan-tool-result-to-text"
  /** User text between a tool call and its results moved after the results. */
  | "moved-user-after-tool-results"
  /** Two turns of the same role in a row joined (`requiresAlternation`). */
  | "merged-same-role"
  /** A user turn put before a history that started with the model (`requiresAlternation`). */
  | "added-leading-user";

export interface NormalizeTurnsOptions {
  /**
   * The provider wants user and assistant turns to alternate and the
   * conversation to start with a user turn (Cohere, WatsonX, strict local
   * chat templates). Off by default: providers that merge turns themselves,
   * or accept turns of the same role in a row, are sent the history as it is.
   */
  requiresAlternation?: boolean;
}

export interface NormalizeTurnsResult {
  /** The input array itself when nothing was repaired. */
  messages: ChatMessage[];
  /** One entry per repair, in the order made. Empty when nothing was repaired. */
  repairs: TurnRepair[];
}

/**
 * Providers whose server, or the chat template it applies, wants turns to
 * alternate. Keyed by `providerName` (core) and `model.provider` (CLI).
 */
const ALTERNATING_PROVIDERS = new Set(["cohere", "watsonx", "vllm"]);

export function providerRequiresAlternation(
  provider: string | undefined,
): boolean {
  return !!provider && ALTERNATING_PROVIDERS.has(provider);
}

function contentIsBlank(content: MessageContent | null | undefined): boolean {
  if (content === null || content === undefined) {
    return true;
  }
  if (typeof content === "string") {
    return content.trim() === "";
  }
  return content.every(
    (part) => part.type === "text" && (part.text ?? "").trim() === "",
  );
}

function assistantHasSubstance(message: AssistantChatMessage): boolean {
  return !contentIsBlank(message.content) || !!message.toolCalls?.length;
}

function withoutToolCalls(message: AssistantChatMessage): AssistantChatMessage {
  const { toolCalls: _dropped, ...rest } = message;
  return rest;
}

/**
 * Rule 1: tool-call shape. Returns the message (the same object when it was
 * already well formed) and, in call order, the id given to each call that
 * had none (`undefined` for one that was removed), so the results the GUI
 * sent with no id can be matched to them.
 */
function tidyToolCalls(
  message: AssistantChatMessage,
  index: number,
  repairs: TurnRepair[],
): { message: AssistantChatMessage; idlessIds: (string | undefined)[] } {
  const calls = message.toolCalls;
  if (calls === undefined || calls === null) {
    return { message, idlessIds: [] };
  }
  if (calls.length === 0) {
    repairs.push("removed-empty-tool-calls");
    return { message: withoutToolCalls(message), idlessIds: [] };
  }
  let changed = false;
  const idlessIds: (string | undefined)[] = [];
  const kept: ToolCallDelta[] = [];
  calls.forEach((call, k) => {
    const named = !!call.function?.name;
    if (!call.id) {
      const id = named ? `call_${index}_${k}` : undefined;
      idlessIds.push(id);
      if (id) {
        repairs.push("added-tool-call-id");
        kept.push({ ...call, id });
      }
      if (!named) {
        repairs.push("removed-unnamed-tool-call");
      }
      changed = true;
      return;
    }
    if (!named) {
      repairs.push("removed-unnamed-tool-call");
      changed = true;
      return;
    }
    kept.push(call);
  });
  if (!changed) {
    return { message, idlessIds };
  }
  return {
    message:
      kept.length > 0
        ? { ...message, toolCalls: kept }
        : withoutToolCalls(message),
    idlessIds,
  };
}

/**
 * A tool result whose call is gone, as text. The same wording Bedrock uses
 * (`_convertMessages`, `repairConverseTurns`), so either repair gives the
 * same bytes.
 */
export function orphanToolResultText(
  toolCallId: string | undefined,
  content: unknown,
): string {
  const output =
    (typeof content === "string" ? content.trim() : "") ||
    NO_TOOL_CALL_OUTPUT_MESSAGE;
  return `Tool call output for Tool Call ID ${toolCallId || "unknown"}:\n\n${output}`;
}

function orphanResultToText(message: ToolResultChatMessage): UserChatMessage {
  return {
    role: "user",
    content: orphanToolResultText(message.toolCallId, message.content),
  };
}

function toParts(content: MessageContent): MessagePart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function joinContent(a: MessageContent, b: MessageContent): MessageContent {
  if (typeof a === "string" && typeof b === "string") {
    return `${a}\n\n${b}`;
  }
  return [...toParts(a), ...toParts(b)];
}

/**
 * Makes a history one every provider accepts, and leaves one that already is
 * alone: when nothing needs repair the input array itself is returned, so a
 * valid history is sent byte for byte as before and prompt caches keep
 * hitting. Never changes the messages it is given.
 *
 * In order:
 * 1. Tool calls: `toolCalls: []` removed, a call with no name removed, a call
 *    with no id given a deterministic one (and a result with no id matched to
 *    it, in order).
 * 2. An assistant turn with nothing in it is dropped, and reasoning with no
 *    answer or call after it (before the next user or tool turn) with it.
 *    Reasoning followed by an answer or a call is never touched: Anthropic
 *    wants signed reasoning kept with its tool_use.
 * 3. A user turn with nothing in it is dropped; at least one user turn stays.
 * 4. Pairing: each call gets its result in the turns right after it (a
 *    cancelled result when it has none), user text between a call and its
 *    results moves after them, and a result that answers no call becomes user
 *    text.
 * 5. With `requiresAlternation` only: turns of the same role in a row are
 *    joined, and a history that starts with the model gets a user turn first.
 *
 * See plans/research/provider-message-validity-audit.md.
 */
export function normalizeTurns(
  messages: ChatMessage[],
  options: NormalizeTurnsOptions = {},
): NormalizeTurnsResult {
  const repairs: TurnRepair[] = [];

  // 1. Tool-call shape
  const shaped: ChatMessage[] = [];
  let idless: (string | undefined)[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      const tidied = tidyToolCalls(message, index, repairs);
      idless = tidied.idlessIds;
      shaped.push(tidied.message);
    } else if (message.role === "tool" && !message.toolCallId) {
      const id = idless.shift();
      if (id) {
        repairs.push("matched-tool-result-id");
        shaped.push({ ...message, toolCallId: id });
      } else {
        shaped.push(message);
      }
    } else {
      shaped.push(message);
    }
  });

  // 2 and 3. Empty assistant turns, orphan reasoning, empty user turns
  const hasUserWithContent = shaped.some(
    (m) => m.role === "user" && !contentIsBlank(m.content),
  );
  let lastUser = -1;
  shaped.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  const kept: ChatMessage[] = [];
  shaped.forEach((message, i) => {
    if (message.role === "assistant") {
      if (assistantHasSubstance(message)) {
        kept.push(message);
      } else {
        repairs.push("dropped-empty-assistant");
      }
      return;
    }
    if (message.role === "thinking") {
      // Kept only when an answer or a call follows in the same model turn
      for (let j = i + 1; j < shaped.length; j++) {
        const next = shaped[j];
        if (next.role === "thinking") continue;
        if (next.role === "assistant") {
          if (assistantHasSubstance(next)) {
            kept.push(message);
            return;
          }
          continue;
        }
        break;
      }
      repairs.push("dropped-orphan-thinking");
      return;
    }
    if (message.role === "user" && contentIsBlank(message.content)) {
      if (!hasUserWithContent && i === lastUser) {
        kept.push(message);
      } else {
        repairs.push("dropped-empty-user");
      }
      return;
    }
    kept.push(message);
  });

  // 4. Pairing
  const paired: ChatMessage[] = [];
  for (let i = 0; i < kept.length;) {
    const message = kept[i];
    if (message.role === "assistant" && message.toolCalls?.length) {
      paired.push(message);
      const callIds = [...new Set(message.toolCalls.map((c) => c.id!))];
      const unanswered = new Set(callIds);
      const results: ChatMessage[] = [];
      const after: ChatMessage[] = [];
      let moved = false;
      let j = i + 1;
      for (; j < kept.length; j++) {
        const next = kept[j];
        if (next.role === "tool" && unanswered.has(next.toolCallId)) {
          unanswered.delete(next.toolCallId);
          results.push(next);
          if (after.length > 0) moved = true;
        } else if (next.role === "tool") {
          repairs.push("orphan-tool-result-to-text");
          after.push(orphanResultToText(next));
        } else if (next.role === "user" || next.role === "system") {
          after.push(next);
        } else {
          break;
        }
      }
      if (moved) repairs.push("moved-user-after-tool-results");
      paired.push(...results);
      for (const id of callIds) {
        if (unanswered.has(id)) {
          repairs.push("added-cancelled-tool-result");
          paired.push({
            role: "tool",
            content: CANCELLED_TOOL_CALL_MESSAGE,
            toolCallId: id,
          });
        }
      }
      paired.push(...after);
      i = j;
      continue;
    }
    if (message.role === "tool") {
      repairs.push("orphan-tool-result-to-text");
      paired.push(orphanResultToText(message));
    } else {
      paired.push(message);
    }
    i++;
  }

  // 5. Alternation, for the providers that need it
  let result = paired;
  if (options.requiresAlternation) {
    result = [];
    for (const message of paired) {
      const previous = result[result.length - 1];
      if (
        previous &&
        previous.role === message.role &&
        (message.role === "user" ||
          (message.role === "assistant" &&
            !(previous as AssistantChatMessage).toolCalls?.length))
      ) {
        repairs.push("merged-same-role");
        result[result.length - 1] = {
          ...message,
          ...previous,
          content: joinContent(
            previous.content as MessageContent,
            message.content as MessageContent,
          ),
          ...(message.role === "assistant" && message.toolCalls
            ? { toolCalls: message.toolCalls }
            : {}),
        } as ChatMessage;
        continue;
      }
      result.push(message);
    }
    const first = result.find((m) => m.role !== "system");
    if (first && first.role !== "user") {
      repairs.push("added-leading-user");
      const at = result.indexOf(first);
      result.splice(at, 0, {
        role: "user",
        content: CONVERSE_LEADING_USER_TEXT,
      });
    }
  }

  if (repairs.length === 0) {
    return { messages, repairs };
  }
  return { messages: result, repairs };
}
