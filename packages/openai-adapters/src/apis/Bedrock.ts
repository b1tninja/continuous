import {
  BedrockRuntimeClient,
  ContentBlock,
  ContentBlockStart,
  ConversationRole,
  ConverseCommand,
  ConverseCommandOutput,
  ConverseStreamCommand,
  ConverseStreamCommandInput,
  ImageFormat,
  InvokeModelCommand,
  Message,
  ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { OpenAI } from "openai/index";
import { v4 as uuidv4 } from "uuid";

import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPartImage,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageFunctionToolCall,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  Model,
} from "openai/resources/index";

import {
  bedrockRefusedField,
  converseRequestHasField,
  converseRequestWithoutField,
} from "@continuedev/llm-info";
import { holdChunk } from "../dialects/holdSignal.js";
import type { RecoveredCall } from "../dialects/qwenXml.js";
import {
  createTextToolRecovery,
  dialectToolsFromConverse,
  recoveredCallId,
  recoverFromText,
  type TextToolRecovery,
} from "../dialects/recovery.js";
import {
  applyCrossRegionInference,
  bedrockCachePartsForModel,
  bedrockCachePoint,
  bedrockCachePointAfterTextOnly,
  bedrockCacheTtl,
  bedrockFinishReason,
  bedrockMinMaxTokens,
  bedrockModelAccessMessage,
  bedrockOmitUnsupportedInference,
  bedrockReasoningFields,
  bedrockRepairsStreamedToolInput,
  bedrockSamplingParams,
  bedrockStreamsToolInputCleanly,
  bedrockToolsNeedNonStreaming,
  bedrockUsageToCompletionUsage,
  cleanReplyText,
  createThinkingTagSplitter,
  crossRegionFallbackModelId,
  effortToBudgetTokens,
  fillMissingToolResults,
  flushDsmlHold,
  getBedrockErrorHint,
  holdBackDsmlMarker,
  isInvalidModelIdentifierError,
  isStreamingToolUseUnsupportedError,
  leaksDsmlMarker,
  normalizeToolUseIds,
  repairConverseTurns,
  repairStreamedToolInput,
  ThinkingSplit,
  ToolInputGate,
  toolSchemaKeys,
} from "./bedrockHelpers.js";

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { fromStatic } from "@aws-sdk/token-providers";
import {
  createAgentForUrl,
  defaultUseSystemCa,
  getTlsErrorHint,
  needsCustomAgent,
} from "@continuedev/fetch";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { BedrockConfig } from "../types.js";
import {
  chatChunk,
  chatChunkFromDelta,
  embedding,
  rerank,
  usageChatChunk,
} from "../util.js";
import { safeParseArgs } from "../util/parseArgs.js";
import { parseDataUrl } from "../util/url.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";
import {
  AutoCacheTtl,
  isCachePinned,
  optsOutOfPromptCache,
  requestedCacheTtl,
} from "./cacheTtl.js";
import { recordFieldFallback, refusedFields } from "./fieldFallbacks.js";

import {
  isTaskListBlockText,
  TASK_LIST_BLOCK_OPEN,
} from "../util/taskListBlock.js";

// Re-exported for the check in core/util/taskPlan.vitest.ts.
export { TASK_LIST_BLOCK_OPEN };

/**
 * Prefixed model IDs (`us.qwen...`) that Bedrock refused as invalid in this
 * process because the model is only offered on demand. Requests for them go
 * out with the bare ID from then on.
 */
const modelsWithoutInferencePrefix = new Set<string>();

/**
 * Models that answered a ConverseStream request with tools with "This model
 * doesn't support tool use in streaming mode." in this process. Their
 * requests with tools go through Converse from then on, like the models in
 * bedrockToolsNeedNonStreaming.
 */
const modelsWithoutStreamingTools = new Set<string>();

/** The request without the fields this model refused earlier in the process (`refusedFields`). */
function withoutRefusedFields(
  input: ConverseStreamCommandInput,
): ConverseStreamCommandInput {
  let request = input;
  for (const field of refusedFields(input.modelId ?? "")) {
    request = converseRequestWithoutField(request, field);
  }
  return request;
}

/** Nova 2 returns this in place of its reasoning text; the tokens are billed. */
const NOVA_REDACTED_REASONING = "[REDACTED].";

/** A chunk delta with the reasoning fields core's chunk reader understands. */
type ReasoningDelta = ChatCompletionChunk.Choice["delta"] & {
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
};

/** The reasoning fields of a Converse reasoning block or stream delta. */
interface ReasoningLike {
  text?: string;
  signature?: string;
  redactedContent?: Uint8Array;
}

/**
 * Reasoning as the OpenAI-style fields core's chunk reader takes: text as
 * reasoning_content, the signature and redacted bytes in reasoning_details
 * (the signature is read from its first entry). Nova 2's placeholder text
 * is redacted thinking, not a thought.
 */
function reasoningDeltaFor(
  reasoning: ReasoningLike,
  isNova2: boolean,
): ReasoningDelta | undefined {
  if (reasoning.redactedContent) {
    return {
      reasoning_details: [
        {
          type: "reasoning.encrypted",
          data: Buffer.from(reasoning.redactedContent).toString("base64"),
        },
      ],
    };
  }
  if (reasoning.text !== undefined) {
    return isNova2 && reasoning.text === NOVA_REDACTED_REASONING
      ? {
          reasoning_details: [
            { type: "reasoning.encrypted", data: reasoning.text },
          ],
        }
      : { reasoning_content: reasoning.text };
  }
  if (reasoning.signature) {
    return { reasoning_details: [{ signature: reasoning.signature }] };
  }
  return undefined;
}

/**
 * Interface for tool use state tracking
 */
interface ToolUseState {
  toolUseId: string;
  name: string;
  input: string;
}

/** A recovered call as one OpenAI-style tool_calls chunk. */
function recoveredCallChunk(
  call: RecoveredCall,
  index: number,
  model: string,
  id: string | undefined,
): ChatCompletionChunk {
  return chatChunkFromDelta({
    model,
    id,
    delta: {
      tool_calls: [
        {
          index,
          id: recoveredCallId(index),
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        },
      ],
    },
  });
}

