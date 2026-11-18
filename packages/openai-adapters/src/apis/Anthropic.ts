import {
  ContentBlockParam,
  MessageCreateParams,
  MessageParam,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageDeltaEvent,
  RawMessageStartEvent,
  RawMessageStreamEvent,
  ImageBlockParam,
  TextBlockParam,
  Tool,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources";
import { streamSse } from "@continuedev/fetch";
import { OpenAI } from "openai/index";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPartRefusal,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
  CompletionUsage,
} from "openai/resources/index";
import { ChatCompletionCreateParams } from "openai/resources/index.js";
import { AnthropicConfig } from "../types.js";
import {
  chatChunk,
  chatChunkFromDelta,
  customFetch,
  usageChatChunk,
} from "../util.js";
import { EMPTY_CHAT_COMPLETION } from "../util/emptyChatCompletion.js";
import {
  noteSamplingOmitted,
  omitsSampling,
} from "./anthropicSamplingGuard.js";
import { safeParseArgs } from "../util/parseArgs.js";
import { extractBase64FromDataUrl } from "../util/url.js";
import {
  CACHING_STRATEGIES,
  CachingStrategyName,
} from "./AnthropicCachingStrategies.js";
import {
  addCacheControlToLastTwoUserMessages,
  stripCachePins,
  getAnthropicHeaders,
  getAnthropicMediaTypeFromDataUrl,
  openAiToolChoiceToAnthropicToolChoice,
  openaiToolToAnthropicTool,
} from "./AnthropicUtils.js";
import {
  applyAnthropicCacheTtl,
  AutoCacheTtl,
  CACHE_PIN_FIELD,
  isCachePinned,
  optsOutOfPromptCache,
  requestedCacheTtl,
} from "./cacheTtl.js";
import {
  claudeThinkingDisplayDefaultsToOmitted,
  claudeThinkingFields,
} from "./bedrockHelpers.js";
import {
  reasoningSwitch,
  requestedReasoningEffort,
  withoutReasoningEffort,
} from "./reasoningSwitch.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";

/**
 * The sampling fields Claude accepts: `temperature` and `top_p` together are
 * refused ("temperature and top_p cannot both be specified"), so only
 * `temperature` is kept when both are set; with thinking on, `temperature`
 * other than 1 and `top_p` below 0.95 are refused, so neither is sent. The
 * same rule as `bedrockSamplingParams` for Claude on Bedrock.
 */
export function anthropicSamplingParams(
  temperature: number | undefined,
  topP: number | undefined,
  reasoning: boolean,
): { temperature?: number; top_p?: number } {
  if (reasoning) return {};
  if (temperature !== undefined && topP !== undefined) return { temperature };
  return { temperature, top_p: topP };
}

/**
 * Anthropic's `stop_reason` as OpenAI's `finish_reason`, so a client can tell a
 * reply cut off at the output limit (max_tokens) from a finished one.
 */
export function anthropicFinishReason(
  stopReason: string | null | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (stopReason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      // end_turn, stop_sequence, pause_turn and anything newer
      return "stop";
  }
}

function orphanToolResultText(
  message: OpenAI.Chat.Completions.ChatCompletionToolMessageParam,
): string {
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
  return `Tool call output for Tool Call ID ${message.tool_call_id || "unknown"}:\n\n${text.trim() || "No tool output"}`;
}

/** A chunk that carries only reasoning fields. */
function reasoningChunk(
  model: string,
  reasoning: {
    reasoning_content?: string;
    reasoning_details?: Record<string, unknown>[];
  },
): ChatCompletionChunk {
  return chatChunkFromDelta({
    model,
    delta: reasoning as ChatCompletionChunk.Choice["delta"],
  });
}

/** Room left for the answer when a thinking budget raises max_tokens. */
const MIN_ANSWER_TOKENS = 4096;

/**
 * The thinking blocks an assistant message carries back to Claude, from its
 * `reasoning_details`, in order, by the rules core uses
 * (core/llm/llms/Anthropic.ts, "thinking" case): redacted thinking
 * (`reasoning.encrypted`) always; a signed entry as a thinking block with its
 * text, except for the models whose thinking display defaults to "omitted"
 * (Claude 4.7 and later, Fable, Mythos), whose blocks used to arrive empty and
 * were never sent back, so the conversation sent stays the one it was. A
 * signed entry without text (core sends the signature alone, and the text as
 * `reasoning_content` or `reasoning`) takes the message's reasoning text once.
 */
