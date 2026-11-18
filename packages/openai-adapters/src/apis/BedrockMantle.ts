import {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/index";
import { BedrockMantleConfig } from "../types.js";
import {
  alternateMantlePrefix,
  DroppableMantleParam,
  droppableParamFromError,
  getMantleErrorHint,
  isWrongRouteError,
  MANTLE_PATH_PREFIXES,
  mantleBaseUrl,
  MaxTokensParam,
  maxTokensParamFromError,
  normalizeMantlePrefix,
  toolsNeedReasoningOffFromError,
} from "./bedrockMantleHelpers.js";
import { OpenAIApi } from "./OpenAI.js";

/** Enough for the token parameter, a dropped field and reasoning off. */
const MAX_ADAPT_RETRIES = 4;

/** What a model refused, learned from its errors. */
interface MantleQuirks {
  prefix?: string;
  maxTokensParam?: MaxTokensParam;
  dropped: Set<DroppableMantleParam>;
  /** Send reasoning_effort "none" with function tools (Daybreak Blue). */
  toolsNeedReasoningOff: boolean;
}

/**
 * Per region and model, for the life of the process. The adapter is created
 * again for each request in some paths, and relearning cost one refused
 * request per quirk every time.
 */
const learnedQuirks = new Map<string, MantleQuirks>();

export function resetLearnedMantleQuirks(): void {
  learnedQuirks.clear();
}

/**
 * Amazon Bedrock "Mantle": an OpenAI-compatible endpoint at
 * `bedrock-mantle.<region>.api.aws`, authenticated with a Bedrock API key.
 *
 * Two things vary by model and are learned on the fly:
 *  - the path prefix (`/v1` for most models, `/openai/v1` for some); a request
 *    on the wrong one is rejected with a recognisable error and retried on the
 *    other prefix
 *  - the token-limit parameter (some models reject `max_tokens`)
 *  - fields a model refuses outright (Daybreak Blue refuses `stop`), which
 *    are left out from then on
 *  - that function tools need `reasoning_effort: "none"` (Daybreak Blue)
 * The path and token parameter can also be set explicitly
 * (`mantlePathPrefix`, `maxTokensParam`). What is learned is kept per region
 * and model for the life of the process.
 */
export class BedrockMantleApi extends OpenAIApi {
  private region: string;
  private prefix: string;
  private prefixIsFixed: boolean;
  private prefixSwaps = 0;
  private hasCustomApiBase: boolean;
  private maxTokensParam: MaxTokensParam | undefined;

  constructor(config: BedrockMantleConfig) {
    const env = config.env ?? {};
    const region = env.region ?? "us-east-1";
    const explicitPrefix = normalizeMantlePrefix(env.mantlePathPrefix);
    const prefix = explicitPrefix ?? MANTLE_PATH_PREFIXES[0];

    super({
      ...config,
      apiBase: config.apiBase ?? mantleBaseUrl(region, prefix),
      apiKey: config.apiKey || process.env.AWS_BEARER_TOKEN_BEDROCK || "",
    } as any);

    this.region = region;
    this.prefix = prefix;
    // A custom apiBase or an explicit prefix means the user decided; don't second-guess.
    this.hasCustomApiBase = !!config.apiBase;
    this.prefixIsFixed = this.hasCustomApiBase || !!explicitPrefix;
    this.maxTokensParam =
      env.maxTokensParam === "max_tokens" ||
      env.maxTokensParam === "max_completion_tokens"
        ? env.maxTokensParam
        : undefined;
  }

  modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    const modified = super.modifyChatBody(body);
    const quirks = this.quirksFor(modified.model);
    const tokenParam = this.maxTokensParam ?? quirks?.maxTokensParam;
    if (tokenParam === "max_completion_tokens" && modified.max_tokens != null) {
      modified.max_completion_tokens = modified.max_tokens;
      modified.max_tokens = undefined;
    } else if (
      tokenParam === "max_tokens" &&
      modified.max_completion_tokens != null
    ) {
      modified.max_tokens = modified.max_completion_tokens;
      modified.max_completion_tokens = undefined;
    }
    const fields = modified as unknown as Record<string, unknown>;
    for (const field of quirks?.dropped ?? []) {
      delete fields[field];
    }
    if (quirks?.toolsNeedReasoningOff && modified.tools?.length) {
      fields.reasoning_effort = "none";
    }
    return modified;
  }

  private quirksKey(model: string): string {
    return `${this.region}|${model}`;
  }

  private quirksFor(model: string): MantleQuirks | undefined {
    return learnedQuirks.get(this.quirksKey(model));
  }

  private learn(model: string): MantleQuirks {
    const key = this.quirksKey(model);
    let quirks = learnedQuirks.get(key);
    if (!quirks) {
      quirks = { dropped: new Set(), toolsNeedReasoningOff: false };
      learnedQuirks.set(key, quirks);
    }
    return quirks;
  }

  /** Use the path a model was found on, so a new adapter skips the wrong one. */
  private useLearnedPrefix(model: string): void {
    const learned = this.quirksFor(model)?.prefix;
    if (!learned || this.prefixIsFixed || learned === this.prefix) return;
    this.prefix = learned;
    this.apiBase = mantleBaseUrl(this.region, this.prefix);
    this.openai = this.createOpenAIClient();
  }

  /** Adjust settings in response to a recognised rejection. True means "retry". */
  private adaptToError(e: unknown, model: string): boolean {
    const message = e instanceof Error ? e.message : String(e);

    if (isWrongRouteError(message) && !this.prefixIsFixed) {
      this.prefix = alternateMantlePrefix(this.prefix);
      this.apiBase = mantleBaseUrl(this.region, this.prefix);
      this.openai = this.createOpenAIClient();
      // Two rejections in a row means neither prefix works for this model.
      this.prefixSwaps += 1;
      this.prefixIsFixed = this.prefixSwaps >= 2;
      this.learn(model).prefix = this.prefix;
      return true;
    }

    const tokenParam = maxTokensParamFromError(message);
    if (
      tokenParam &&
      tokenParam !==
        (this.maxTokensParam ?? this.quirksFor(model)?.maxTokensParam)
    ) {
      this.maxTokensParam = tokenParam;
      this.learn(model).maxTokensParam = tokenParam;
      return true;
    }

    const dropped = droppableParamFromError(message);
    if (dropped && !this.quirksFor(model)?.dropped.has(dropped)) {
      this.learn(model).dropped.add(dropped);
      console.debug(
        `Bedrock Mantle: ${model} refuses "${dropped}"; leaving it out of requests`,
      );
      return true;
    }

    if (
      toolsNeedReasoningOffFromError(message) &&
      !this.quirksFor(model)?.toolsNeedReasoningOff
    ) {
      this.learn(model).toolsNeedReasoningOff = true;
      return true;
    }

    return false;
  }

  private withHint(e: unknown): unknown {
    if (!(e instanceof Error)) return e;
    const hint = getMantleErrorHint(e.message, { region: this.region });
    if (hint && !e.message.includes(hint)) {
      e.message = `${e.message}\n\n${hint}`;
    }
    return e;
  }

  async chatCompletionNonStream(
    body: ChatCompletionCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<ChatCompletion> {
    this.useLearnedPrefix(body.model);
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.chatCompletionNonStream(body, signal);
      } catch (e) {
        if (attempt >= MAX_ADAPT_RETRIES || !this.adaptToError(e, body.model)) {
          throw this.withHint(e);
        }
      }
    }
  }

  async *chatCompletionStream(
    body: ChatCompletionCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    this.useLearnedPrefix(body.model);
    for (let attempt = 0; ; attempt++) {
      let yielded = false;
      try {
        for await (const chunk of super.chatCompletionStream(body, signal)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (e) {
        // Never retry once output has started: it would duplicate text.
        if (
          yielded ||
          attempt >= MAX_ADAPT_RETRIES ||
          !this.adaptToError(e, body.model)
        ) {
          throw this.withHint(e);
        }
      }
    }
  }

  /**
   * `GET /models` is only served under `/v1` (it 404s under `/openai/v1`), so
   * list through `/v1` regardless of the prefix used for inference.
   */
  async list() {
    const inferenceBase = this.apiBase;
    try {
      if (!this.hasCustomApiBase) {
        this.apiBase = mantleBaseUrl(this.region, MANTLE_PATH_PREFIXES[0]);
      }
      const client = this.createOpenAIClient();
      return (await client.models.list()).data;
    } catch (e) {
      throw this.withHint(e);
    } finally {
      this.apiBase = inferenceBase;
    }
  }
}
