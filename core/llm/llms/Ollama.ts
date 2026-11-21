import { Mutex } from "async-mutex";
import { JSONSchema7, JSONSchema7Object } from "json-schema";
import { v4 as uuidv4 } from "uuid";

import { streamResponse } from "@continuedev/fetch";
import {
  ChatMessage,
  ChatMessageRole,
  CompletionOptions,
  LLMOptions,
  ModelInstaller,
  ThinkingChatMessage,
} from "../../index.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { getRemoteModelInfo } from "../../util/ollamaHelper.js";
import { extractBase64FromDataUrl } from "../../util/url.js";
import { BaseLLM } from "../index.js";
import { rememberLearned } from "../learnedLimits.js";
import { ollamaUsage } from "../serverTimings.js";

type OllamaChatMessage = {
  role: ChatMessageRole;
  content: string;
  images?: string[] | null;
  thinking?: string;
  tool_calls?: {
    function: {
      name: string;
      arguments: JSONSchema7Object;
    };
  }[];
};

// See https://github.com/ollama/ollama/blob/main/docs/modelfile.md for details on each parameter
interface OllamaModelFileParams {
  mirostat?: number;
  mirostat_eta?: number;
  mirostat_tau?: number;
  num_ctx?: number;
  repeat_last_n?: number;
  repeat_penalty?: number;
  temperature?: number;
  seed?: number;
  stop?: string | string[];
  tfs_z?: number;
  num_predict?: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  num_gpu?: number;

  // Deprecated or not directly supported here:
  num_thread?: number;
  use_mmap?: boolean;
  num_gqa?: number;
  num_keep?: number;
  typical_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  penalize_newline?: boolean;
  numa?: boolean;
  num_batch?: number;
  main_gpu?: number;
  low_vram?: boolean;
  vocab_only?: boolean;
  use_mlock?: boolean;
}

// See https://github.com/ollama/ollama/blob/main/docs/api.md
interface OllamaBaseOptions {
  model: string; // the model name
  options?: OllamaModelFileParams; // additional model parameters listed in the documentation for the Modelfile such as temperature
  format?: "json"; // the format to return a response in. Currently, the only accepted value is json
  stream?: boolean; // if false the response will be returned as a single response object, rather than a stream of objects
  keep_alive?: number; // controls how long the model will stay loaded into memory following the request (default: 5m)
}

interface OllamaRawOptions extends OllamaBaseOptions {
  prompt: string; // the prompt to generate a response for
  suffix?: string; // the text after the model response
  images?: string[]; // a list of base64-encoded images (for multimodal models such as llava)
  system?: string; // system message to (overrides what is defined in the Modelfile)
  template?: string; // the prompt template to use (overrides what is defined in the Modelfile)
  context?: string; // the context parameter returned from a previous request to /generate, this can be used to keep a short conversational memory
  raw?: boolean; // if true no formatting will be applied to the prompt. You may choose to use the raw parameter if you are specifying a full templated prompt in your request to the API
}

interface OllamaChatOptions extends OllamaBaseOptions {
  messages: OllamaChatMessage[]; // the messages of the chat, this can be used to keep a chat memory
  tools?: OllamaTool[]; // the tools of the chat, this can be used to keep a tool memory
  // Not supported yet - tools: tools for the model to use if supported. Requires stream to be set to false
  // And correspondingly, tool calls in OllamaChatMessage
  think?: boolean; // if true the model will be prompted to think about the response before generating it
}

type OllamaBaseResponse = {
  model: string;
  created_at: string;
} & (
  | {
      done: false;
    }
  | {
      done: true;
      done_reason: string;
      total_duration: number; // Time spent generating the response in nanoseconds
      load_duration: number; // Time spent loading the model in nanoseconds
      prompt_eval_count: number; // Number of tokens in the prompt
      prompt_eval_cached_count?: number; // Of those, taken from the cache (newer servers)
      prompt_eval_duration: number; // Time spent evaluating the prompt in nanoseconds
      eval_count: number; // Number of tokens in the response
      eval_duration: number; // Time spent generating the response in nanoseconds
      context: number[]; // An encoding of the conversation used in this response; can be sent in the next request to keep conversational memory
    }
);

