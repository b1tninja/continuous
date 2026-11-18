import { type ModelConfig, withToolDialect } from "@continuedev/config-yaml";
import { CACHE_PIN_FIELD } from "@continuedev/openai-adapters";
import type { ChatHistoryItem, ChatMessage } from "core/index.js";
import {
  normalizeTurns,
  providerRequiresAlternation,
} from "core/llm/normalizeTurns.js";
import { withTurnTail } from "core/llm/prompts/usePrompts.js";
import {
  chatMessagesFromUnifiedHistory,
  convertChatMessagesToOpenAI,
  convertFromUnifiedMessage,
} from "core/util/messageConversion.js";
import { providerRecoversText } from "core/util/toolDialectLeak.js";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources.mjs";

import { getRequestBodyHints } from "../contextManagement.js";
import { withEnvironmentBlock } from "../environmentContext.js";

import { getDefaultCompletionOptions } from "./streamChatResponse.types.js";

/**
 * The chat request the CLI sends for one model call, built from the pieces
 * `processStreamingResponse` has already validated and pruned. A pure
 * function, so a test can build the requests of consecutive turns and check
 * that everything before the provider's cache point stays byte-identical
 * (prefixStability.test.ts).
 *
 * Order matters for the prompt cache: the system message first, then the
 * history, and the task list block last, as its own user message, so a change
 * to the list changes only the tail of the request and the Bedrock adapter can
 * put its cache point before it. The date and git status go on the first user
 * message (`withEnvironmentBlock`), after the system checkpoint, so the system
 * text is the same across sessions. The use's tail goes last on every user
 * message (`withTurnTail`), the same line each time, so a message's bytes
 * never change between requests and the cache markers on the last two user
 * messages keep matching (core/llm/prompts/usePrompts.ts).
 */
/**
 * Providers whose adapters build their own request body and read
 * CACHE_PIN_FIELD. Every other adapter passes the messages on to the provider,
 * which would reject the unknown field, so the mark is set for these only.
 */
const PIN_PROVIDERS = new Set(["bedrock", "anthropic"]);

/**
 * How many messages are sent ahead of the first one history item `item`
 * produced. A message normalizeTurns added or rewrote counts as part of the
 * item before it; a reasoning turn is not sent.
 */
function sentBeforeItem(
  history: { messages: ChatMessage[]; itemIndex: number[] },
  conversation: ChatMessage[],
  item: number,
): number {
  const origin = new Map(
    history.messages.map((message, i) => [message, history.itemIndex[i]]),
  );
  let from = -1;
  let sent = 0;
  for (const message of conversation) {
    from = origin.get(message) ?? from;
    if (from >= item) break;
    if (message.role !== "thinking") sent++;
  }
  return sent;
}

/**
 * Providers that need a reply's reasoning back on the next request, and in
 * which field. Claude (on Anthropic's API and Vertex) needs its signed and
 * redacted thinking: with thinking on, a tool call's turn is refused without
 * it. The adapter decides which blocks Claude reads (anthropicThinkingBlocks:
 * the same rules as core). DeepSeek refuses a request with tools unless every
 * assistant message carries its `reasoning_content` (empty when it had none),
 * as core sends it (openaiTypeConverters.ts).
 */
const REASONING_REPLAY: Record<string, "details" | "content"> = {
  anthropic: "details",
  vertexai: "details",
  deepseek: "content",
};

/**
 * Providers whose adapter turns `reasoning_effort` into the provider's own
 * reasoning switch (packages/openai-adapters/src/apis/reasoningSwitch.ts).
 * Other OpenAI-compatible servers get no new field.
 */
const REASONING_SWITCH_PROVIDERS = new Set([
  "anthropic",
  "vertexai",
  "gemini",
  "openrouter",
  "deepseek",
  "bedrock",
]);

/**
 * The model's `defaultCompletionOptions.reasoning` as the adapters' switch:
 * `none` when off, else the effort for `reasoningBudgetTokens` (low up to
 * 1024, medium up to 4096, high above; 2048 when unset, as in the IDE).
 * Nothing when the config says nothing, when a `reasoning_effort` is already
 * in the model's extra body fields (a catalog variant, or the use's
 * `modeModels` effort: those win), or for a provider whose adapter does not
 * read the switch (OpenAI only on its own API).
 */