export class BedrockApi implements BaseLlmApi {
  /** Counts this instance's cached requests for `cacheBehavior.ttl: auto`. */
  private autoTtl = new AutoCacheTtl();

  constructor(protected config: BedrockConfig) {
    if (config.env?.accessKeyId || config?.env?.secretAccessKey) {
      if (!config.env?.accessKeyId) {
        throw new Error(
          "accessKeyId is required for Bedrock API. Only found secretAccessKey",
        );
      }
      if (!config.env?.secretAccessKey) {
        throw new Error(
          "secretAccessKey is required for Bedrock API. Only found accessKeyId",
        );
      }
    }
  }

  /** Seam over the AWS SDK credential chain (overridden in tests). */
  protected async credentialChain(profile: string | undefined) {
    return fromNodeProviderChain({ profile, ignoreCache: true })();
  }

  private withHint(e: unknown): unknown {
    if (!(e instanceof Error)) return e;
    const hint = getBedrockErrorHint(e, {
      profile: this.config.env?.profile,
      region: this.config.env?.region,
    });
    if (hint && !e.message.includes(hint)) {
      e.message = `${e.message}\n\n${hint}`;
    }
    return e;
  }

  async getCreds() {
    const env = this.config.env;
    if (env?.accessKeyId && env?.secretAccessKey) {
      return {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
        ...(env.sessionToken ? { sessionToken: env.sessionToken } : {}),
      };
    }
    try {
      if (env?.profile) {
        // Explicitly requested profile: never silently use another one.
        return await this.credentialChain(env.profile);
      }
      // Nothing configured: legacy "bedrock" profile, then the standard chain.
      try {
        return await this.credentialChain("bedrock");
      } catch {
        return await this.credentialChain(undefined);
      }
    } catch (e) {
      throw this.withHint(e);
    }
  }

  /** Service tier, latency mode and guardrail settings from config. */
  private extraConverseFields(): Record<string, unknown> {
    const env = this.config.env;
    return {
      ...(env?.serviceTier ? { serviceTier: { type: env.serviceTier } } : {}),
      ...(env?.latency ? { performanceConfig: { latency: env.latency } } : {}),
      ...(env?.guardrailIdentifier
        ? {
            guardrailConfig: {
              guardrailIdentifier: env.guardrailIdentifier,
              guardrailVersion: env.guardrailVersion ?? "DRAFT",
            },
          }
        : {}),
    };
  }

  private resolveApiKey(): string | undefined {
    if (this.config.apiKey) return this.config.apiKey;
    const env = this.config.env;
    if ((env?.accessKeyId && env?.secretAccessKey) || env?.profile) {
      return undefined;
    }
    return process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
  }

  private requestHandler?: Promise<NodeHttpHandler | undefined>;

  /**
   * Applies `requestOptions` (proxy, CA bundle, system CA store, client
   * certificate, verifySsl) to the AWS SDK, which otherwise ignores them.
   * Undefined when nothing needs customising.
   */
  private getRequestHandler(): Promise<NodeHttpHandler | undefined> {
    this.requestHandler ??= (async () => {
      const region = this.config.env?.region ?? "us-east-1";
      const url = new URL(`https://bedrock-runtime.${region}.amazonaws.com`);
      const options = this.config.requestOptions;
      if (!needsCustomAgent(url, options, defaultUseSystemCa())) {
        return undefined;
      }
      const { agent } = await createAgentForUrl(url, options);
      return new NodeHttpHandler({ httpsAgent: agent });
    })();
    return this.requestHandler;
  }

  async getClient(): Promise<BedrockRuntimeClient> {
    const region = this.config.env?.region;
    const requestHandler = await this.getRequestHandler();
    const networking = {
      ...(requestHandler ? { requestHandler } : {}),
      // maxRetries (see BaseConfig) as the SDK's attempts, the first included
      ...(this.config.maxRetries !== undefined
        ? { maxAttempts: this.config.maxRetries + 1 }
        : {}),
    };

    // If apiKey is provided, use bearer token authentication
    const apiKey = this.resolveApiKey();
    if (apiKey) {
      return new BedrockRuntimeClient({
        region,
        ...networking,
        token: fromStatic({
          token: { token: apiKey },
        }),
        // Select bearer auth explicitly: otherwise the SDK may pick SigV4 and look for AWS
        // credentials (failing with "Could not load credentials") for key-only setups.
        authSchemePreference: ["httpBearerAuth"],
      });
    }

    // Otherwise use IAM credentials (existing behavior)
    const creds = await this.getCreds();
    return new BedrockRuntimeClient({
      region,
      ...networking,
      credentials: creds,
    });
  }

  private _oaiPartToBedrockPart(
    part:
      | OpenAI.Chat.Completions.ChatCompletionContentPart
      | OpenAI.Chat.Completions.ChatCompletionContentPartRefusal,
  ): ContentBlock {
    switch (part.type) {
      case "refusal":
        return {
          text: part.refusal,
        };
      case "text":
        return {
          text: part.text,
        };
      case "input_audio":
        throw new Error("Unsupported part type: input_audio");
      case "image_url":
      default:
        const parsed = parseDataUrl(
          (part as ChatCompletionContentPartImage).image_url.url,
        );
        if (!parsed) {
          console.warn("Bedrock: failed to process image part - invalid URL");
          return { text: "[Failed to process image]" };
        }
        const { mimeType, base64Data } = parsed;
        const format = mimeType.split("/")[1]?.split(";")[0] || "jpeg";
        if (
          format === ImageFormat.JPEG ||
          format === ImageFormat.PNG ||
          format === ImageFormat.WEBP ||
          format === ImageFormat.GIF
        ) {
          return {
            image: {
              format,
              source: {
                bytes: Uint8Array.from(Buffer.from(base64Data, "base64")),
              },
            },
          };
        } else {
          console.warn(
            `Bedrock: skipping unsupported image part format: ${format}`,
          );
          return { text: "[Unsupported image format]" };
        }
    }
  }