/**
 * The last line of a native chat reply (`done: true`) carries the counts and
 * the server's durations: put them on the reply as its usage, on the last
 * assistant message (or a message of its own).
 */
function withDoneUsage(
  res: OllamaChatResponse,
  messages: ChatMessage[],
): ChatMessage[] {
  if ("error" in res || !("done" in res) || !res.done) return messages;
  const usage = ollamaUsage(res);
  if (!usage) return messages;
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    return [...messages.slice(0, -1), { ...last, usage }];
  }
  return [...messages, { role: "assistant", content: "", usage }];
}

type OllamaErrorResponse = {
  error: string;
};

type N8nChatReponse = {
  type: string;
  content?: string;
  metadata: {
    nodeId: string;
    nodeName: string;
    itemIndex: number;
    runIndex: number;
    timestamps: number;
  };
};

type OllamaRawResponse =
  | OllamaErrorResponse
  | (OllamaBaseResponse & {
      response: string; // the generated response
    });

type OllamaChatResponse =
  | OllamaErrorResponse
  | (OllamaBaseResponse & {
      message: OllamaChatMessage;
    })
  | N8nChatReponse;

interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JSONSchema7;
  };
}

class Ollama extends BaseLLM implements ModelInstaller {
  static providerName = "ollama";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://localhost:11434/",
    model: "codellama-7b",
    maxEmbeddingBatchSize: 64,
  };

  private static modelsBeingInstalled: Set<string> = new Set();
  private static modelsBeingInstalledMutex = new Mutex();

  private fimSupported: boolean = false;

  private modelInfoPromise: Promise<void> | undefined = undefined;
  private explicitContextLength: boolean;
  /** `num_ctx` from the Modelfile, when it has one. */
  private modelfileNumCtx: number | undefined;
  /**
   * Whether the server said which window it runs the model with when the
   * request names none: undefined until asked, false when it did not say.
   */
  private serverSaidWindow: boolean | undefined;

  constructor(options: LLMOptions) {
    super(options);
    this.explicitContextLength = options.contextLength !== undefined;
  }

  private ensureModelInfo(): Promise<void> {
    if (this.modelInfoPromise) {
      return this.modelInfoPromise;
    }

    if (this.model === "AUTODETECT") {
      return Promise.resolve();
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    this.modelInfoPromise = this.fetch(this.getEndpoint("api/show"), {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ name: this._getModel() }),
    })
      .then(async (response) => {
        if (response?.status !== 200) {
          // console.warn(
          //   "Error calling Ollama /api/show endpoint: ",
          //   await response.text(),
          // );
          return;
        }
        const body = await response.json();
        if (body.parameters) {
          const params = [];
          for (const line of body.parameters.split("\n")) {
            let parts = line.match(/^(\S+)\s+((?:".*")|\S+)$/);
            if (!parts || parts.length < 2) {
              continue;
            }
            let key = parts[1];
            let value = parts[2];
            switch (key) {
              case "num_ctx":
                if (!this.explicitContextLength) {
                  const numCtx = Number.parseInt(value);
                  if (Number.isFinite(numCtx)) {
                    this.modelfileNumCtx = numCtx;
                    this._contextLength = numCtx;
                    this.contextLengthSource = "provider";
                  }
                }
                break;
              case "stop":
                if (!this.completionOptions.stop) {
                  this.completionOptions.stop = [];
                }
                try {
                  this.completionOptions.stop.push(JSON.parse(value));
                } catch (e) {
                  console.warn(
                    `Error parsing stop parameter value "{value}: ${e}`,
                  );
                }
                break;
              default:
                break;
            }
          }
        }

        /**
         * There is no API to get the model's FIM capabilities, so we have to
         * make an educated guess. If a ".Suffix" variable appears in the template
         * it's a good indication the model supports FIM.
         */
        this.fimSupported = !!body?.template?.includes(".Suffix");
      })
      .catch((e) => {
        // console.warn("Error calling the Ollama /api/show endpoint: ", e);
      });

    return this.modelInfoPromise;
  }

  /**
   * The `num_ctx` a request names: the person's context length, else the
   * Modelfile's. With neither the server picks the window (its own setting,
   * or what fits the machine), so a number chosen here must not replace it,
   * unless the server cannot say what it picked: then the request keeps
   * naming the window the prompt is cut to, so the two agree.
   */
  private _numCtxToSend(): number | undefined {
    if (this.explicitContextLength) {
      return this.contextLength;
    }
    if (this.modelfileNumCtx !== undefined) {
      return this.modelfileNumCtx;
    }
    return this.serverSaidWindow ? undefined : this.contextLength;
  }

  /**
   * When no window is set here, load the model the way the request will and
   * read the window it got from `/api/ps`, so the prompt is cut to the size
   * the server really uses. Asked until the server answers; a server that
   * answers without a window is not asked again.
   */
  private async ensureWindowInUse(signal: AbortSignal): Promise<void> {
    if (
      this.explicitContextLength ||
      this.modelfileNumCtx !== undefined ||
      this.serverSaidWindow !== undefined ||
      this.model === "AUTODETECT"
    ) {
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const model = this._getModel();
    try {
      // A request with no prompt only loads the model. It names no num_ctx,
      // like the request that follows, so both get the same window.
      const load = await this.fetch(this.getEndpoint("api/generate"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          keep_alive: this.completionOptions.keepAlive ?? 60 * 30,
        }),
        signal,
      });
      if (load?.status !== 200) {
        this.serverSaidWindow = false;
        return;
      }
      const ps = await this.fetch(this.getEndpoint("api/ps"), {
        method: "GET",
        headers,
        signal,
      });
      const body = ps?.status === 200 ? await ps.json() : undefined;
      const loaded = (body?.models ?? []).find(
        (m: { name?: string; model?: string }) =>
          [m.name, m.model].some(
            (name) => name === model || name === `${model}:latest`,
          ),
      );
      const window = loaded?.context_length;
      if (typeof window === "number" && window > 0) {
        this.serverSaidWindow = true;
        this._contextLength = window;
        this.contextLengthSource = "provider";
        // The next config load builds this model with the window, so the
        // model row shows it.
        rememberLearned(this.limitsKey, { contextLength: window });
      } else {
        this.serverSaidWindow = false;
      }
    } catch (e) {
      // Stopped or unreachable: the request itself reports that. Ask again
      // next time.
    }
  }

  // Map of "continue model name" to Ollama actual model name
  private modelMap: Record<string, string> = {
    "mistral-7b": "mistral:7b",
    "mixtral-8x7b": "mixtral:8x7b",
    "llama2-7b": "llama2:7b",
    "llama2-13b": "llama2:13b",
    "codellama-7b": "codellama:7b",
    "codellama-13b": "codellama:13b",
    "codellama-34b": "codellama:34b",
    "codellama-70b": "codellama:70b",
    "llama3-8b": "llama3:8b",
    "llama3-70b": "llama3:70b",
    "llama3.1-8b": "llama3.1:8b",
    "llama3.1-70b": "llama3.1:70b",
    "llama3.1-405b": "llama3.1:405b",
    "llama3.2-1b": "llama3.2:1b",
    "llama3.2-3b": "llama3.2:3b",
    "llama3.2-11b": "llama3.2:11b",
    "llama3.2-90b": "llama3.2:90b",
    "phi-2": "phi:2.7b",
    "phind-codellama-34b": "phind-codellama:34b-v2",
    "qwen2.5-coder-0.5b": "qwen2.5-coder:0.5b",
    "qwen2.5-coder-1.5b": "qwen2.5-coder:1.5b",
    "qwen2.5-coder-3b": "qwen2.5-coder:3b",
    "qwen2.5-coder-7b": "qwen2.5-coder:7b",
    "qwen2.5-coder-14b": "qwen2.5-coder:14b",
    "qwen2.5-coder-32b": "qwen2.5-coder:32b",
    "wizardcoder-7b": "wizardcoder:7b-python",
    "wizardcoder-13b": "wizardcoder:13b-python",
    "wizardcoder-34b": "wizardcoder:34b-python",
    "zephyr-7b": "zephyr:7b",
    "codeup-13b": "codeup:13b",
    "deepseek-1b": "deepseek-coder:1.3b",
    "deepseek-7b": "deepseek-coder:6.7b",
    "deepseek-33b": "deepseek-coder:33b",
    "neural-chat-7b": "neural-chat:7b-v3.3",
    "starcoder-1b": "starcoder:1b",
    "starcoder-3b": "starcoder:3b",
    "starcoder2-3b": "starcoder2:3b",
    "stable-code-3b": "stable-code:3b",
    "granite-code-3b": "granite-code:3b",
    "granite-code-8b": "granite-code:8b",
    "granite-code-20b": "granite-code:20b",
    "granite-code-34b": "granite-code:34b",
  };

  private _getModel() {
    return this.modelMap[this.model] ?? this.model;
  }

  get contextLength() {
    const DEFAULT_OLLAMA_CONTEXT_LENGTH = 8192; // twice of https://github.com/ollama/ollama/blob/29ddfc2cab7f5a83a96c3133094f67b22e4f27d1/envconfig/config.go#L185
    return this._contextLength ?? DEFAULT_OLLAMA_CONTEXT_LENGTH;
  }

  private _getModelFileParams(
    options: CompletionOptions,
  ): OllamaModelFileParams {
    return {
      temperature: options.temperature,
      top_p: options.topP,
      top_k: options.topK,
      num_predict: options.maxTokens,
      stop: options.stop,
      num_ctx: this._numCtxToSend(),
      mirostat: options.mirostat,
      num_thread: options.numThreads,
      use_mmap: options.useMmap,
      min_p: options.minP,
      num_gpu: options.numGpu,
    };
  }

  private _convertToOllamaMessage(message: ChatMessage): OllamaChatMessage {
    const ollamaMessage: OllamaChatMessage = {
      role: message.role,
      content: "",
    };

    ollamaMessage.content = renderChatMessage(message);

    // Convert assistant tool calls to Ollama format, stripping unsupported
    // fields like `index` (which causes errors on Gemma3 models).
    if (
      message.role === "assistant" &&
      "toolCalls" in message &&
      message.toolCalls?.length
    ) {
      ollamaMessage.tool_calls = message.toolCalls
        .filter((tc) => tc.function?.name)
        .map((tc) => {
          let args: JSONSchema7Object;
          if (typeof tc.function!.arguments === "string") {
            try {
              args = JSON.parse(tc.function!.arguments!);
            } catch (e) {
              console.warn(
                `Failed to parse tool call arguments for "${tc.function!.name}": ${e}`,
              );
              args = {};
            }
          } else {
            args = tc.function!.arguments
              ? (tc.function!.arguments as unknown as JSONSchema7Object)
              : {};
          }
          return {
            function: {
              name: tc.function!.name!,
              arguments: args,
            },
          };
        });
    }

    if (Array.isArray(message.content)) {
      const images: string[] = [];
      message.content.forEach((part) => {
        if (part.type === "imageUrl" && part.imageUrl) {
          const image = part.imageUrl?.url
            ? extractBase64FromDataUrl(part.imageUrl.url)
            : undefined;
          if (image) {
            images.push(image);
          } else if (part.imageUrl?.url) {
            console.warn(
              "Ollama: skipping image with invalid data URL format",
              part.imageUrl.url,
            );
          }
        }
      });
      if (images.length > 0) {
        ollamaMessage.images = images;
      }
    }

    return ollamaMessage;
  }

  private _getGenerateOptions(
    options: CompletionOptions,
    prompt: string,
    suffix?: string,
  ): OllamaRawOptions {
    return {
      model: this._getModel(),
      prompt,
      suffix,
      raw: options.raw,
      options: this._getModelFileParams(options),
      keep_alive: options.keepAlive ?? 60 * 30, // 30 minutes
      stream: options.stream,
      // Not supported yet: context, images, system, template, format
    };
  }

  private getEndpoint(endpoint: string): URL {
    let base = this.apiBase;
    if (process.env.IS_BINARY) {
      base = base?.replace("localhost", "127.0.0.1");
    }

    return new URL(endpoint, base);
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    await this.ensureModelInfo();
    await this.ensureWindowInUse(signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const response = await this.fetch(this.getEndpoint("api/generate"), {
      method: "POST",
      headers: headers,
      body: JSON.stringify(this._getGenerateOptions(options, prompt)),
      signal,
    });

    let buffer = "";
    for await (const value of streamResponse(response)) {
      // Append the received chunk to the buffer
      buffer += value;
      // Split the buffer into individual JSON chunks
      const chunks = buffer.split("\n");
      buffer = chunks.pop() ?? "";

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.trim() !== "") {
          try {
            const j = JSON.parse(chunk) as OllamaRawResponse;
            if ("error" in j) {
              throw new Error(j.error);
            }
            j.response ??= "";
            yield j.response;
          } catch (e) {
            throw new Error(`Error parsing Ollama response: ${e} ${chunk}`);
          }
        }
      }
    }
  }

  /**
   * Reorder messages so that system messages never appear directly after tool
   * messages. Some Ollama models (Mistral, Ministral) reject the sequence
   * `tool → system` with "Unexpected role 'system' after role 'tool'".
   * This moves such system messages to just before the preceding
   * assistant+tool block.
   */
  private _reorderMessagesForToolCompat(
    messages: OllamaChatMessage[],
  ): OllamaChatMessage[] {
    const result: OllamaChatMessage[] = [...messages];

    for (let i = 1; i < result.length; i++) {
      if (result[i].role === "system" && result[i - 1].role === "tool") {
        // Find the start of the tool block (assistant tool_call + tool results)
        let insertIdx = i - 1;
        while (insertIdx > 0 && result[insertIdx - 1].role === "tool") {
          insertIdx--;
        }
        // Also skip past the assistant message that triggered the tool calls
        if (insertIdx > 0 && result[insertIdx - 1].role === "assistant") {
          insertIdx--;
        }

        const [sysMsg] = result.splice(i, 1);
        result.splice(insertIdx, 0, sysMsg);
        // Don't increment i — re-check current position after splice
      }
    }

    return result;
  }

  /** The messages of a chat request. */
  protected _convertMessages(messages: ChatMessage[]): OllamaChatMessage[] {
    // Ollama has no "thinking" role; a reasoning turn is not sent back.
    return this._reorderMessagesForToolCompat(
      messages
        .filter((message) => message.role !== "thinking")
        .map(this._convertToOllamaMessage),
    );
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    await this.ensureModelInfo();
    await this.ensureWindowInUse(signal);
    const ollamaMessages = this._convertMessages(messages);
    const chatOptions: OllamaChatOptions = {
      model: this._getModel(),
      messages: ollamaMessages,
      options: this._getModelFileParams(options),
      think: options.reasoning,
      keep_alive: options.keepAlive ?? 60 * 30, // 30 minutes
      stream: options.stream,
      // format: options.format, // Not currently in base completion options
    };
    // Every request of a tool loop carries the tools: the one after a tool
    // result too, or the model cannot make its next call.
    if (options.tools?.length) {
      chatOptions.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }));
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const response = await this.fetch(this.getEndpoint("api/chat"), {
      method: "POST",
      headers: headers,
      body: JSON.stringify(chatOptions),
      signal,
    });
    let isThinking: boolean = false;

    function convertChatMessage(res: OllamaChatResponse): ChatMessage[] {
      if ("error" in res) {
        throw new Error(res.error);
      }

      if ("type" in res) {
        const { content } = res;

        if (content === "<think>") {
          isThinking = true;
        }

        if (isThinking && content) {
          // TODO better support for streaming thinking chunks, or remove this and depend on redux <think/> parsing logic
          const thinkingMessage: ThinkingChatMessage = {
            role: "thinking",
            content: content,
          };

          if (thinkingMessage) {
            // could cause issues with termination if chunk doesn't match this exactly
            if (content === "</think>") {
              isThinking = false;
            }
            // When Streaming you can't have both thinking and content
            return [thinkingMessage];
          }
        }

        if (content) {
          const chatMessage: ChatMessage = {
            role: "assistant",
            content: content,
          };
          return [chatMessage];
        }
        return [];
      }

      const { role, content, thinking, tool_calls: toolCalls } = res.message;

      if (role === "tool") {
        throw new Error(
          "Unexpected message received from Ollama with role = tool",
        );
      }

      if (role === "assistant") {
        const thinkingMessage: ThinkingChatMessage | null = thinking
          ? { role: "thinking", content: thinking }
          : null;

        if (thinkingMessage && !content && !toolCalls?.length) {
          // When Streaming you can't have both thinking and content
          return [thinkingMessage];
        }
        // Either not thinking, or not streaming
        const chatMessage: ChatMessage = { role: "assistant", content };

        if (toolCalls?.length) {
          // Continue handles the response as a tool call delta but
          // But ollama returns the full object in one response with no streaming
          chatMessage.toolCalls = toolCalls.map((tc) => ({
            type: "function",
            id: `tc_${uuidv4()}`, // Generate a proper UUID with a prefix
            function: {
              name: tc.function.name,
              arguments: JSON.stringify(tc.function.arguments),
            },
          }));
        }

        // Return both thinking and chat messages if applicable
        return thinkingMessage ? [thinkingMessage, chatMessage] : [chatMessage];
      }

      // Fallback for all other roles
      return [{ role, content }];
    }

    if (chatOptions.stream === false) {
      if (response.status === 499) {
        return; // Aborted by user
      }
      const json = (await response.json()) as OllamaChatResponse;
      for (const msg of withDoneUsage(json, convertChatMessage(json))) {
        yield msg;
      }
    } else {
      // Ollama ends every chat stream with a `done: true` line. Without one
      // the stream was cut off (server crash, proxy); n8n's format has no
      // such line, so only Ollama-shaped chunks count.
      let sawOllamaChunk = false;
      let sawDone = false;
      const parse = (chunk: string): ChatMessage[] => {
        let j: OllamaChatResponse;
        try {
          j = JSON.parse(chunk) as OllamaChatResponse;
        } catch (e) {
          throw new Error(`Error parsing Ollama response: ${e} ${chunk}`);
        }
        if ("done" in j) {
          sawOllamaChunk = true;
          if (j.done) sawDone = true;
        }
        try {
          return withDoneUsage(j, convertChatMessage(j));
        } catch (e) {
          throw new Error(`Error parsing Ollama response: ${e} ${chunk}`);
        }
      };

      let buffer = "";
      for await (const value of streamResponse(response)) {
        // Append the received chunk to the buffer
        buffer += value;
        // Split the buffer into individual JSON chunks
        const chunks = buffer.split("\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          if (chunk.trim() !== "") {
            yield* parse(chunk);
          }
        }
      }
      // The last line may arrive without a trailing newline.
      if (buffer.trim() !== "") {
        yield* parse(buffer);
      }

      if (sawOllamaChunk && !sawDone && !signal.aborted) {
        throw new Error(
          "The Ollama stream ended before the response was complete (no done: true).",
        );
      }
    }
  }

  supportsFim(): boolean {
    return this.fimSupported;
  }

  protected async *_streamFim(
    prefix: string,
    suffix: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    await this.ensureModelInfo();
    await this.ensureWindowInUse(signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const response = await this.fetch(this.getEndpoint("api/generate"), {
      method: "POST",
      headers: headers,
      body: JSON.stringify(this._getGenerateOptions(options, prefix, suffix)),
      signal,
    });

    let buffer = "";
    for await (const value of streamResponse(response)) {
      // Append the received chunk to the buffer
      buffer += value;
      // Split the buffer into individual JSON chunks
      const chunks = buffer.split("\n");
      buffer = chunks.pop() ?? "";

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.trim() !== "") {
          try {
            const j = JSON.parse(chunk);
            if ("response" in j) {
              yield j.response;
            } else if ("error" in j) {
              throw new Error(j.error);
            }
          } catch (e) {
            throw new Error(`Error parsing Ollama response: ${e} ${chunk}`);
          }
        }
      }
    }
  }

  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const response = await this.fetch(
      // localhost was causing fetch failed in pkg binary only for this Ollama endpoint
      this.getEndpoint("api/tags"),
      {
        method: "GET",
        headers: headers,
      },
    );
    const data = await response.json();
    if (response.ok) {
      return data.models.map((model: any) => model.name);
    } else {
      throw new Error(
        "Failed to list Ollama models. Make sure Ollama is running.",
      );
    }
  }

  protected async _embed(chunks: string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const resp = await this.fetch(new URL("api/embed", this.apiBase), {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        input: chunks,
      }),
      headers: headers,
    });

    if (!resp.ok) {
      throw new Error(`Failed to embed chunk: ${await resp.text()}`);
    }

    const data = await resp.json();
    const embedding: number[][] = data.embeddings;

    if (!embedding || embedding.length === 0) {
      throw new Error("Ollama generated empty embedding");
    }
    return embedding;
  }

  public async installModel(
    modelName: string,
    signal: AbortSignal,
    progressReporter?: (task: string, increment: number, total: number) => void,
  ): Promise<any> {
    const modelInfo = await getRemoteModelInfo(modelName, signal);
    if (!modelInfo) {
      throw new Error(`'${modelName}' not found in the Ollama registry!`);
    }

    const release = await Ollama.modelsBeingInstalledMutex.acquire();
    try {
      if (Ollama.modelsBeingInstalled.has(modelName)) {
        throw new Error(`Model '${modelName}' is already being installed.`);
      }
      Ollama.modelsBeingInstalled.add(modelName);
    } finally {
      release();
    }

    try {
      const response = await fetch(this.getEndpoint("api/pull"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ name: modelName }),
        signal,
      });

      const reader = response.body?.getReader();
      //TODO: generate proper progress based on modelInfo size
      while (true) {
        const { done, value } = (await reader?.read()) || {
          done: true,
          value: undefined,
        };
        if (done) {
          break;
        }

        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            progressReporter?.(data.status, data.completed, data.total);
          } catch (e) {
            console.warn(`Error parsing Ollama pull response: ${e}`);
          }
        }
      }
    } finally {
      const release = await Ollama.modelsBeingInstalledMutex.acquire();
      try {
        Ollama.modelsBeingInstalled.delete(modelName);
      } finally {
        release();
      }
    }
  }

  public async isInstallingModel(modelName: string): Promise<boolean> {
    const release = await Ollama.modelsBeingInstalledMutex.acquire();
    try {
      return Ollama.modelsBeingInstalled.has(modelName);
    } finally {
      release();
    }
  }
}

export default Ollama;