export function anthropicThinkingBlocks(
  message: unknown,
  model: string,
): ContentBlockParam[] {
  const msg = message as {
    reasoning_details?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
  };
  if (!Array.isArray(msg.reasoning_details)) return [];
  const replaySigned = !claudeThinkingDisplayDefaultsToOmitted(model);
  let fallbackText =
    (typeof msg.reasoning_content === "string" ? msg.reasoning_content : "") ||
    (typeof msg.reasoning === "string" ? msg.reasoning : "");
  const blocks: ContentBlockParam[] = [];
  for (const detail of msg.reasoning_details as Record<string, unknown>[]) {
    if (
      detail?.type === "reasoning.encrypted" &&
      typeof detail.data === "string" &&
      detail.data
    ) {
      blocks.push({ type: "redacted_thinking", data: detail.data });
      continue;
    }
    const signature = detail?.signature;
    if (!replaySigned || typeof signature !== "string" || !signature) {
      continue;
    }
    let text = typeof detail.text === "string" ? detail.text : "";
    if (!text) {
      text = fallbackText;
      fallbackText = "";
    }
    if (text) {
      blocks.push({ type: "thinking", thinking: text, signature });
    }
  }
  return blocks;
}

export class AnthropicApi implements BaseLlmApi {
  apiBase: string = "https://api.anthropic.com/v1/";

  /** Counts this instance's cached requests for `cacheBehavior.ttl: auto`. */
  private autoTtl = new AutoCacheTtl();

  constructor(
    protected config: AnthropicConfig & {
      cachingStrategy?: CachingStrategyName;
      // Only `ttl` is read: "1h" puts a 1-hour lifetime on the cache points,
      // "auto" decides per request (see AutoCacheTtl), anything else keeps the
      // 5-minute default.
      cacheBehavior?: { ttl?: "auto" | "5m" | "1h" };
    },
  ) {
    this.apiBase = config.apiBase ?? this.apiBase;
    if (!this.apiBase.endsWith("/")) {
      this.apiBase += "/";
    }
  }

  private _convertBody(oaiBody: ChatCompletionCreateParams) {
    // A side request (a session title) opts out of caching altogether
    const noCache = optsOutOfPromptCache(oaiBody);

    // Step 1: Convert to clean Anthropic body (no caching)
    const cleanBody = this._convertToCleanAnthropicBody(oaiBody);

    // Step 2: Apply caching strategy
    const strategyName = noCache
      ? "none"
      : (this.config.cachingStrategy ?? "systemAndTools");
    const cachingStrategy = CACHING_STRATEGIES[strategyName];
    const result = cachingStrategy(cleanBody);

    // Step 3: Cache last two user messages for conversation turn caching
    // Skip when caching is disabled
    if (strategyName !== "none") {
      addCacheControlToLastTwoUserMessages(result.messages);
    }
    // Our fork-point marks never reach the wire, caching or not.
    stripCachePins(result.messages);

    // Step 4: ask for a longer lifetime if the config says so. Unset, the
    // request is exactly what it was before.
    return applyAnthropicCacheTtl(
      result,
      requestedCacheTtl(
        this.config.cacheBehavior?.ttl,
        this.autoTtl,
        strategyName !== "none",
      ),
    );
  }

  private maxTokensForModel(model: string): number {
    if (model.includes("haiku")) {
      return 8192;
    }
    return 32_000;
  }