  private _convertMessages(
    oaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    availableTools: Set<string>,
    cache?: { conversation: boolean; ttl?: "1h"; afterTextOnly?: boolean },
  ): Message[] {
    let currentRole: "user" | "assistant" = "user";
    let currentBlocks: ContentBlock[] = [];
    const converted: Message[] = [];
    const hasAddedToolCallIds = new Set<string>();
    let pinned = 0;

    const pushCurrentMessage = () => {
      if (currentBlocks.length > 0) {
        converted.push({
          role: currentRole,
          content: currentBlocks,
        });
        currentBlocks = [];
      }
    };

    const nonSystemMessages = oaiMessages.filter((m) => m.role !== "system");

    for (let idx = 0; idx < nonSystemMessages.length; idx++) {
      const message = nonSystemMessages[idx];

      if (message.role === "user" || message.role === "tool") {
        // Detect conversational turn change
        if (currentRole !== ConversationRole.USER) {
          pushCurrentMessage();
          currentRole = ConversationRole.USER;
        }

        // USER messages
        if (message.role === "user") {
          const content = message.content;
          if (content) {
            if (typeof content === "string") {
              currentBlocks.push({ text: content });
            } else {
              content.forEach((part) => {
                currentBlocks.push(this._oaiPartToBedrockPart(part));
              });
            }
          }
        }
        // TOOL messages
        else if (message.role === "tool") {
          const trimmedContent =
            typeof message.content === "string"
              ? message.content.trim()
              : message.content
                  .map((c) => c.text)
                  .join("\n")
                  .trim();

          if (hasAddedToolCallIds.has(message.tool_call_id)) {
            currentBlocks.push({
              toolResult: {
                toolUseId: message.tool_call_id,
                content: [
                  {
                    text: trimmedContent || "No tool output",
                  },
                ],
              },
            });
          } else {
            currentBlocks.push({
              text: `Tool call output for Tool Call ID ${message.tool_call_id}:\n\n${trimmedContent || "No tool output"}`,
            });
          }
        }
      } else if (message.role === "assistant") {
        // Detect conversational turn change
        if (currentRole !== ConversationRole.ASSISTANT) {
          pushCurrentMessage();
          currentRole = ConversationRole.ASSISTANT;
        }

        // ASSISTANT messages
        if (typeof message.content === "string") {
          const trimmedText = message.content.trim();
          if (trimmedText) {
            currentBlocks.push({ text: trimmedText });
          }
        } else {
          message.content?.forEach((part) => {
            const text = part.type === "text" ? part.text : part.refusal;
            const trimmedText = text.trim();
            if (trimmedText) {
              currentBlocks.push({ text: trimmedText });
            }
          });
        }

        // TOOL CALLS
        if (message.tool_calls) {
          for (const toolCall of message.tool_calls) {
            // Type guard for function tool calls
            if (
              toolCall.type === "function" &&
              "function" in toolCall &&
              toolCall.id &&
              toolCall.function?.name
            ) {
              if (availableTools.has(toolCall.function.name)) {
                currentBlocks.push({
                  toolUse: {
                    toolUseId: toolCall.id,
                    name: toolCall.function.name,
                    input: safeParseArgs(
                      toolCall.function.arguments,
                      `Call: ${toolCall.function.name} ${toolCall.id}`,
                    ),
                  },
                });
                hasAddedToolCallIds.add(toolCall.id);
              } else {
                const toolCallText = `Assistant tool call:\nTool name: ${toolCall.function.name}\nTool Call ID: ${toolCall.id}\nArguments: ${toolCall.function?.arguments ?? "{}"}`;
                currentBlocks.push({
                  text: toolCallText,
                });
              }
            } else {
              console.warn(
                `Unsupported tool call type in Bedrock: ${toolCall.type}`,
              );
            }
          }
        }
      }

      // A message the client pinned (CACHE_PIN_FIELD, a fork point) gets a
      // cache point right after its content, so every request of a run keeps
      // that prefix warm and a branch from it reads it. Only when the
      // conversation is cached at all: a model that takes no cache point in
      // its messages gets none here either.
      if (
        cache?.conversation &&
        isCachePinned(message) &&
        currentBlocks.length > 0
      ) {
        currentBlocks.push(bedrockCachePoint(cache.ttl));
        pinned += 1;
      }
    }

    if (currentBlocks.length > 0) {
      pushCurrentMessage();
    }

    // A turn that converted to nothing (a reply stopped before any text, say)
    // would leave two user or two assistant messages in a row
    const repaired = repairConverseTurns(converted);

    // If caching is enabled, add cache points
    if (cache?.conversation) {
      this._addCachingToLastTwoUserMessages(
        repaired,
        cache.ttl,
        pinned,
        cache.afterTextOnly ?? false,
      );
    }

    return repaired;
  }

  /**
   * Put cache points on the last two user messages.
   *
   * No per-process marker goes into the prompt. One used to (a random
   * `<!-- SID: ... -->` on the first user message, meant to keep users of one
   * AWS account from sharing cache entries), but a cache hit needs the
   * identical prefix and yields nothing but a cheaper request, so the marker
   * bought no isolation and made every resumed or forked session rewrite its
   * whole history at the cache-write price instead of reading it (measured
   * 2026-11-08).
   *
   * The task list block (TASK_LIST_BLOCK_OPEN) is the last text of the last
   * user message and changes between requests, so the cache point goes before
   * it: the next request, which no longer has the block there, then starts
   * with exactly the bytes this one cached.
   *
   * With `afterTextOnly` (Nova) a cache point goes right after the last text
   * block of a user message, and a user message with no text block (tool
   * results only) gets none: Nova refuses a cachePoint next to a toolResult
   * ("extraneous key [cachePoint]"), which ended every multi-turn Nova run at
   * its second request. Claude takes it after a toolResult.
   *
   * Two cache points in the conversation at most (the tools and the system
   * prompt take the other two of Bedrock's four). A pinned point
   * (CACHE_PIN_FIELD, a fork point) counts as one of them, and a message that
   * already carries one is not marked again.
   */
  private _addCachingToLastTwoUserMessages(
    converted: Message[],
    ttl?: "1h",
    pinned = 0,
    afterTextOnly = false,
  ) {
    let numCached = Math.min(pinned, 2);
    for (let i = converted.length - 1; i >= 0 && numCached < 2; i--) {
      const message = converted[i];
      if (message.role !== "user") continue;
      const content = message.content ?? [];
      if (content.some((block) => !!block.cachePoint)) continue;
      if (afterTextOnly) {
        const at = content.findLastIndex(
          (block) =>
            block.text !== undefined && !isTaskListBlockText(block.text),
        );
        if (at === -1) continue;
        content.splice(at + 1, 0, bedrockCachePoint(ttl));
      } else {
        const last = content[content.length - 1];
        if (content.length > 1 && isTaskListBlockText(last?.text)) {
          content.splice(content.length - 1, 0, bedrockCachePoint(ttl));
        } else {
          content.push(bedrockCachePoint(ttl));
        }
      }
      numCached++;
    }
  }

