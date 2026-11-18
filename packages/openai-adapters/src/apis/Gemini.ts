// IMPORTANT: Import nativeFetch FIRST to preserve native fetch before any pollution
import { withNativeFetch } from "../util/nativeFetch.js";
import { GoogleGenAI } from "@google/genai";
import { OpenAI } from "openai/index";
import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPartImage,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  Completion,
  CompletionCreateParamsNonStreaming,
  CompletionCreateParamsStreaming,
  CompletionUsage,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  Model,
} from "openai/resources/index";

import { v4 as uuidv4 } from "uuid";
import { GeminiConfig } from "../types.js";
import {
  chatChunk,
  chatChunkFromDelta,
  customFetch,
  embedding,
  usageChatChunk,
} from "../util.js";
import {
  convertOpenAIToolToGeminiFunction,
  GeminiChatContent,
  GeminiChatContentPart,
  GeminiToolFunctionDeclaration,
  mergeConsecutiveGeminiMessages,
} from "../util/gemini-types.js";
import { safeParseArgs } from "../util/parseArgs.js";
import {
  BaseLlmApi,
  CreateRerankResponse,
  FimCreateParamsStreaming,
  RerankCreateParams,
} from "./base.js";
import {
  reasoningSwitch,
  requestedReasoningEffort,
} from "./reasoningSwitch.js";

type UsageInfo = Pick<
  CompletionUsage,
  "total_tokens" | "completion_tokens" | "prompt_tokens"
> & {
  /** Only when Gemini reported cache hits; names as the other adapters use. */
  prompt_tokens_details?: CompletionUsage["prompt_tokens_details"] & {
    cache_read_tokens?: number;
  };
};

interface GeminiToolCall
  extends OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