  public _convertToCleanAnthropicBody(
    oaiBody: ChatCompletionCreateParams,
  ): MessageCreateParams {
    let stop = undefined;
    if (oaiBody.stop && Array.isArray(oaiBody.stop)) {
      stop = oaiBody.stop.filter((x) => x.trim() !== "");
    } else if (typeof oaiBody.stop === "string" && oaiBody.stop.trim() !== "") {
      stop = [oaiBody.stop];
    }

    const systemMessage = this.systemBlocks(oaiBody.messages);

    // TODO support custom tools
    const functionTools = oaiBody.tools?.filter((t) => t.type === "function");
    let tools: Tool[] | undefined = undefined;

    if (
      oaiBody.tool_choice !== "none" &&
      functionTools &&
      functionTools.length > 0
    ) {
      if (
        typeof oaiBody.tool_choice !== "string" &&
        oaiBody.tool_choice?.type === "allowed_tools"
      ) {
        const allowedToolNames = new Set(
          oaiBody.tool_choice?.allowed_tools.tools.map(
            (tool) => tool["name"],
          ) ?? [],
        );
        const allowedTools = functionTools.filter((t) =>
          allowedToolNames.has(t.function.name),
        );
        tools = allowedTools.map(openaiToolToAnthropicTool);
      } else {
        tools = functionTools.map(openaiToolToAnthropicTool);
      }
    }

    const noSampling = omitsSampling(oaiBody.model, this.config.omitSampling);
    if (noSampling) {
      noteSamplingOmitted(oaiBody.model, this.config.omitSampling === true);
    }
    // The reasoning switch (reasoningSwitch.ts) as Claude's `thinking`, the
    // same fields core sends (getAnthropicThinkingParams)
    const { reasoning, budgetTokens } = reasoningSwitch(
      requestedReasoningEffort(
        oaiBody,
        this.config.requestOptions?.extraBodyProperties,
      ),
    );
    const thinking = claudeThinkingFields(
      oaiBody.model,
      reasoning,
      budgetTokens,
    );
    // max_tokens is required
    let maxTokens = oaiBody.max_tokens ?? this.maxTokensForModel(oaiBody.model);
    if (
      thinking.thinking?.type === "enabled" &&
      maxTokens <= thinking.thinking.budget_tokens
    ) {
      // A thinking budget must be below max_tokens, or the request is refused
      maxTokens = thinking.thinking.budget_tokens + MIN_ANSWER_TOKENS;
    }
    const anthropicBody = {
      messages: this._convertMessages(
        oaiBody.messages.filter(
          (msg) => msg.role !== "system" && msg.role !== "developer",
        ),
        oaiBody.model,
      ),
      system: systemMessage,
      // With thinking on, Claude refuses most sampling values
      ...(noSampling
        ? {}
        : anthropicSamplingParams(
            oaiBody.temperature ?? undefined,
            oaiBody.top_p ?? undefined,
            thinking.thinking !== undefined,
          )),
      max_tokens: maxTokens,
      model: oaiBody.model,
      stop_sequences: stop,
      stream: oaiBody.stream ?? undefined,
      tools,
      tool_choice: openAiToolChoiceToAnthropicToolChoice(oaiBody.tool_choice),
      // The pinned SDK types have no adaptive thinking or output_config
      ...thinking,
    } as MessageCreateParams;

    return anthropicBody;
  }

  private convertToolCallsToBlocks(
    toolCall: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall,
  ): ToolUseBlockParam | undefined {
    const toolCallId = toolCall.id;
    const toolName = toolCall.function?.name;
    if (toolCallId && toolName) {
      return {
        type: "tool_use",
        id: toolCallId,
        name: toolName,
        input: safeParseArgs(
          toolCall.function.arguments,
          `${toolName} ${toolCallId}`,
        ),
      };
    }
  }