  /**
   * `reasoning_effort` from the OpenAI body as the reasoning switch: unset
   * sends nothing, `none` turns reasoning off where a model takes an explicit
   * off, and the others turn it on (`minimal` as low, `xhigh` and `max` as
   * high, the most any Bedrock family accepts). The body wins; else the
   * config's `requestOptions.extraBodyProperties.reasoning_effort` (a catalog
   * variant, or a CLI use's `modeModels` effort) stands in, since the config
   * has no reasoning field of its own.
   */
  private reasoningFromBody(oaiBody: ChatCompletionCreateParams): {
    reasoning: boolean | undefined;
    budgetTokens: number;
  } {
    const fromConfig =
      this.config.requestOptions?.extraBodyProperties?.reasoning_effort;
    const effort =
      oaiBody.reasoning_effort ??
      (typeof fromConfig === "string"
        ? (fromConfig as ChatCompletionCreateParams["reasoning_effort"])
        : undefined);
    if (!effort) return { reasoning: undefined, budgetTokens: 0 };
    if (effort === "none") return { reasoning: false, budgetTokens: 0 };
    const level =
      effort === "minimal" || effort === "low"
        ? "low"
        : effort === "medium"
          ? "medium"
          : "high";
    return { reasoning: true, budgetTokens: effortToBudgetTokens(level) };
  }

  private _convertBody(
    oaiBody: ChatCompletionCreateParams,
  ): ConverseStreamCommandInput {
    // Extract system message
    const systemMessage =
      oaiBody.messages.find((msg) => msg.role === "system")?.content || "";

    const systemMessageText =
      typeof systemMessage === "string"
        ? systemMessage
        : systemMessage
            .map((part) =>
              part.type === "text" ? part.text : "[Non-text content]",
            )
            .join(" ");

    // Check for tools
    const availableTools = new Set<string>();
    let toolConfig: ToolConfiguration | undefined = undefined;

    // Cache points go only where the model accepts them: Claude takes them on
    // the tools, the system prompt and the messages; Nova on the system prompt
    // and the messages only; GPT and Grok cache by themselves and reject a
    // request that carries a cachePoint field anywhere, so `promptCaching:
    // true` must not reach them. See `bedrockCachePointFields`.
    const parts = optsOutOfPromptCache(oaiBody)
      ? { tools: false, system: false, conversation: false }
      : bedrockCachePartsForModel(
          oaiBody.model,
          this.config.promptCaching,
          this.config.cacheBehavior,
          !!systemMessageText,
        );

    // The lifetime to ask for on every cache point of this request, only for a
    // model that accepts one (an unsupported `ttl` can fail the request).
    // `cacheBehavior.ttl: auto` is the chat window's policy; with no toolbar,
    // this instance counts its own requests (one per model call, as the chat
    // window does) and applies the same two rules.
    const cachingOn = parts.tools || parts.system || parts.conversation;
    const cacheTtl = bedrockCacheTtl(
      oaiBody.model,
      requestedCacheTtl(
        this.config.cacheBehavior?.ttl,
        this.autoTtl,
        cachingOn,
      ),
    );

    if (oaiBody.tools && oaiBody.tools.length > 0) {
      toolConfig = {
        tools: oaiBody.tools.map((tool) => {
          // Type guard for function tools
          if (tool.type === "function" && "function" in tool) {
            return {
              toolSpec: {
                name: tool.function.name,
                description: tool.function.description,
                inputSchema: {
                  json: tool.function.parameters,
                },
              },
            };
          } else {
            throw new Error(`Unsupported tool type in Bedrock: ${tool.type}`);
          }
        }),
        // Without it Llama 3.3 writes the call as plain JSON text; every
        // tool-capable family accepts it (checked live, 2026-11-08).
        toolChoice: { auto: {} },
      } as ToolConfiguration;

      // Add cache point after the tool list
      if (parts.tools) {
        toolConfig.tools!.push(bedrockCachePoint(cacheTtl));
      }

      oaiBody.tools.forEach((tool) => {
        if (tool.type === "function" && "function" in tool) {
          availableTools.add(tool.function.name);
        }
      });
    }

    // Convert messages
    const convertedMessages = normalizeToolUseIds(
      fillMissingToolResults(
        this._convertMessages(oaiBody.messages, availableTools, {
          conversation: parts.conversation,
          ttl: cacheTtl,
          afterTextOnly: bedrockCachePointAfterTextOnly(oaiBody.model),
        }),
        "The user cancelled this tool call.",
      ),
      oaiBody.model,
    );

    // The reasoning switch differs per family (see bedrockReasoningFields);
    // Claude's sampling fields depend on whether thinking is on.
    const { reasoning, budgetTokens } = this.reasoningFromBody(oaiBody);
    const reasoningRequest = bedrockReasoningFields(
      oaiBody.model,
      reasoning,
      budgetTokens,
    );
    const sampling = bedrockSamplingParams(
      oaiBody.model,
      oaiBody.temperature ?? undefined,
      oaiBody.top_p ?? undefined,
      reasoning === true,
      this.config.omitSampling,
    );

    // Build final request body
    const body: any = {
      modelId: applyCrossRegionInference(
        oaiBody.model,
        this.config.env?.crossRegionInference,
        this.config.env?.region,
      ),
      messages: convertedMessages,
      ...this.extraConverseFields(),
      inferenceConfig: bedrockOmitUnsupportedInference(oaiBody.model, {
        temperature: sampling.temperature,
        topP: sampling.topP,
        maxTokens: reasoningRequest.omitMaxTokens
          ? undefined
          : bedrockMinMaxTokens(oaiBody.model, oaiBody.max_tokens ?? undefined),
        stopSequences: Array.isArray(oaiBody.stop)
          ? oaiBody.stop.filter((s) => s.trim() !== "").slice(0, 4)
          : oaiBody.stop
            ? [oaiBody.stop].filter((s) => s.trim() !== "")
            : undefined,
      }),
    };

    // Add system message if present
    if (systemMessageText) {
      body.system = parts.system
        ? [{ text: systemMessageText }, bedrockCachePoint(cacheTtl)]
        : [{ text: systemMessageText }];
    }

    // Add tool config if present
    if (toolConfig) {
      body.toolConfig = toolConfig;
    }

    if (Object.keys(reasoningRequest.additionalModelRequestFields).length) {
      body.additionalModelRequestFields =
        reasoningRequest.additionalModelRequestFields;
    }

    return body;
  }