export function reasoningEffortForModel(
  model: ModelConfig,
): "none" | "low" | "medium" | "high" | undefined {
  const reasoning = model.defaultCompletionOptions?.reasoning;
  if (reasoning === undefined) return undefined;
  if (model.requestOptions?.extraBodyProperties?.reasoning_effort) {
    return undefined;
  }
  const officialOpenAI =
    model.provider === "openai" &&
    (!model.apiBase || /^https:\/\/api\.openai\.com\//.test(model.apiBase));
  if (!officialOpenAI && !REASONING_SWITCH_PROVIDERS.has(model.provider)) {
    return undefined;
  }
  if (!reasoning) return "none";
  const budget = model.defaultCompletionOptions?.reasoningBudgetTokens ?? 2048;
  return budget <= 1024 ? "low" : budget <= 4096 ? "medium" : "high";
}

/**
 * Marks each assistant message the history gives with the item it came from,
 * on a copy (the history itself is not changed), so the reply's reasoning can
 * be put back on the message it produced after normalizeTurns has dropped,
 * added or rewritten turns. The mark is a symbol: a repaired copy keeps it
 * (object spread copies symbol keys), and it never reaches the request.
 */
const REASONING_SOURCE = Symbol("reasoningSource");

function markReasoningSources(
  provider: string,
  chatHistory: ChatHistoryItem[],
  history: { messages: ChatMessage[]; itemIndex: number[] },
): void {
  if (!REASONING_REPLAY[provider]) return;
  history.messages.forEach((message, i) => {
    const item = chatHistory[history.itemIndex[i]];
    if (message.role === "assistant" && item?.message === message) {
      history.messages[i] = {
        ...message,
        [REASONING_SOURCE]: item,
      } as ChatMessage;
    }
  });
}

/**
 * The conversation in the OpenAI format (reasoning turns left out), with each
 * assistant reply's reasoning on the message it produced, in the field its
 * provider reads back (REASONING_REPLAY).
 */
function convertWithReplayedReasoning(
  provider: string,
  conversation: ChatMessage[],
): ReturnType<typeof convertChatMessagesToOpenAI> {
  const field = REASONING_REPLAY[provider];
  if (!field) return convertChatMessagesToOpenAI(conversation);
  const converted: ReturnType<typeof convertChatMessagesToOpenAI> = [];
  for (const message of conversation) {
    const openai = convertFromUnifiedMessage(message);
    if (!openai) continue;
    if (message.role === "assistant") {
      const item = (message as unknown as Record<symbol, unknown>)[
        REASONING_SOURCE
      ] as ChatHistoryItem | undefined;
      const target = openai as unknown as Record<string, unknown>;
      if (field === "content") {
        target.reasoning_content = item?.reasoning?.text ?? "";
      } else if (item?.reasoning?.details?.length) {
        target.reasoning_details = item.reasoning.details;
      }
    }
    converted.push(openai);
  }
  return converted;
}

export function buildChatRequestBody(args: {
  model: ModelConfig;
  chatHistory: ChatHistoryItem[];
  systemMessage: string;
  tools?: ChatCompletionTool[];
  /** The session's task list block, or empty when none is sent. */
  taskListBlock?: string;
  /** A compaction summary is never continued, so it is a one-shot request. */
  isCompacting?: boolean;
  /** The use's tail (`modeModels.<use>.tail`), appended to every user message. */
  turnTail?: string;
}): ChatCompletionCreateParamsStreaming {
  const { model, chatHistory, systemMessage, tools, taskListBlock } = args;
  // The history as a conversation every provider accepts: an aborted or
  // empty turn dropped, reasoning left out, every tool call answered
  // (core/llm/normalizeTurns.ts). A valid history comes back as it is, so the
  // request is byte-identical and the prompt cache keeps hitting.
  const history = chatMessagesFromUnifiedHistory(chatHistory);
  markReasoningSources(model.provider, chatHistory, history);
  const conversation = normalizeTurns(history.messages, {
    requiresAlternation: providerRequiresAlternation(model.provider),
  }).messages;
  const messages = withTurnTail(
    withEnvironmentBlock([
      { role: "system", content: systemMessage },
      ...convertWithReplayedReasoning(model.provider, conversation),
    ] as ChatCompletionMessageParam[]),
    args.turnTail,
  );
  const reasoningEffort = reasoningEffortForModel(model);
  if (taskListBlock) {
    messages.push({ role: "user", content: taskListBlock });
  }
  // A history item marked as a fork point (ChatHistoryItem.cachePin) becomes
  // the mark on the first message it produced: index 0 is the system message,
  // then the messages the items before it produce.
  const pinAt = chatHistory.findIndex((item) => item.cachePin);
  if (pinAt >= 0 && PIN_PROVIDERS.has(model.provider)) {
    const index = 1 + sentBeforeItem(history, conversation, pinAt);
    const pinned = messages[index] as unknown as
      Record<string, unknown> | undefined;
    if (pinned) pinned[CACHE_PIN_FIELD] = true;
  }
  return {
    model: model.model,
    messages,
    stream: true,
    tools,
    ...getDefaultCompletionOptions(model.defaultCompletionOptions),
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    ...getRequestBodyHints(
      model,
      args.isCompacting ? "oneShot" : "conversation",
    ),
    // The model's `toolDialect`, as the recovery switch the Bedrock and
    // OpenAI-compatible adapters read from the body (and remove). Nothing is added without one, or with the
    // CONTINUE_RECOVER_TEXT_TOOL_CALLS variable set (it wins).
    ...(providerRecoversText(model.provider, "cli")
      ? withToolDialect({}, model.toolDialect)
      : {}),
  } as ChatCompletionCreateParamsStreaming;
}