interface GeminiToolDelta
  extends OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta {
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

/**
 * Gemini 2.5 and later think before they answer but return none of it unless
 * asked with `thinkingConfig.includeThoughts`; then thought summaries come
 * back as parts marked `thought: true`. Thinking tokens are billed whether or
 * not the summaries are returned. Image, speech, live and embedding models
 * take no thinking config.
 */
export function returnsThoughts(model: string): boolean {
  if (/image|tts|live|audio|embedding/i.test(model)) return false;
  return /gemini-(?:2\.5|[3-9])|gemini-(?:flash|pro)(?:-lite)?-latest/i.test(
    model,
  );
}

/** Gemini's `thinkingConfig` fields other than `includeThoughts`. */
export interface GeminiThinkingControl {
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  thinkingBudget?: number;
}

/**
 * The reasoning switch (reasoningSwitch.ts) as Gemini's thinking control.
 * Gemini 3 and later take `thinkingLevel`: the Flash models every level, and
 * off as MINIMAL (they cannot turn thinking off); the Pro models LOW and HIGH
 * only, so off and low are LOW and medium is HIGH. Gemini 2.5 takes
 * `thinkingBudget` in tokens (the GUI's 1024, 4096 and 16384 for low, medium
 * and high); off is 0 on Flash and Flash-Lite, and Pro, which cannot turn it
 * off, is left at its default. Unset, nothing is sent and the model uses its
 * own default, as before. Thinking tokens are billed as output.
 */
export function geminiThinkingControl(
  model: string,
  effort: string | undefined,
): GeminiThinkingControl {
  if (!effort || !returnsThoughts(model)) return {};
  const { reasoning, level, budgetTokens } = reasoningSwitch(effort);
  const isPro = /pro/i.test(model);
  if (/gemini-[3-9]/i.test(model)) {
    if (isPro) {
      return {
        thinkingLevel: reasoning && level !== "low" ? "HIGH" : "LOW",
      };
    }
    if (!reasoning) return { thinkingLevel: "MINIMAL" };
    return {
      thinkingLevel:
        level === "low" ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH",
    };
  }
  if (/gemini-2\.5/i.test(model)) {
    if (!reasoning) return isPro ? {} : { thinkingBudget: 0 };
    return { thinkingBudget: budgetTokens };
  }
  return {};
}

export class GeminiApi implements BaseLlmApi {
  apiBase: string = "https://generativelanguage.googleapis.com/v1beta/";
  private genAI: GoogleGenAI;

  static maxStopSequences = 5;

  constructor(protected config: GeminiConfig) {
    this.apiBase = config.apiBase ?? this.apiBase;
    // Create GoogleGenAI with native fetch to avoid pollution
    // from Vercel AI SDK packages that can break stream handling
    this.genAI = withNativeFetch(
      () =>
        new GoogleGenAI({
          apiKey: this.config.apiKey,
        }),
    );
  }

  private _oaiPartToGeminiPart(
    part:
      | OpenAI.Chat.Completions.ChatCompletionContentPart
      | OpenAI.Chat.Completions.ChatCompletionContentPartRefusal,
  ): GeminiChatContentPart | undefined {
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
      default: {
        // inlineData takes base64 bytes. An http(s) URL has none, and would
        // go out as `data: undefined`.
        const url = (part as ChatCompletionContentPartImage).image_url?.url;
        const data = url?.startsWith("data:") ? url.split(",")[1] : undefined;
        if (!data) {
          console.warn(
            "Gemini: skipping an image that is not a data URL. The image was left out of the request.",
          );
          return undefined;
        }
        return {
          inlineData: {
            mimeType: "image/jpeg",
            data,
          },
        };
      }
    }
  }

  /** Content parts as Gemini parts, without the ones that can't be sent. */
  private _oaiPartsToGeminiParts(
    parts: Array<
      | OpenAI.Chat.Completions.ChatCompletionContentPart
      | OpenAI.Chat.Completions.ChatCompletionContentPartRefusal
    >,
  ): GeminiChatContentPart[] {
    return parts
      .map((part) => this._oaiPartToGeminiPart(part))
      .filter((part): part is GeminiChatContentPart => part !== undefined);
  }

  private _messageText(
    content:
      | string
      | OpenAI.Chat.Completions.ChatCompletionContentPart[]
      | OpenAI.Chat.Completions.ChatCompletionContentPartRefusal[]
      | null
      | undefined,
  ): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }
    return content
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "refusal") return part.refusal;
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }

  public _convertBody(
    oaiBody: ChatCompletionCreateParams,
    isV1API: boolean,
    includeToolCallIds: boolean,
  ) {
    const generationConfig: any = {};

    if (oaiBody.top_p) {
      generationConfig.topP = oaiBody.top_p;
    }
    if (oaiBody.temperature !== undefined && oaiBody.temperature !== null) {
      generationConfig.temperature = oaiBody.temperature;
    }
    if (oaiBody.max_tokens) {
      generationConfig.maxOutputTokens = oaiBody.max_tokens;
    }
    if (oaiBody.stop) {
      const stop = Array.isArray(oaiBody.stop) ? oaiBody.stop : [oaiBody.stop];
      generationConfig.stopSequences = stop.filter((x) => x.trim() !== "");
    }

    const toolCallIdToNameMap = new Map<string, string>();
    oaiBody.messages.forEach((msg) => {
      if (msg.role === "assistant" && msg.tool_calls) {
        msg.tool_calls.forEach((call) => {
          // Type guard for function tool calls
          if (call.type === "function" && "function" in call) {
            toolCallIdToNameMap.set(call.id, call.function.name);
          }
        });
      }
    });

    const contents = oaiBody.messages
      .map((msg) => {
        if ((msg.role === "system" || msg.role === "developer") && !isV1API) {
          return null; // Collected into systemInstruction below
        }

        if (msg.role === "assistant" && msg.tool_calls?.length) {
          for (const toolCall of msg.tool_calls) {
            // Type guard for function tool calls
            if (toolCall.type === "function" && "function" in toolCall) {
              toolCallIdToNameMap.set(toolCall.id, toolCall.function.name);
            }
          }

          const textParts: GeminiChatContentPart[] = [];
          if (typeof msg.content === "string" && msg.content) {
            textParts.push({ text: msg.content });
          } else if (Array.isArray(msg.content)) {
            textParts.push(...this._oaiPartsToGeminiParts(msg.content));
          }

          // A call with no name would go out as `name: undefined`
          const namedCalls = (msg.tool_calls as GeminiToolCall[]).filter(
            (toolCall) =>
              !(
                toolCall.type === "function" &&
                "function" in toolCall &&
                !toolCall.function?.name
              ),
          );

          return {
            role: "model" as const,
            parts: [
              ...textParts,
              ...namedCalls.map((toolCall, index) => {
                if (toolCall.type === "function" && "function" in toolCall) {
                  let thoughtSignature: string | undefined;
                  if (index === 0) {
                    const rawSignature =
                      toolCall?.extra_content?.google?.thought_signature;

                    if (
                      typeof rawSignature === "string" &&
                      rawSignature.length > 0
                    ) {
                      thoughtSignature = rawSignature;
                    } else {
                      // Fallback per https://ai.google.dev/gemini-api/docs/thought-signatures
                      // for histories that were not generated by Gemini or are missing signatures.
                      thoughtSignature = "skip_thought_signature_validator";
                    }
                  }

                  return {
                    functionCall: {
                      id: includeToolCallIds ? toolCall.id : undefined,
                      name: toolCall.function.name,
                      args: safeParseArgs(
                        toolCall.function.arguments,
                        `Call: ${toolCall.function.name} ${toolCall.id}`,
                      ),
                    },
                    ...(thoughtSignature && { thoughtSignature }),
                  };
                }
                throw new Error(
                  `Unsupported tool call type in Gemini: ${toolCall.type}`,
                );
              }),
            ],
          };
        }

        if (msg.role === "tool") {
          const functionName = toolCallIdToNameMap.get(msg.tool_call_id);
          const imageParts: GeminiChatContentPart[] = Array.isArray(msg.content)
            ? msg.content
                .filter(
                  (part) => (part as { type?: string }).type === "image_url",
                )
                .map((part) =>
                  this._oaiPartToGeminiPart(
                    part as OpenAI.Chat.Completions.ChatCompletionContentPart,
                  ),
                )
                .filter(
                  (part): part is GeminiChatContentPart => part !== undefined,
                )
            : [];
          return {
            role: "user" as const,
            parts: [
              {
                functionResponse: {
                  id: includeToolCallIds ? msg.tool_call_id : undefined,
                  name: functionName ?? "unknown",
                  response: {
                    content: this._messageText(msg.content),
                  },
                },
              },
              ...imageParts,
            ],
          };
        }

        if (!msg.content) {
          return null;
        }

        return {
          role:
            msg.role === "assistant" ? ("model" as const) : ("user" as const),
          parts:
            typeof msg.content === "string"
              ? [{ text: msg.content }]
              : this._oaiPartsToGeminiParts(msg.content),
        };
      })
      // Gemini rejects a Content with no parts (`[]` content, or a turn
      // whose only image or call could not be sent)
      .filter((c) => c !== null && c.parts.length > 0) as GeminiChatContent[];

    const mergedContents = mergeConsecutiveGeminiMessages(contents);

    const systemText = oaiBody.messages
      .filter((msg) => msg.role === "system" || msg.role === "developer")
      .map((msg) => this._messageText(msg.content))
      .filter((text) => text.length > 0)
      .join("\n\n");
    const finalBody: any = {
      generationConfig,
      contents: mergedContents,
      // Every system and developer message, not only the first system string.
      ...(systemText &&
        !isV1API && {
          systemInstruction: { parts: [{ text: systemText }] },
        }),
    };

    if (!isV1API) {
      // Convert and add tools if present
      if (oaiBody.tools?.length) {
        // Choosing to map all tools to the functionDeclarations of one tool
        // Rather than map each tool to its own tool + functionDeclaration
        // Same difference
        const functions: GeminiToolFunctionDeclaration[] = [];
        oaiBody.tools.forEach((tool) => {
          try {
            functions.push(convertOpenAIToolToGeminiFunction(tool));
          } catch (e) {
            console.warn(
              `Failed to convert tool to gemini function definition. Skipping: ${JSON.stringify(tool, null, 2)}`,
            );
          }
        });

        if (functions.length) {
          finalBody.tools = [
            {
              functionDeclarations: functions,
            },
          ];
        }
      }
    }

    return finalBody;
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    let completion = "";
    let usage: UsageInfo | undefined = undefined;
    for await (const chunk of this.chatCompletionStream(
      {
        ...body,
        stream: true,
      },
      signal,
    )) {
      if (chunk.choices.length > 0) {
        completion += chunk.choices[0].delta.content || "";
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
    return {
      id: "",
      object: "chat.completion",
      model: body.model,
      created: Date.now(),
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: completion,
            refusal: null,
          },
        },
      ],
      usage,
    };
  }

  private async *processStreamResponse(
    response: AsyncIterable<any>,
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    let usage: UsageInfo | undefined = undefined;
    // Gemini puts a finishReason on the last candidate. A stream with content
    // but no finishReason was cut off by something in between.
    let sawContent = false;
    let finishReason: string | undefined;

    for await (const chunk of response) {
      finishReason = chunk?.candidates?.[0]?.finishReason ?? finishReason;
      if (chunk.usageMetadata) {
        // `cachedContentTokenCount` is the part of the prompt served from a
        // cache, implicit or explicit. Google's type documents `promptTokenCount`
        // as including it when an explicit cache is used; that it does for
        // implicit hits too has not been checked against a live response. It is
        // left out when zero so a response without hits looks as it always did.
        const cached = chunk.usageMetadata.cachedContentTokenCount;
        usage = {
          prompt_tokens: chunk.usageMetadata.promptTokenCount || 0,
          completion_tokens: chunk.usageMetadata.candidatesTokenCount || 0,
          total_tokens: chunk.usageMetadata.totalTokenCount || 0,
          ...(typeof cached === "number" &&
            cached > 0 && {
              prompt_tokens_details: {
                cached_tokens: cached,
                cache_read_tokens: cached,
              },
            }),
        };
      }

      const contentParts = chunk?.candidates?.[0]?.content?.parts;
      if (contentParts) {
        if (contentParts.length > 0) sawContent = true;
        for (const part of contentParts) {
          if (part.text !== undefined) {
            const thoughtSignature = (part as any)?.thoughtSignature;
            if (thoughtSignature) {
              yield chatChunkFromDelta({
                model,
                delta: {
                  role: "assistant",
                  extra_content: {
                    google: {
                      thought_signature: thoughtSignature,
                    },
                  },
                } as GeminiToolDelta,
              });
            }

            // A thought summary (`includeThoughts`) is reasoning, not the
            // answer: it goes out as `reasoning_content`, which the chat shows
            // as thinking and a completion leaves out.
            if ((part as any).thought === true) {
              if (part.text) {
                yield chatChunkFromDelta({
                  model,
                  delta: {
                    role: "assistant",
                    reasoning_content: part.text,
                  } as ChatCompletionChunk.Choice["delta"],
                  finish_reason: null,
                });
              }
              continue;
            }

            yield chatChunk({
              content: part.text,
              model,
            });
          } else if (part.functionCall) {
            const thoughtSignature = (part as any)?.thoughtSignature;
            yield chatChunkFromDelta({
              model,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: (part.functionCall as any).id ?? uuidv4(),
                    type: "function",
                    function: {
                      name: part.functionCall.name ?? "",
                      arguments: JSON.stringify(part.functionCall.args ?? {}),
                    },
                    ...(thoughtSignature && {
                      extra_content: {
                        google: {
                          thought_signature: thoughtSignature,
                        },
                      },
                    }),
                  },
                ],
              },
            });
          }
        }
      }
    }

    if (sawContent && !finishReason && !signal?.aborted) {
      throw new Error(
        "The Gemini stream ended before the response was complete (no finishReason).",
      );
    }

    if (usage) {
      yield usageChatChunk({
        model,
        usage,
      });
    }
  }

  /**generates stream from @google/genai sdk */
  private async generateStream(
    genAI: GoogleGenAI,
    model: string,
    convertedBody: ReturnType<typeof this._convertBody>,
    signal?: AbortSignal,
    effort?: string,
  ) {
    // Off (thinkingBudget 0) returns no thoughts to ask for
    const control = geminiThinkingControl(model, effort);
    const includeThoughts =
      returnsThoughts(model) && control.thinkingBudget !== 0;
    // Use native fetch temporarily for stream operation to get proper ReadableStream
    // The withNativeFetch wrapper restores native fetch, makes the call, then reverts
    return withNativeFetch(() =>
      genAI.models.generateContentStream({
        model,
        contents: convertedBody.contents,
        config: {
          systemInstruction: convertedBody.systemInstruction,
          tools: convertedBody.tools,
          ...convertedBody.generationConfig,
          // The model thinks either way; includeThoughts returns summaries
          // of it, and the control sets how much (geminiThinkingControl)
          ...((includeThoughts || Object.keys(control).length > 0) && {
            thinkingConfig: {
              ...(includeThoughts && { includeThoughts: true }),
              ...(control as Record<string, unknown>),
            },
          }),
          // Without this the stop button only stopped reading; the request
          // kept generating (and billing) on Google's side.
          ...(signal && { abortSignal: signal }),
        },
      }),
    );
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const convertedBody = this._convertBody(
      body,
      this.apiBase.includes("/v1/"),
      true,
    );
    const response = await this.generateStream(
      this.genAI,
      body.model,
      convertedBody,
      signal,
      requestedReasoningEffort(
        body,
        this.config.requestOptions?.extraBodyProperties,
      ),
    );
    yield* this.processStreamResponse(response, body.model, signal);
  }

  async *streamWithGenAI(
    genAI: GoogleGenAI,
    body: ChatCompletionCreateParamsStreaming,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    const convertedBody = this._convertBody(body, false, true);
    const response = await this.generateStream(
      genAI,
      body.model,
      convertedBody,
      signal,
      requestedReasoningEffort(
        body,
        this.config.requestOptions?.extraBodyProperties,
      ),
    );
    yield* this.processStreamResponse(response, body.model, signal);
  }

  completionNonStream(
    _body: CompletionCreateParamsNonStreaming,
  ): Promise<Completion> {
    throw new Error("Method not implemented.");
  }
  completionStream(
    body: CompletionCreateParamsStreaming,
  ): AsyncGenerator<Completion> {
    throw new Error("Method not implemented.");
  }
  fimStream(
    body: FimCreateParamsStreaming,
  ): AsyncGenerator<ChatCompletionChunk> {
    throw new Error("Method not implemented.");
  }
  async rerank(body: RerankCreateParams): Promise<CreateRerankResponse> {
    throw new Error("Method not implemented.");
  }

  async embed(body: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const response = await customFetch(this.config.requestOptions)(
      new URL(`${body.model}:batchEmbedContents`, this.apiBase),
      {
        method: "POST",
        body: JSON.stringify({
          requests: inputs.map((input) => ({
            model: body.model,
            content: {
              role: "user",
              parts: [{ text: input }],
            },
          })),
        }),
        headers: {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          "x-goog-api-key": this.config.apiKey,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          "Content-Type": "application/json",
        },
      },
    );

    const data = (await response.json()) as any;
    return embedding({
      model: body.model,
      usage: {
        total_tokens: data.total_tokens,
        prompt_tokens: data.prompt_tokens,
      },
      data: data.batchEmbedContents.map((embedding: any) => embedding.values),
    });
  }

  list(): Promise<Model[]> {
    throw new Error("Method not implemented.");
  }
}