  /**
   * Sends a ConverseStream request, with two kinds of retry, both remembered
   * for the process so later requests skip the failing attempt. The
   * request-field policy (plans/ROADMAP.md C58): a validation error that
   * names an optional field the request carries, one that changes cost and
   * not the answer (`stopSequences`, a `cachePoint`), is answered by sending
   * once more without it and telling the client (`recordFieldFallback`). A
   * prefixed model ID that Bedrock does not know is retried once as
   * `fallbackModelId` (the bare ID, when the prefix came from
   * `crossRegionInference: auto`).
   */
  private sendConverseStream(
    client: BedrockRuntimeClient,
    input: ConverseStreamCommandInput,
    signal: AbortSignal,
    fallbackModelId: string | undefined,
  ) {
    return this.sendWithRetries(input, fallbackModelId, (request) =>
      client.send(new ConverseStreamCommand(request), {
        abortSignal: signal,
      }),
    );
  }

  /** Converse (no stream) with the same retries as sendConverseStream. */
  private sendConverse(
    client: BedrockRuntimeClient,
    input: ConverseStreamCommandInput,
    signal: AbortSignal,
    fallbackModelId: string | undefined,
  ): Promise<ConverseCommandOutput> {
    return this.sendWithRetries(input, fallbackModelId, (request) =>
      client.send(new ConverseCommand(request), { abortSignal: signal }),
    );
  }