  // 1. ignores empty content
  // 2. converts string content to text parts
  // 3. converts text and refusal parts to text blocks
  // 4. converts image parts to image blocks
  private convertMessageContentToBlocks(
    content:
      | string
      | OpenAI.Chat.Completions.ChatCompletionContentPart[]
      | (ChatCompletionContentPartText | ChatCompletionContentPartRefusal)[],
  ): ContentBlockParam[] {
    const blocks: ContentBlockParam[] = [];
    if (typeof content === "string") {
      if (content) {
        blocks.push({
          type: "text",
          text: content,
        });
      }
    } else {
      const supportedParts = content.filter(
        (p) =>
          p.type === "text" || p.type === "image_url" || p.type === "refusal",
      );
      for (const part of supportedParts) {
        if (part.type === "image_url") {
          const dataUrl = part.image_url.url;
          if (dataUrl?.startsWith("data:")) {
            const base64Data = extractBase64FromDataUrl(dataUrl);
            if (base64Data) {
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: getAnthropicMediaTypeFromDataUrl(dataUrl),
                  data: base64Data,
                },
              });
            } else {
              console.warn(
                "Anthropic: skipping image with invalid data URL format",
              );
            }
          } else if (dataUrl) {
            console.warn(
              "Anthropic: skipping an image URL that is not a data URL. The image was left out of the request.",
            );
          }
        } else {
          const text = part.type === "text" ? part.text : part.refusal;
          if (text) {
            // A caller (Vertex AI in core) may have marked the part with
            // Anthropic's cache_control; keep it.
            const cache_control = (part as any).cache_control;
            blocks.push({
              type: "text",
              text,
              ...(cache_control ? { cache_control } : {}),
            });
          }
        }
      }
    }
    return blocks;
  }

  private systemBlocks(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ): MessageCreateParams["system"] {
    const blocks: Array<{
      type: "text";
      text: string;
      cache_control?: unknown;
    }> = [];
    for (const msg of messages) {
      if (msg.role !== "system" && msg.role !== "developer") {
        continue;
      }
      const content = msg.content;
      if (typeof content === "string") {
        if (content) {
          blocks.push({ type: "text", text: content });
        }
        continue;
      }
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content) {
        if (part.type === "text" && part.text) {
          const cache_control = (part as { cache_control?: unknown })
            .cache_control;
          blocks.push({
            type: "text",
            text: part.text,
            ...(cache_control ? { cache_control } : {}),
          });
        } else if (
          "refusal" in part &&
          typeof part.refusal === "string" &&
          part.refusal
        ) {
          blocks.push({ type: "text", text: part.refusal });
        }
      }
    }
    return blocks.length
      ? (blocks as MessageCreateParams["system"])
      : undefined;
  }

  private toolResultContent(
    content:
      string | OpenAI.Chat.Completions.ChatCompletionContentPart[] | null,
  ): string | Array<TextBlockParam | ImageBlockParam> {
    if (typeof content === "string" || content == null) {
      return content ?? "";
    }
    return this.convertMessageContentToBlocks(content).filter(
      (block): block is TextBlockParam | ImageBlockParam =>
        block.type === "text" || block.type === "image",
    );
  }

  private getContentBlocksFromChatMessage(
    message: OpenAI.Chat.Completions.ChatCompletionMessageParam,
    model: string,
  ): ContentBlockParam[] {
    switch (message.role) {
      // One tool message = one tool_result block
      case "tool":
        return [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: this.toolResultContent(message.content),
            // Tool messages carry cache_control on the message itself.
            ...((message as any).cache_control
              ? { cache_control: (message as any).cache_control }
              : {}),
          },
        ];
      case "user":
        return this.convertMessageContentToBlocks(message.content);
      case "assistant":
        // Thinking first, as Claude returned it
        const blocks: ContentBlockParam[] = [
          ...anthropicThinkingBlocks(message, model),
          ...(message.content
            ? this.convertMessageContentToBlocks(message.content)
            : []),
        ];
        // If any tool calls are present, always put them last
        // Loses order vs what was originally sent, but they typically come last
        for (const toolCall of message.tool_calls ?? []) {
          if (toolCall.type !== "function") {
            // TODO support custom tool calls
            continue;
          }
          const block = this.convertToolCallsToBlocks(toolCall);
          if (block) {
            blocks.push(block);
          }
        }
        return blocks;
      // system, etc.
      default:
        return [];
    }
  }

  private _convertMessages(
    msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    model: string,
  ): MessageParam[] {
    const nonSystemMessages = msgs.filter(
      (m) => m.role !== "system" && m.role !== "developer",
    );

    const convertedMessages: MessageParam[] = [];
    let currentRole: "user" | "assistant" | undefined = undefined;
    let currentParts: ContentBlockParam[] = [];

    const flushCurrentMessage = () => {
      if (currentRole && currentParts.length > 0) {
        convertedMessages.push({
          role: currentRole,
          content: currentParts,
        });
        currentParts = [];
      }
    };

    // A tool_result must answer a tool_use that was sent. One whose call was
    // left out (no id or name) goes as text instead of a 400, in the words
    // Bedrock uses for the same case.
    const sentToolUseIds = new Set<string>();
    for (const message of nonSystemMessages) {
      const newRole =
        message.role === "user" || message.role === "tool"
          ? "user"
          : "assistant";
      if (currentRole !== newRole) {
        flushCurrentMessage();
        currentRole = newRole;
      }
      const blocks: ContentBlockParam[] =
        message.role === "tool" && !sentToolUseIds.has(message.tool_call_id)
          ? [{ type: "text", text: orphanToolResultText(message) }]
          : this.getContentBlocksFromChatMessage(message, model);
      for (const block of blocks) {
        if (block.type === "tool_use") sentToolUseIds.add(block.id);
      }
      currentParts.push(...blocks);
      // A pinned message (CACHE_PIN_FIELD, a fork point): its last block takes
      // the mark, and the caching step turns it into a marker or strips it.
      if (isCachePinned(message) && currentParts.length > 0) {
        (
          currentParts[currentParts.length - 1] as unknown as Record<
            string,
            unknown
          >
        )[CACHE_PIN_FIELD] = true;
      }
    }
    flushCurrentMessage();

    return convertedMessages;
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    const response = await customFetch(
      withoutReasoningEffort(this.config.requestOptions),
    )(new URL("messages", this.apiBase), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(this._convertBody(body)),
      signal,
    });

    if (response.status === 499) {
      return EMPTY_CHAT_COMPLETION;
    }

    const completion = await response.json();

    const usage: Record<string, number> | undefined = completion.usage;
    const finishReason = anthropicFinishReason(completion.stop_reason);
    // With thinking on the first block is the thinking, not the answer
    const text: string = Array.isArray(completion.content)
      ? completion.content
          .filter((block: { type?: string }) => block?.type === "text")
          .map((block: { text?: string }) => block.text ?? "")
          .join("")
      : "";
    return {
      id: completion.id,
      object: "chat.completion",
      model: body.model,
      created: Math.floor(Date.now() / 1000),
      usage: {
        total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        completion_tokens: usage?.output_tokens ?? 0,
        prompt_tokens: usage?.input_tokens ?? 0,
        prompt_tokens_details: {
          cached_tokens: usage?.cache_read_input_tokens ?? 0,
          cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
          cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
        } as any,
      },
      choices: [
        {
          logprobs: null,
          finish_reason: finishReason,
          message: {
            role: "assistant",
            content: text,
            // A refusal keeps its text in `content` too, which is what callers
            // of this adapter read today.
            refusal: finishReason === "content_filter" ? text || null : null,
          },
          index: 0,
        },
      ],
    };
  }

  // This is split off so e.g. VertexAI can use it
  async *handleStreamResponse(
    response: any,
    model: string,
    signal?: AbortSignal,
  ) {
    let lastToolUseId: string | undefined;
    let lastToolUseName: string | undefined;
    // Set while a content block has started (or streamed) and not stopped.
    let blockOpen = false;
    let sawStop = false;
    let stopReason: string | undefined;

    const usage: CompletionUsage = {
      completion_tokens: 0,
      prompt_tokens: 0,
      total_tokens: 0,
    };
    for await (const event of streamSse(response)) {
      // https://docs.anthropic.com/en/api/messages-streaming#event-types
      const rawEvent = event as RawMessageStreamEvent;
      switch (rawEvent.type) {
        case "content_block_start":
          const blockStartEvent = rawEvent as RawContentBlockStartEvent;
          blockOpen = true;
          if (blockStartEvent.content_block.type === "tool_use") {
            lastToolUseId = blockStartEvent.content_block.id;
            lastToolUseName = blockStartEvent.content_block.name;
          }
          // Redacted thinking has no text; it goes back to Claude as it came
          if (blockStartEvent.content_block.type === "redacted_thinking") {
            yield reasoningChunk(model, {
              reasoning_details: [
                {
                  type: "reasoning.encrypted",
                  data: blockStartEvent.content_block.data,
                },
              ],
            });
          }
          break;
        case "message_start":
          const startEvent = rawEvent as RawMessageStartEvent;
          usage.prompt_tokens = startEvent.message.usage?.input_tokens ?? 0;
          usage.prompt_tokens_details = {
            cache_write_tokens:
              startEvent.message.usage?.cache_creation_input_tokens ?? 0,
            cache_read_tokens:
              startEvent.message.usage?.cache_read_input_tokens ?? 0,
            cached_tokens:
              startEvent.message.usage?.cache_read_input_tokens ?? 0,
          } as any;
          break;
        case "message_delta":
          const deltaEvent = rawEvent as RawMessageDeltaEvent;
          if (deltaEvent.delta?.stop_reason) {
            sawStop = true;
            stopReason = deltaEvent.delta.stop_reason;
          }
          usage.completion_tokens = deltaEvent.usage?.output_tokens ?? 0;
          break;
        case "content_block_delta":
          // https://docs.anthropic.com/en/api/messages-streaming#delta-types
          const blockDeltaEvent = rawEvent as RawContentBlockDeltaEvent;
          blockOpen = true;
          switch (blockDeltaEvent.delta.type) {
            case "text_delta":
              yield chatChunk({
                content: blockDeltaEvent.delta.text,
                model,
              });
              break;
            // Thinking as the reasoning fields core's chunk reader and the
            // CLI read: text as reasoning_content, the signature in
            // reasoning_details (the same shape as the Bedrock adapter's)
            case "thinking_delta":
              if (blockDeltaEvent.delta.thinking) {
                yield reasoningChunk(model, {
                  reasoning_content: blockDeltaEvent.delta.thinking,
                });
              }
              break;
            case "signature_delta":
              yield reasoningChunk(model, {
                reasoning_details: [
                  { signature: blockDeltaEvent.delta.signature },
                ],
              });
              break;
            case "input_json_delta":
              if (!lastToolUseId || !lastToolUseName) {
                throw new Error("No tool use found");
              }
              yield chatChunkFromDelta({
                model,
                delta: {
                  tool_calls: [
                    {
                      id: lastToolUseId,
                      type: "function",
                      index: 0,
                      function: {
                        name: lastToolUseName,
                        arguments: blockDeltaEvent.delta.partial_json,
                      },
                    },
                  ],
                },
              });
              break;
          }
          break;
        case "content_block_stop":
          blockOpen = false;
          lastToolUseId = undefined;
          lastToolUseName = undefined;
          break;
        case "message_stop":
          sawStop = true;
          break;
        default:
          break;
      }
    }

    // A proxy that closes the stream cleanly mid-reply leaves a content block
    // open with neither a stop_reason nor message_stop. Say so instead of
    // returning a short reply as if it were complete.
    // When the user stops the reply the body read ends quietly too
    // (streamResponse swallows the AbortError); that is not a cut-off.
    if (blockOpen && !sawStop && !signal?.aborted) {
      throw new Error(
        "The Anthropic stream ended before the response was complete (no message_stop).",
      );
    }

    // Why the reply ended, on a chunk with an empty delta (as Bedrock does).
    if (stopReason) {
      yield chatChunkFromDelta({
        model,
        delta: {},
        finish_reason: anthropicFinishReason(stopReason),
      });
    }

    yield usageChatChunk({
      model,
      usage: {
        ...usage,
        total_tokens: usage.completion_tokens + usage.prompt_tokens,
      },
    });
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const response = await customFetch(
      withoutReasoningEffort(this.config.requestOptions),
    )(new URL("messages", this.apiBase), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(this._convertBody(body)),
      signal,
    });
    yield* this.handleStreamResponse(response, body.model, signal);
  }

  private getHeaders(): Record<string, string> {
    const enableCaching = this.config?.cachingStrategy !== "none";
    return getAnthropicHeaders(this.config.apiKey, enableCaching, this.apiBase);
  }

  async completionNonStream(
    body: CompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<Completion> {
    throw new Error("Method not implemented.");
  }
  async *completionStream(
    body: CompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<Completion> {
    throw new Error("Method not implemented.");
  }
  async *fimStream(
    body: FimCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    throw new Error("Method not implemented.");
  }

  async embed(
    body: OpenAI.Embeddings.EmbeddingCreateParams,
  ): Promise<OpenAI.Embeddings.CreateEmbeddingResponse> {
    throw new Error("Method not implemented.");
  }

  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    throw new Error("Method not implemented.");
  }

  list(): Promise<OpenAI.Models.Model[]> {
    throw new Error("Method not implemented.");
  }
}