  private async sendWithRetries<T>(
    input: ConverseStreamCommandInput,
    fallbackModelId: string | undefined,
    send: (request: ConverseStreamCommandInput) => Promise<T>,
  ): Promise<T> {
    if (fallbackModelId && modelsWithoutInferencePrefix.has(input.modelId!)) {
      input.modelId = fallbackModelId;
    }
    let request = withoutRefusedFields(input);

    let retriedPrefix = false;
    for (;;) {
      try {
        return await send(request);
      } catch (error) {
        // Once per field: the resent request no longer carries it, so the
        // same refusal again is thrown.
        const field = bedrockRefusedField(error);
        if (field && converseRequestHasField(request, field)) {
          recordFieldFallback({
            provider: "bedrock",
            model: request.modelId ?? "",
            field,
            error: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          });
          request = converseRequestWithoutField(request, field);
          continue;
        }
        if (
          !retriedPrefix &&
          fallbackModelId &&
          request.modelId !== fallbackModelId &&
          isInvalidModelIdentifierError(error)
        ) {
          retriedPrefix = true;
          modelsWithoutInferencePrefix.add(request.modelId!);
          input.modelId = fallbackModelId;
          request = withoutRefusedFields({
            ...request,
            modelId: fallbackModelId,
          });
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Ends the toolUse block held in the gate: yields it when its input parses.
   * When it does not, the model is remembered as one whose tool input must not
   * be streamed, and the result says whether the turn is to be retried through
   * Converse (nothing has gone out that a retry would repeat). Otherwise the
   * block is yielded as streamed, since text or an earlier call went out.
   */
  private *settleToolCall(
    gate: ToolInputGate<ChatCompletionChunk>,
    model: string,
  ): Generator<ChatCompletionChunk, boolean> {
    const closed = gate.close();
    if (closed.broken) {
      modelsWithoutStreamingTools.add(model);
      console.debug(
        `Bedrock: ${model} streamed tool input that is not JSON; ${
          closed.retry ? "retrying through Converse" : "too late to retry"
        }`,
      );
    }
    yield* closed.parts;
    return closed.retry;
  }

  /**
   * A request with tools to a model that cannot stream them
   * (bedrockToolsNeedNonStreaming): sent through Converse, and the whole
   * reply yielded as the chunks the stream would have produced: text, each
   * toolUse block at its own index, reasoning, then the finish_reason chunk
   * from stopReason and the usage chunk.
   */
  private async *converseWholeMessage(
    client: BedrockRuntimeClient,
    input: ConverseStreamCommandInput,
    signal: AbortSignal,
    fallbackModelId: string | undefined,
    body: ChatCompletionCreateParams,
  ): AsyncGenerator<ChatCompletionChunk> {
    const model = body.model;
    const response = await this.sendConverse(
      client,
      input,
      signal,
      fallbackModelId,
    );
    const id = response.$metadata?.requestId;
    const isNova2 = /nova-2-/i.test(model);
    let toolIndex = -1;
    const recovered: RecoveredCall[] = [];
    for (const block of response.output?.message?.content ?? []) {
      // The same filters the stream applies: DeepSeek's DSML fragment is
      // dropped and reasoning tags are lifted out of the answer.
      const cleaned = block.text
        ? cleanReplyText(model, block.text)
        : undefined;
      const found = cleaned
        ? recoverFromText(
            model,
            cleaned.content,
            dialectToolsFromConverse(input.toolConfig),
            body,
          )
        : undefined;
      if (cleaned && found) {
        if (cleaned.reasoning) {
          yield chatChunkFromDelta({
            model,
            id,
            delta: {
              role: "assistant",
              reasoning_content: cleaned.reasoning,
            } as ReasoningDelta,
          });
        }
        recovered.push(...found.calls);
        if (found.text) yield chatChunk({ content: found.text, model, id });
      } else if (block.reasoningContent) {
        const reasoningDelta = reasoningDeltaFor(
          {
            ...block.reasoningContent.reasoningText,
            redactedContent: block.reasoningContent.redactedContent,
          },
          isNova2,
        );
        if (reasoningDelta) {
          yield chatChunkFromDelta({
            model,
            id,
            delta: { role: "assistant", ...reasoningDelta },
          });
        }
      } else if (block.toolUse) {
        toolIndex++;
        yield chatChunkFromDelta({
          model,
          id,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: block.toolUse.toolUseId,
                type: "function",
                function: {
                  name: block.toolUse.name,
                  arguments: JSON.stringify(block.toolUse.input ?? {}),
                },
              },
            ],
          },
        });
      }
    }
    const makeRecovered = toolIndex === -1 && recovered.length > 0;
    if (makeRecovered) {
      for (const call of recovered) {
        toolIndex++;
        yield recoveredCallChunk(call, toolIndex, model, id);
      }
    }
    if (response.stopReason) {
      yield chatChunkFromDelta({
        model,
        id,
        delta: {},
        finish_reason: makeRecovered
          ? "tool_calls"
          : bedrockFinishReason(response.stopReason),
      });
    }
    if (response.usage) {
      yield usageChatChunk({
        model,
        id,
        usage: bedrockUsageToCompletionUsage(response.usage),
      });
    }
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    let completion = "";
    let usage: ChatCompletion["usage"];
    let requestId: string | undefined;
    let finishReason: ChatCompletion.Choice["finish_reason"] | undefined;
    // Tool calls arrive as a start chunk (id and name) followed by argument
    // fragments at the same index.
    const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];

    for await (const chunk of this.chatCompletionStream(
      {
        ...body,
        stream: true,
      },
      signal,
    )) {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      if (chunk.id) {
        requestId = chunk.id;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        completion += choice.delta.content;
      }
      for (const call of choice.delta?.tool_calls ?? []) {
        const existing = toolCalls[call.index];
        if (!existing) {
          toolCalls[call.index] = {
            id: call.id ?? "",
            type: "function",
            function: {
              name: call.function?.name ?? "",
              arguments: call.function?.arguments ?? "",
            },
          };
        } else {
          if (call.function?.name) existing.function.name = call.function.name;
          if (call.function?.arguments) {
            existing.function.arguments += call.function.arguments;
          }
        }
      }
      if (
        choice.finish_reason &&
        Object.keys(choice.delta ?? {}).length === 0
      ) {
        finishReason = choice.finish_reason;
      }
    }

    const calls = toolCalls.filter(Boolean);
    return {
      // Bedrock's own request ID when it sent one: it is the ID in the
      // invocation log and the bill.
      id: requestId ?? uuidv4(),
      object: "chat.completion",
      model: body.model,
      created: Date.now(),
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason:
            calls.length > 0 ? "tool_calls" : (finishReason ?? "stop"),
          message: {
            role: "assistant",
            content: completion,
            tool_calls: calls.length > 0 ? calls : undefined,
            refusal: null,
          },
        },
      ],
      usage,
    };
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const requestBody = this._convertBody(body);

    try {
      const client = await this.getClient();
      const fallbackModelId = crossRegionFallbackModelId(
        body.model,
        this.config.env?.crossRegionInference,
        this.config.env?.region,
      );

      // Tools go through Converse for models that cannot stream them, and for
      // a model that refused them in streaming mode earlier in this process.
      const toolsWithoutStreaming =
        !!requestBody.toolConfig &&
        (bedrockToolsNeedNonStreaming(body.model) ||
          modelsWithoutStreamingTools.has(body.model));
      if (toolsWithoutStreaming) {
        yield* this.converseWholeMessage(
          client,
          { ...requestBody },
          signal,
          fallbackModelId,
          body,
        );
        return;
      }

      let response;
      try {
        response = await this.sendConverseStream(
          client,
          { ...requestBody },
          signal,
          fallbackModelId,
        );
      } catch (e) {
        // Llama 4's refusal: retried once through Converse and remembered
        if (!requestBody.toolConfig || !isStreamingToolUseUnsupportedError(e)) {
          throw e;
        }
        modelsWithoutStreamingTools.add(body.model);
        yield* this.converseWholeMessage(
          client,
          { ...requestBody },
          signal,
          fallbackModelId,
          body,
        );
        return;
      }

      if (!response?.stream) {
        throw new Error("No stream received from Bedrock API");
      }

      // The ID that identifies this call in Bedrock's invocation log and in
      // billing. It is known before the first event, so every chunk carries it.
      const id = response.$metadata?.requestId;

      // DeepSeek V3.2 leaks a fragment of its tool-call markup at the end of
      // the text before a toolUse block; held-back text waits here until the
      // block ends (see holdBackDsmlMarker).
      const filterDsml = leaksDsmlMarker(body.model);
      let dsmlHold = "";
      // Nova Pro, Lite and Micro write their reasoning as <thinking> tags in
      // the text; the splitter lifts it into reasoning_content, holding back
      // a fragment that could still become a tag (see ThinkingTagSplitter).
      const thinkingTags = createThinkingTagSplitter(body.model);
      const splitChunks = (split: ThinkingSplit): ChatCompletionChunk[] => {
        const chunks: ChatCompletionChunk[] = [];
        if (split.reasoning) {
          chunks.push(
            chatChunkFromDelta({
              model: body.model,
              id,
              delta: {
                role: "assistant",
                reasoning_content: split.reasoning,
              } as ReasoningDelta,
            }),
          );
        }
        if (split.content) {
          chunks.push(
            chatChunk({ content: split.content, model: body.model, id }),
          );
        }
        return chunks;
      };
      const isNova2 = /nova-2-/i.test(body.model);
      // Off unless asked for (qwenXmlRecoveryEnabled): Qwen3-Coder sometimes
      // writes its tool call as text, which ends the turn with nothing done.
      // Calls found in the text are held until the reply ends and are made
      // only when the model made no toolUse of its own.
      const recovery = createTextToolRecovery(
        body.model,
        dialectToolsFromConverse(requestBody.toolConfig),
        body,
      );
      const recovered: RecoveredCall[] = [];
      const recoveryChunks = function* (
        events: ReturnType<TextToolRecovery["end"]>,
      ): Generator<ChatCompletionChunk> {
        for (const event of events) {
          if (event.type === "call") recovered.push(event.call);
          else yield chatChunk({ content: event.text, model: body.model, id });
        }
        // Say when text starts being held and when it is judged, so a reader
        // can show that the reply is being read rather than stalled.
        const phase = recovery?.takeHoldSignal?.();
        if (phase) yield holdChunk(phase, { id, model: body.model });
      };
      // Answer text after the filters above: shown, or given to the recovery
      // stage when there is one. The filters come first, as cleanReplyText
      // does before recoverFromText on the whole-message path, so reasoning is
      // never read as a call or shown as the answer.
      const answerChunks = function* (
        content: string,
      ): Generator<ChatCompletionChunk> {
        if (!content) return;
        if (recovery) yield* recoveryChunks(recovery.push(content));
        else yield chatChunk({ content, model: body.model, id });
      };
      const filteredChunks = function* (
        split: ThinkingSplit,
      ): Generator<ChatCompletionChunk> {
        yield* splitChunks({ content: "", reasoning: split.reasoning });
        yield* answerChunks(split.content);
      };
      // Each toolUse block gets its own tool_calls index, so a reply with
      // several calls is not merged into one.
      let toolIndex = -1;
      // The tool_calls index of each toolUse block, by contentBlockIndex, so
      // an input fragment goes to its own call (fragments carry only the
      // block index; the id comes with the start)
      const toolIndexByBlock = new Map<number, number>();
      // A toolUse block is held until its input is known to parse (see
      // ToolInputGate): a model that streams it broken is retried once
      // through Converse, before any of it has reached the caller.
      // With CONTINUE_BEDROCK_REPAIR_STREAMED_TOOL_INPUT=1, input that can be
      // repaired without inventing a value is released instead (see
      // repairStreamedToolInput); the rest is retried as before.
      let toolName: string | undefined;
      const gate = new ToolInputGate<ChatCompletionChunk>(
        !bedrockStreamsToolInputCleanly(body.model),
        bedrockRepairsStreamedToolInput(body.model)
          ? {
              input: (text) =>
                repairStreamedToolInput(text, {
                  allowedKeys: toolSchemaKeys(
                    requestBody.toolConfig?.tools,
                    toolName,
                  ),
                }),
              fragment: (text) =>
                chatChunkFromDelta({
                  model: body.model,
                  id,
                  delta: {
                    tool_calls: [
                      {
                        index: Math.max(toolIndex, 0),
                        type: "function",
                        function: { arguments: text },
                      },
                    ],
                  },
                }),
            }
          : undefined,
      );
      const retryThroughConverse = () =>
        this.converseWholeMessage(
          client,
          { ...requestBody },
          signal,
          fallbackModelId,
          body,
        );

      for await (const chunk of response.stream) {
        if (chunk.contentBlockStart?.start?.toolUse) {
          if (yield* this.settleToolCall(gate, body.model)) {
            yield* retryThroughConverse();
            return;
          }
        }
        if (chunk.contentBlockStop || chunk.messageStop) {
          if (dsmlHold) {
            const text = flushDsmlHold(dsmlHold);
            dsmlHold = "";
            yield* answerChunks(text);
          }
          if (thinkingTags) yield* filteredChunks(thinkingTags.flush());
          if (recovery) yield* recoveryChunks(recovery.end());
          if (yield* this.settleToolCall(gate, body.model)) {
            yield* retryThroughConverse();
            return;
          }
        }

        if (chunk.contentBlockDelta?.delta) {
          const delta: any = chunk.contentBlockDelta.delta;

          // Handle text content
          if (delta.text) {
            gate.noteOutput();
            let text = delta.text;
            if (filterDsml) {
              const split = holdBackDsmlMarker(dsmlHold + text);
              dsmlHold = split.hold;
              text = split.emit;
            }
            if (thinkingTags) yield* filteredChunks(thinkingTags.push(text));
            else yield* answerChunks(text);
            continue;
          }

          // Reasoning, as the OpenAI-style fields core's chunk reader takes
          // (see reasoningDeltaFor).
          const reasoning = delta.reasoningContent;
          if (reasoning) {
            gate.noteOutput();
            const reasoningDelta = reasoningDeltaFor(reasoning, isNova2);
            if (reasoningDelta) {
              yield chatChunkFromDelta({
                model: body.model,
                id,
                delta: { role: "assistant", ...reasoningDelta },
              });
            }
            continue;
          }

          // Handle tool use. A fragment belongs to the call its block
          // started (contentBlockIndex), not to the newest call: with parallel
          // calls their fragments can interleave
          if (delta.toolUse) {
            const blockIndex = chunk.contentBlockDelta?.contentBlockIndex;
            const callIndex =
              (blockIndex === undefined
                ? undefined
                : toolIndexByBlock.get(blockIndex)) ?? Math.max(toolIndex, 0);
            const fragment = chatChunkFromDelta({
              model: body.model,
              id,
              delta: {
                tool_calls: [
                  {
                    index: callIndex,
                    id: delta.toolUse.toolUseId,
                    type: "function",
                    function: {
                      name: delta.toolUse.name,
                      arguments: delta.toolUse.input,
                    },
                  },
                ],
              },
            });
            if (gate.holding) gate.add(fragment, delta.toolUse.input);
            else yield fragment;
          }
        }

        if (chunk.contentBlockStart?.start) {
          const start: ContentBlockStart = chunk.contentBlockStart.start;

          if (start.toolUse) {
            toolIndex++;
            const startedBlock = chunk.contentBlockStart.contentBlockIndex;
            if (startedBlock !== undefined) {
              toolIndexByBlock.set(startedBlock, toolIndex);
            }
            toolName = start.toolUse.name;
            const opened = chatChunkFromDelta({
              model: body.model,
              id,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: start.toolUse.toolUseId,
                    type: "function",
                    function: {
                      name: start.toolUse.name,
                      arguments: undefined,
                    },
                  },
                ],
              },
            });
            yield* gate.open(opened);
          }
        }

        // Why the reply ended, as OpenAI's finish_reason on a chunk with an
        // empty delta, so a client can tell truncation (max_tokens) from a
        // finished answer.
        if (chunk.messageStop?.stopReason) {
          const makeRecovered = toolIndex === -1 && recovered.length > 0;
          if (makeRecovered) {
            for (const call of recovered) {
              toolIndex++;
              yield recoveredCallChunk(call, toolIndex, body.model, id);
            }
          }
          yield chatChunkFromDelta({
            model: body.model,
            id,
            delta: {},
            finish_reason: makeRecovered
              ? "tool_calls"
              : bedrockFinishReason(chunk.messageStop.stopReason),
          });
        }

        // The metadata event arrives last and carries the token counts,
        // including the cache read and write counts when caching is on.
        if (chunk.metadata?.usage) {
          yield usageChatChunk({
            model: body.model,
            id,
            usage: bedrockUsageToCompletionUsage(chunk.metadata.usage),
          });
        }
      }
      if (yield* this.settleToolCall(gate, body.model)) {
        yield* retryThroughConverse();
        return;
      }
    } catch (error) {
      const accessMessage = bedrockModelAccessMessage(
        error,
        requestBody.modelId ?? body.model,
      );
      if (accessMessage) {
        throw new Error(accessMessage);
      }
      // TLS / proxy trouble (untrusted corporate CA, proxy auth) is common
      // here; say how to fix it.
      const hint = getTlsErrorHint(error);
      const withHint = (message: string) =>
        hint && !message.includes(hint) ? `${message}\n\n${hint}` : message;
      if (error instanceof Error) {
        if ("code" in error) {
          throw new Error(
            withHint(
              `AWS Bedrock stream error (${(error as any).code}): ${error.message}`,
            ),
          );
        }
        throw new Error(
          withHint(`Error processing Bedrock stream: ${error.message}`),
        );
      }
      throw new Error(
        "Error processing Bedrock stream: Unknown error occurred",
      );
    }
  }

  completionNonStream(
    body: CompletionCreateParamsNonStreaming,
  ): Promise<Completion> {
    throw new Error("Bedrock does not support completions API");
  }

  completionStream(
    body: CompletionCreateParamsStreaming,
  ): AsyncGenerator<Completion> {
    throw new Error("Bedrock does not support completions API");
  }

  fimStream(
    body: FimCreateParamsStreaming,
  ): AsyncGenerator<ChatCompletionChunk> {
    throw new Error("Bedrock does not support FIM directly");
  }

  private async getInvokeModelResponseBody(model: string, jsonBody: object) {
    const payload = {
      body: JSON.stringify(jsonBody),
      modelId: model,
      accept: "*/*",
      contentType: "application/json",
    };
    const command = new InvokeModelCommand(payload);
    const client = await this.getClient();
    const response = await client.send(command);
    if (!response.body) {
      throw new Error("No response body");
    }
    const decoder = new TextDecoder();
    const decoded = decoder.decode(response.body);
    return JSON.parse(decoded);
  }

  private getEmbedTexts(body: EmbeddingCreateParams): string[] {
    const texts: string[] = [];
    if (typeof body.input === "string") {
      texts.push(body.input);
    } else if (body.input.length > 0) {
      const firstVal = body.input[0];
      if (Array.isArray(firstVal)) {
        throw new Error("Unsupported embeddings type received: number[][]");
      }
      if (typeof firstVal === "string") {
        texts.push(...(body.input as string[]));
      } else {
        throw new Error("Unsupported embeddings type received: number[]");
      }
    }
    return texts;
  }

  async embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    const texts = this.getEmbedTexts(body);

    let embeddings: number[][];
    if (body.model.startsWith("cohere")) {
      const payload = {
        texts,
        input_type: "search_document",
        truncate: "END",
      };
      const output = await this.getInvokeModelResponseBody(body.model, payload);
      embeddings = [output.embedding];
    } else if (body.model.startsWith("amazon.titan-embed")) {
      embeddings = await Promise.all(
        texts.map(async (text) => {
          const payload = {
            inputText: text,
          };
          const output = await this.getInvokeModelResponseBody(
            body.model,
            payload,
          );
          return output.embeddings || [];
        }),
      );
    } else {
      throw new Error(`Unsupported model: ${body.model}`);
    }

    return embedding({
      data: embeddings,
      model: body.model,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    });
  }

  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    if (!body.query || !body.documents.length) {
      throw new Error("Query and chunks must not be empty");
    }

    // Base payload for both models
    const payload: any = {
      query: body.query,
      documents: body.documents,
      top_n: body.top_k ?? body.documents.length,
    };

    // Add api_version for Cohere model
    if (body.model.startsWith("cohere.rerank")) {
      payload.api_version = 2;
    }

    try {
      const responseBody = await this.getInvokeModelResponseBody(
        body.model,
        payload,
      );
      const scores = responseBody.results
        .sort((a: any, b: any) => a.index - b.index)
        .map((result: any) => result.relevance_score);

      return rerank({
        model: body.model,
        usage: {
          total_tokens: 0,
        },
        data: scores,
      });
    } catch (error) {
      if (error instanceof Error) {
        if ("code" in error) {
          // AWS SDK specific errors
          throw new Error(
            `AWS Bedrock rerank error (${(error as any).code}): ${error.message}`,
          );
        }
        throw new Error(`Error in BedrockReranker.rerank: ${error.message}`);
      }
      throw new Error(
        "Error in BedrockReranker.rerank: Unknown error occurred",
      );
    }
  }

  list(): Promise<Model[]> {
    throw new Error("Method not implemented.");
  }
}
