/**
 * Pure helpers for the Bedrock adapter. Keep in sync with
 * core/llm/llms/bedrockHelpers.ts (core cannot import this package's sources).
 */
import {
  promptCacheFields,
  promptCacheSupportsLifetime,
} from "@continuedev/llm-info";

import {
  noteSamplingOmitted,
  omitsSampling,
} from "./anthropicSamplingGuard.js";
import {
  familyRuleFor,
  minMaxTokensFor,
  unsupportedInferenceFor,
} from "./bedrockFamilyRules.js";
import type { CacheTtl } from "./cacheTtl.js";

// The text-stream filters moved to ../dialects/textFilters.ts; re-exported so
// existing imports of this file keep working.
export {
  cleanReplyText,
  createThinkingTagSplitter,
  DEEPSEEK_DSML_MARKER,
  flushDsmlHold,
  holdBackDsmlMarker,
  leaksDsmlMarker,
  stripDsmlMarker,
  ThinkingTagSplitter,
  writesThinkingTags,
  type ThinkingSplit,
} from "../dialects/textFilters.js";

/** Geographic prefixes Bedrock uses for cross-region inference profile IDs. */
export const INFERENCE_PROFILE_PREFIXES = [
  "us",
  "us-gov",
  "eu",
  "apac",
  "jp",
  "au",
  "ca",
  "global",
] as const;

export type CrossRegionInference =
  "auto" | "us" | "us-gov" | "eu" | "apac" | "jp" | "au" | "ca" | "global";

/** Map an AWS region (e.g. eu-west-1) to the matching inference profile prefix. */
export function inferenceProfilePrefixForRegion(
  region: string | undefined,
): string | undefined {
  if (!region) return undefined;
  if (region.startsWith("us-gov-")) return "us-gov";
  if (region.startsWith("us-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return undefined;
}

/**
 * Apply the `crossRegionInference` setting to a model ID, e.g.
 * `anthropic.claude-sonnet-4-20250514-v1:0` -> `us.anthropic.claude-sonnet-4-20250514-v1:0`.
 *
 * IDs that already carry a prefix, and ARNs (inference profile / imported
 * model ARNs), are returned untouched so existing configs keep working.
 */
export function applyCrossRegionInference(
  modelId: string,
  setting: string | undefined,
  region: string | undefined,
): string {
  if (!setting) return modelId;
  if (modelId.startsWith("arn:")) return modelId;
  if (INFERENCE_PROFILE_PREFIXES.some((p) => modelId.startsWith(`${p}.`))) {
    return modelId;
  }
  const prefix =
    setting === "auto" ? inferenceProfilePrefixForRegion(region) : setting;
  if (!prefix) return modelId;
  return `${prefix}.${modelId}`;
}

/**
 * Turn common, cryptic AWS failures into a one-line next step.
 * Returns undefined when we have no useful advice.
 */
export function getBedrockErrorHint(
  error: unknown,
  ctx: { profile?: string; region?: string; usedProfile?: boolean },
): string | undefined {
  const err = error as { name?: string; message?: string } | undefined;
  const text = `${err?.name ?? ""} ${err?.message ?? ""}`;
  const profileArg = ctx.profile ? ` --profile ${ctx.profile}` : "";

  if (
    /sso/i.test(text) &&
    /(expired|invalid|refresh|login|token)/i.test(text)
  ) {
    return `Your AWS SSO session has expired or is missing. Run \`aws sso login${profileArg}\` and try again.`;
  }
  if (
    /ExpiredToken|security token included in the request is expired/i.test(text)
  ) {
    return "Your AWS credentials have expired. Refresh them (for SSO: `aws sso login`) or update the access key / session token in your config.";
  }
  if (
    /CredentialsProviderError|Could not load credentials|Missing credentials/i.test(
      text,
    )
  ) {
    return (
      "No AWS credentials found. Configure one of: `apiKey` (Bedrock API key, or the " +
      "AWS_BEARER_TOKEN_BEDROCK env var), `profile` (a profile from ~/.aws/config, " +
      "including SSO profiles), `accessKeyId` + `secretAccessKey` (+ `sessionToken` " +
      "for temporary credentials), or the standard AWS_* environment variables."
    );
  }
  if (
    /on-demand throughput isn.t supported|inference profile/i.test(text) &&
    /ValidationException|invocation/i.test(text)
  ) {
    return "This model needs an inference profile. Set `crossRegionInference: auto` (or us / eu / apac / global), or use the profile ID such as `us.anthropic.claude-...`.";
  }
  if (
    /AccessDeniedException/i.test(text) &&
    /model|bedrock:Invoke/i.test(text)
  ) {
    return `Access denied. Make sure the model is enabled for your account in the Bedrock console${
      ctx.region ? ` (region ${ctx.region})` : ""
    } and that your IAM identity allows bedrock:InvokeModel and bedrock:InvokeModelWithResponseStream.`;
  }
  return undefined;
}

/**
 * The message to show when Bedrock refuses a call because the AWS account has
 * not been granted the model, or undefined for any other error. AWS uses this
 * refusal for an unfinished console step and for a tokens-per-minute quota of
 * 0, which is how a newer model can look available and still be refused. The
 * error alone can't say which, so this lists what to check (seen live: form and
 * agreement done, quota 0).
 *
 * Core's Bedrock provider uses this too. The lines are joined by single
 * newlines because the chat window shows only what follows the first blank
 * line of an error (parseErrorMessage in gui/src/util/errorAnalysis.ts).
 */
export function bedrockModelAccessMessage(
  error: unknown,
  modelId: string,
): string | undefined {
  const err = error as { name?: string; message?: string } | undefined;
  const message = err?.message ?? "";
  if (
    !/AccessDeniedException/i.test(`${err?.name ?? ""} ${message}`) ||
    !/not available for this account/i.test(message)
  ) {
    return undefined;
  }
  return [
    `Amazon Bedrock refused ${modelId}: this AWS account has not been given access to that model.`,
    "Check the model's tokens-per-minute quota in Service Quotas: AWS can leave it at 0 for newer models until it grants the account access, and only AWS can raise it. For Anthropic models, also check that the use-case form and the model agreement are complete in the Bedrock console (https://console.aws.amazon.com/bedrock/).",
    `AWS said: ${message}`,
  ].join("\n");
}

/** The fields of Bedrock's `TokenUsage` that the adapter reads. */
export interface BedrockTokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** Writes split by lifetime; empty when nothing was written. */
  cacheDetails?: BedrockCacheDetailLike[];
}

/**
 * Map the usage in a Converse stream's `metadata` event to the OpenAI usage
 * shape, with the cache fields named as the Anthropic adapter names them.
 * With caching on, Bedrock's `inputTokens` counts only tokens that were
 * neither read from nor written to the cache, the same meaning as Anthropic's
 * `input_tokens`, so `prompt_tokens` keeps that meaning on both adapters.
 */
export function bedrockUsageToCompletionUsage(usage: BedrockTokenUsageLike): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: {
    cached_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cache_write_tokens_5m?: number;
    cache_write_tokens_1h?: number;
  };
} {
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheWriteInputTokens ?? 0;
  const split = splitCacheWrites(usage.cacheDetails);
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: {
      cached_tokens: read,
      cache_read_tokens: read,
      cache_write_tokens: write,
      // Only when Bedrock split the writes by lifetime, as the Anthropic
      // adapter does, so a 1-hour write is priced at the 1-hour rate.
      ...(split && {
        cache_write_tokens_5m: split.write5m,
        cache_write_tokens_1h: split.write1h,
      }),
    },
  };
}

/** Which parts of a request get a cache point. */
export interface BedrockCacheParts {
  tools: boolean;
  system: boolean;
  conversation: boolean;
}

/**
 * Decide which parts of a request get cache points. Keep in sync with
 * `resolveCacheParts` in core/llm/llms/anthropicCache.ts.
 *
 * An explicit `promptCaching: false` turns everything off, even when
 * `cacheBehavior` says otherwise. `true` caches the tools, the system prompt
 * and the conversation (up to four cache points: tools, system and the last
 * two user messages). When it is unset, only `cacheBehavior` applies, and with
 * nothing set no cache points are sent.
 */
export function resolveBedrockCacheParts(
  requested: boolean | undefined,
  behavior:
    { cacheSystemMessage?: boolean; cacheConversation?: boolean } | undefined,
  hasSystem: boolean,
): BedrockCacheParts {
  if (requested === false) {
    return { tools: false, system: false, conversation: false };
  }
  if (requested === true) {
    return { tools: true, system: hasSystem, conversation: true };
  }
  return {
    tools: false,
    system: !!(behavior?.cacheSystemMessage && hasSystem),
    conversation: !!behavior?.cacheConversation,
  };
}

/**
 * Which fields of a Converse request accept a `cachePoint` on this model, or
 * undefined for a model that accepts none: the Bedrock rows of the prompt
 * cache table in @continuedev/llm-info (`PROMPT_CACHE_RULES`, one place to
 * add a model). Claude takes one in `tools`, `system` and `messages`; the four
 * Nova models the AWS table lists take `system` and `messages` only (a cache
 * point in the tool list is refused, seen live 2026-11-04); GPT and Grok cache
 * by themselves and refuse any cache point. A `ttl` is a separate question
 * (`bedrockCacheTtl`).
 */
export function bedrockCachePointFields(
  modelId: string,
): BedrockCacheParts | undefined {
  const fields = promptCacheFields(modelId, "bedrock");
  return (
    fields && {
      tools: fields.tools,
      system: fields.system,
      conversation: fields.messages,
    }
  );
}

/**
 * `resolveBedrockCacheParts`, limited to the fields this model accepts a cache point
 * in, and nothing at all for a model that accepts none, so `promptCaching:
 * true` on a GPT, Grok or unlisted Nova model sends no `cachePoint` field (the
 * request would be refused).
 */
export function bedrockCachePartsForModel(
  modelId: string,
  requested: boolean | undefined,
  behavior:
    { cacheSystemMessage?: boolean; cacheConversation?: boolean } | undefined,
  hasSystem: boolean,
): BedrockCacheParts {
  const fields = bedrockCachePointFields(modelId);
  if (!fields) return { tools: false, system: false, conversation: false };
  const parts = resolveBedrockCacheParts(requested, behavior, hasSystem);
  return {
    tools: parts.tools && fields.tools,
    system: parts.system && fields.system,
    conversation: parts.conversation && fields.conversation,
  };
}

/**
 * Whether a cache point on this Bedrock model may carry `ttl: "1h"`: the rows
 * of the prompt cache table that list "5 minutes, 1 hour" (every Claude row of
 * the AWS table, checked 2026-11-04: Haiku 4.5 and 5.5, Sonnet 4.6, 5 and
 * 5.5, Opus 4.5 to 4.8, 5 and 5.5, Fable and Mythos). Sending `ttl` to a model
 * that only takes 5 minutes "can result in a ValidationException", so a model
 * the table does not list gets the default: Sonnet 4.5, Sonnet 4, Opus 4 and
 * 4.1, Claude 3.x, and Nova. Confirmed live with a 1-hour write and
 * `cacheDetails` on Haiku 4.5, Haiku 5.5, Sonnet 5.5 and Opus 5.5.
 */
export function bedrockSupportsOneHourCache(modelId: string): boolean {
  return promptCacheSupportsLifetime(modelId, "bedrock", "1h");
}

/** The `ttl` to put on a Bedrock cache point, or undefined for the default. */
export function bedrockCacheTtl(
  modelId: string,
  requested: CacheTtl | undefined,
): "1h" | undefined {
  return requested === "1h" && bedrockSupportsOneHourCache(modelId)
    ? "1h"
    : undefined;
}

/** A Bedrock cache point; `ttl` only when it is not the default. */
export function bedrockCachePoint(ttl: "1h" | undefined): {
  cachePoint: { type: "default"; ttl?: "1h" };
} {
  return { cachePoint: { type: "default", ...(ttl && { ttl }) } };
}

/** Per-lifetime cache writes Bedrock reports in `usage.cacheDetails`. */
export interface BedrockCacheDetailLike {
  ttl?: string;
  inputTokens?: number;
}

/** Sum `cacheDetails` into 5-minute and 1-hour writes; undefined when absent. */
export function splitCacheWrites(
  details: BedrockCacheDetailLike[] | undefined,
): { write5m: number; write1h: number } | undefined {
  if (!details?.length) return undefined;
  let write5m = 0;
  let write1h = 0;
  for (const d of details) {
    if (d.ttl === "1h") write1h += d.inputTokens ?? 0;
    else if (d.ttl === "5m") write5m += d.inputTokens ?? 0;
  }
  return { write5m, write1h };
}

const MISTRAL_TOOL_ID = /^[A-Za-z0-9]{9}$/;

/**
 * Mistral models on Bedrock accept only tool call IDs of exactly nine letters
 * or digits ("Tool call id was ... but must be a-z, A-Z, 0-9, with a length of
 * 9"). Their own IDs already look like that, but a conversation can hold IDs
 * from another model (Claude and Nova use `tooluse_...`) after a model switch.
 */
export function bedrockNeedsNineCharToolIds(modelId: string): boolean {
  return /(^|\.)mistral\./i.test(modelId);
}

/** A stable nine-character letters-and-digits ID for `id`. */
export function nineCharToolId(id: string): string {
  if (MISTRAL_TOOL_ID.test(id)) return id;
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  // Two FNV-1a passes give ~64 bits, enough for nine base-62 digits.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  let n = BigInt(h1) * 0x100000000n + BigInt(h2);
  let out = "";
  for (let i = 0; i < 9; i++) {
    out += alphabet[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

/**
 * Rewrites toolUse and toolResult IDs in converted Converse messages for
 * models that need nine-character IDs. The same input ID always maps to the
 * same output, so each toolResult still matches its toolUse.
 */
export function normalizeToolUseIds<
  M extends {
    content?: Array<{
      toolUse?: { toolUseId?: string };
      toolResult?: { toolUseId?: string };
    }>;
  },
>(messages: M[], modelId: string): M[] {
  if (!bedrockNeedsNineCharToolIds(modelId)) return messages;
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.toolUse?.toolUseId) {
        block.toolUse.toolUseId = nineCharToolId(block.toolUse.toolUseId);
      }
      if (block.toolResult?.toolUseId) {
        block.toolResult.toolUseId = nineCharToolId(block.toolResult.toolUseId);
      }
    }
  }
  return messages;
}

/**
 * Gives every toolUse a toolResult in the message right after it, with `text`
 * as the result of any that has none, and puts those results first in that
 * message. Claude refuses both a conversation with an unanswered tool call
 * and one whose results come after other content ("tool_use ids were found
 * without tool_result blocks immediately after"; Anthropic's tool-use docs:
 * "the tool_result blocks must come FIRST in the content array"). A turn cut
 * off mid-call can leave either: a call with no id turned into text ahead of
 * the next real result is how a resumed session was refused.
 */
export function fillMissingToolResults<
  M extends {
    role?: string;
    content?: Array<{
      toolUse?: { toolUseId?: string };
      toolResult?: unknown;
      text?: unknown;
    }>;
  },
>(messages: M[], text: string): M[] {
  type Block = NonNullable<M["content"]>[number];
  const resultId = (block: Block) =>
    (block.toolResult as { toolUseId?: string } | undefined)?.toolUseId;
  const filled: M[] = [];
  messages.forEach((message, index) => {
    filled.push(message);
    if (message.role !== "assistant") return;
    const callIds = new Set(
      (message.content ?? [])
        .map((block) => block.toolUse?.toolUseId)
        .filter((id): id is string => id !== undefined),
    );
    if (callIds.size === 0) return;
    const next = messages[index + 1];
    const nextContent = next?.role === "user" ? (next.content ?? []) : [];
    const answered = new Set(nextContent.map(resultId));
    const results = [...callIds]
      .filter((id) => !answered.has(id))
      .map(
        (toolUseId) =>
          ({ toolResult: { toolUseId, content: [{ text }] } }) as Block,
      );
    if (next?.role !== "user") {
      if (results.length) filled.push({ role: "user", content: results } as M);
      return;
    }
    const isAnswer = (block: Block) => {
      const id = resultId(block);
      return id !== undefined && callIds.has(id);
    };
    const answers = nextContent.filter(isAnswer);
    const rest = nextContent.filter((block) => !isAnswer(block));
    const ordered = [...results, ...answers, ...rest];
    if (ordered.some((block, i) => block !== nextContent[i])) {
      next.content = ordered;
    }
  });
  return filled;
}

/** The text of a user turn added only because a conversation must start with one. */
export const CONVERSE_LEADING_USER_TEXT = ".";

type ConverseBlockLike = {
  text?: unknown;
  toolUse?: { toolUseId?: string };
  toolResult?: { toolUseId?: string; content?: Array<{ text?: unknown }> };
  cachePoint?: unknown;
};

function isBlankText(block: ConverseBlockLike): boolean {
  return typeof block.text === "string" && block.text.trim() === "";
}

/**
 * Makes converted Converse messages a conversation Bedrock accepts, without
 * touching one that already is. Converse wants roles that alternate, a user
 * message first, no message without content and no blank text block, and a
 * toolResult only in the message right after its toolUse.
 *
 * A history breaks that when a turn converts to nothing: an assistant reply
 * that was stopped or failed before any text, one that held only reasoning
 * the model can't take back, a tool call without an id or name, a user
 * message whose context rendered empty. Such a turn is dropped and the
 * turns around it, now of the same role, are joined in order. A toolResult
 * that no longer follows its toolUse becomes text, as one without any
 * toolUse already does. A cache point is kept only where it follows content.
 */
export function repairConverseTurns<
  M extends { role?: string; content?: ConverseBlockLike[] },
>(messages: M[]): M[] {
  const kept: M[] = [];
  for (const message of messages) {
    const content = message.content ?? [];
    let changed = false;
    const blocks: ConverseBlockLike[] = [];
    for (const block of content) {
      const afterContent =
        blocks.length > 0 && blocks[blocks.length - 1].cachePoint === undefined;
      if (
        isBlankText(block) ||
        (block.cachePoint !== undefined && !afterContent)
      ) {
        changed = true;
        continue;
      }
      blocks.push(block);
    }
    if (blocks.length === 0) continue;
    const previous = kept[kept.length - 1];
    if (previous && previous.role === message.role) {
      kept[kept.length - 1] = {
        ...previous,
        content: [...(previous.content ?? []), ...blocks],
      } as M;
    } else {
      kept.push(changed ? ({ ...message, content: blocks } as M) : message);
    }
  }

  // A toolResult must answer a toolUse of the message just before it
  for (let i = 0; i < kept.length; i++) {
    const message = kept[i];
    const content = message.content ?? [];
    if (message.role !== "user" || !content.some((b) => b.toolResult)) {
      continue;
    }
    const previous = kept[i - 1];
    const used = new Set(
      previous?.role === "assistant"
        ? (previous.content ?? []).map((b) => b.toolUse?.toolUseId)
        : [],
    );
    const unmatched = (b: ConverseBlockLike) =>
      b.toolResult !== undefined && !used.has(b.toolResult.toolUseId);
    if (!content.some(unmatched)) continue;
    kept[i] = {
      ...message,
      content: content.map((block) => {
        if (!unmatched(block)) return block;
        const output =
          (block.toolResult!.content ?? [])
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .filter((text) => text !== "")
            .join("\n") || "No tool output";
        return {
          text: `Tool call output for Tool Call ID ${block.toolResult!.toolUseId}:\n\n${output}`,
        };
      }),
    } as M;
  }

  if (kept.length > 0 && kept[0].role !== "user") {
    kept.unshift({
      role: "user",
      content: [{ text: CONVERSE_LEADING_USER_TEXT }],
    } as M);
  }
  return kept;
}

/**
 * Whether Bedrock refused a request because it does not know the model ID.
 * Happens when `crossRegionInference: auto` put a geographic prefix on a
 * model that is only offered on demand (`qwen.*`, `deepseek.v3.2`, the newer
 * Mistral models): `us.qwen.qwen3-32b-v1:0` answers "The provided model
 * identifier is invalid".
 */
export function isInvalidModelIdentifierError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e ?? "");
  return /provided model identifier is invalid/i.test(message);
}

/**
 * The model ID to retry with when the prefixed one is refused as invalid: the
 * bare ID, but only when the prefix was guessed from the region by `auto`. An
 * explicit prefix or an ID the user wrote with a prefix is their choice and is
 * not second-guessed.
 */
export function crossRegionFallbackModelId(
  modelId: string,
  setting: string | undefined,
  region: string | undefined,
): string | undefined {
  if (setting !== "auto") return undefined;
  const applied = applyCrossRegionInference(modelId, setting, region);
  return applied === modelId ? undefined : modelId;
}

export type BedrockReasoningEffort = "low" | "medium" | "high";

/**
 * Inverse of the GUI mapping (low: 1024, medium: 4096, high: 16384). Same as
 * `budgetTokensToEffort` in core/llm/llms/anthropicThinking.ts.
 */
export function budgetTokensToEffort(
  budgetTokens: number,
): BedrockReasoningEffort {
  if (budgetTokens <= 1024) return "low";
  if (budgetTokens <= 4096) return "medium";
  return "high";
}

/** The budget tokens the GUI uses for an effort (gui/src/util/modeModels.ts). */
export function effortToBudgetTokens(effort: BedrockReasoningEffort): number {
  return effort === "low" ? 1024 : effort === "medium" ? 4096 : 16384;
}

/**
 * Claude models that refuse `thinking.type: "enabled"` and take `adaptive`
 * with `output_config.effort`. Same as `supportsAdaptiveThinking` in
 * core/llm/llms/anthropicThinking.ts.
 */
const ADAPTIVE_THINKING_MODEL =
  /claude-(opus|sonnet|haiku|fable|mythos)-(4-[6-9]|[5-9])/;

/**
 * Claude models whose `thinking.display` defaults to "omitted" (empty thinking
 * text), and those that think with no `thinking` field. Same as
 * `thinkingDisplayDefaultsToOmitted` and `thinksByDefault` in
 * core/llm/llms/anthropicThinking.ts.
 */
const OMITTED_DISPLAY_MODEL =
  /claude-(?:(?:opus|sonnet|haiku)-(?:4-[7-9]|[5-9])|fable|mythos)/;
const THINKS_BY_DEFAULT_MODEL =
  /claude-(?:(?:opus|sonnet|haiku)-[5-9]|fable|mythos)/;

/** Claude's thinking request fields, as `getAnthropicThinkingParams` builds them. */
export interface ClaudeThinkingFields {
  thinking?:
    | { type: "enabled"; budget_tokens: number }
    | { type: "adaptive"; display?: "summarized" };
  output_config?: { effort: BedrockReasoningEffort };
}

/**
 * Claude's `thinking` and `output_config` for a reasoning switch, the same on
 * Anthropic's API, Vertex and Bedrock: `display: "summarized"` where the
 * thinking would otherwise arrive empty, and a model that thinks anyway gets
 * that field with reasoning off too; adaptive thinking with an effort on 4.6
 * and later, a token budget before. Same as `getAnthropicThinkingParams` in
 * core/llm/llms/anthropicThinking.ts, which
 * core/llm/llms/anthropicThinkingParity.vitest.ts compares with this one.
 */
export function claudeThinkingFields(
  modelId: string,
  reasoning: boolean | undefined,
  budgetTokens: number,
): ClaudeThinkingFields {
  const summarize = OMITTED_DISPLAY_MODEL.test(modelId);
  if (!reasoning) {
    return summarize && THINKS_BY_DEFAULT_MODEL.test(modelId)
      ? { thinking: { type: "adaptive", display: "summarized" } }
      : {};
  }
  if (ADAPTIVE_THINKING_MODEL.test(modelId)) {
    return {
      thinking: summarize
        ? { type: "adaptive", display: "summarized" }
        : { type: "adaptive" },
      output_config: { effort: budgetTokensToEffort(budgetTokens) },
    };
  }
  return { thinking: { type: "enabled", budget_tokens: budgetTokens } };
}

/**
 * Claude models whose thinking display defaults to "omitted": their thinking
 * summaries are not sent back to Anthropic's API (see
 * `thinkingDisplayDefaultsToOmitted` in core/llm/llms/anthropicThinking.ts).
 */
export function claudeThinkingDisplayDefaultsToOmitted(
  modelId: string,
): boolean {
  return OMITTED_DISPLAY_MODEL.test(modelId);
}

/** What a Converse request sends to turn a model's reasoning on or off. */
export interface BedrockReasoningRequest {
  /** Spread into `additionalModelRequestFields`; empty when nothing is sent. */
  additionalModelRequestFields: Record<string, unknown>;
  /** Nova 2 refuses `maxTokens` when its reasoning effort is `high`. */
  omitMaxTokens: boolean;
}

const NOVA_2_MODEL = /nova-2-/i;
/** Nova 2's effort when the config says nothing about reasoning. */
const NOVA_2_DEFAULT_EFFORT = "low";
/** Qwen3 and DeepSeek V3.2 share a backend that takes `reasoning_effort`. */
const REASONING_EFFORT_MODEL = /(^|\.)(qwen\.|deepseek\.v3)/i;

/**
 * The reasoning switch per model family, measured live on 2026-11-08: Claude
 * takes Anthropic's `thinking` (with `display: "summarized"` where the
 * thinking would otherwise arrive empty); Nova 2 takes `reasoningConfig` with a
 * `maxReasoningEffort` and no `maxTokens` at `high`; Qwen3 and DeepSeek V3.2
 * take `reasoning_effort` (low, medium, high to turn on, `"none"` to turn off,
 * sent only when reasoning is explicitly off); DeepSeek R1, the other Nova
 * models, Llama and Mistral get nothing. The two copies (this one and
 * core/llm/llms/bedrockHelpers.ts) are compared by
 * core/llm/llms/bedrockReasoningFields.vitest.ts.
 */
export function bedrockReasoningFields(
  modelId: string,
  reasoning: boolean | undefined,
  budgetTokens: number,
): BedrockReasoningRequest {
  const none = { additionalModelRequestFields: {}, omitMaxTokens: false };
  if (/claude/i.test(modelId)) {
    return {
      additionalModelRequestFields: {
        ...claudeThinkingFields(modelId, reasoning, budgetTokens),
      },
      omitMaxTokens: false,
    };
  }
  if (NOVA_2_MODEL.test(modelId)) {
    if (reasoning === false) return none;
    // On at low by default: with no reasoningConfig Nova 2 Lite writes its
    // deliberation as plain text to the output budget and makes no tool call
    // (plans/turn-prompt-eval.md section 4, item 4, measured 2026-11-08).
    const effort =
      reasoning === undefined
        ? NOVA_2_DEFAULT_EFFORT
        : budgetTokensToEffort(budgetTokens);
    return {
      additionalModelRequestFields: {
        reasoningConfig: { type: "enabled", maxReasoningEffort: effort },
      },
      omitMaxTokens: effort === "high",
    };
  }
  // Families with a documented Converse field (bedrockFamilyRules.ts; Kimi K3
  // and K3.1 today). Nothing is sent when the config says nothing, so the
  // model's own default (`max` for Kimi K3) applies.
  const family = familyRuleFor(modelId)?.converseReasoning;
  if (family) {
    if (reasoning === undefined) return none;
    return {
      additionalModelRequestFields: {
        [family.field]: reasoning
          ? budgetTokensToEffort(budgetTokens)
          : (family.off ?? "none"),
      },
      omitMaxTokens: false,
    };
  }
  if (REASONING_EFFORT_MODEL.test(modelId)) {
    if (reasoning === undefined) return none;
    return {
      additionalModelRequestFields: {
        reasoning_effort: reasoning
          ? budgetTokensToEffort(budgetTokens)
          : "none",
      },
      omitMaxTokens: false,
    };
  }
  return none;
}

/**
 * The sampling fields a Claude model on Bedrock accepts: `temperature` and
 * `topP` together are refused even without thinking, so only `temperature` is
 * kept when both are set; with thinking on neither is sent. Other families
 * take both. Two copies, as `bedrockReasoningFields`.
 */
export function bedrockSamplingParams(
  modelId: string,
  temperature: number | undefined,
  topP: number | undefined,
  reasoning: boolean,
  omitSampling?: boolean,
): { temperature?: number; topP?: number } {
  if (omitSampling === true) {
    noteSamplingOmitted(modelId, true);
    return {};
  }
  if (!/claude/i.test(modelId)) return { temperature, topP };
  if (omitsSampling(modelId, omitSampling)) {
    noteSamplingOmitted(modelId);
    return {};
  }
  if (reasoning) return {};
  if (temperature !== undefined && topP !== undefined) return { temperature };
  return { temperature, topP };
}

const omittedLogged = new Set<string>();

/**
 * Leaves out the `inferenceConfig` fields a family refuses (measured
 * 2026-11-10, `unsupportedInference` in bedrockFamilyRules.ts): Kimi K3 answers
 * "This model doesn't support the temperature field", Kimi K3, GLM 5, Nemotron
 * 3 Super and gpt-oss the same for `stopSequences`. A configured temperature or
 * stop list would otherwise fail every request for that model. Each omission
 * is logged once per model and field, not silently dropped. Two copies, as
 * `bedrockReasoningFields`.
 */
export function bedrockOmitUnsupportedInference<
  T extends { temperature?: number; topP?: number; stopSequences?: string[] },
>(modelId: string, config: T): T {
  const refused = unsupportedInferenceFor(modelId);
  if (refused.length === 0) return config;
  const out = { ...config };
  for (const field of refused) {
    if (out[field] === undefined) continue;
    delete out[field];
    const key = `${modelId}:${field}`;
    if (!omittedLogged.has(key)) {
      omittedLogged.add(key);
      console.debug(
        `Bedrock: ${modelId} does not accept ${field} on Converse; omitting it from the request`,
      );
    }
  }
  return out;
}

/**
 * Raises a tiny `maxTokens` for a family that reasons whether or not asked to
 * (`minMaxTokens` in bedrockFamilyRules.ts): Kimi K3 and K3.1, Kimi K2
 * Thinking, MiniMax M2.5 and gpt-oss spent a 20-token budget entirely on
 * reasoning and returned no visible text. Undefined stays undefined. Two
 * copies, as `bedrockReasoningFields`.
 */
export function bedrockMinMaxTokens(
  modelId: string,
  maxTokens: number | undefined,
): number | undefined {
  const floor = minMaxTokensFor(modelId);
  if (maxTokens === undefined || floor === undefined) return maxTokens;
  return Math.max(maxTokens, floor);
}

/**
 * Models whose tool calls must go through Converse rather than
 * ConverseStream. Measured live (2026-11-08 and bsf-2026-11-10, n=8 per cell):
 *
 * - Llama 3.1 70B, Llama 3.3 70B, Llama 4 Scout, Mistral Large 2 (2407) and
 *   Pixtral Large refuse every ConverseStream request that carries tools with
 *   "This model doesn't support tool use in streaming mode." (8 of 8 each);
 *   Llama 4 Maverick was measured 2026-11-08. The same request to Converse
 *   returns a proper toolUse block.
 * - Documented only, not measured: Llama 3.1 8B, Mistral Large 2402 and Writer
 *   Palmyra X4 and X5 are on the same list on AWS's "Client-side tool use"
 *   page (https://docs.aws.amazon.com/bedrock/latest/userguide/tool-use-client-side.html,
 *   read 2026-11-10). Mistral Large 3 streams tools cleanly and is not listed.
 * - Qwen3 32B streams tool input with its opening `{` missing about half the
 *   time (4 of 8), so the arguments do not parse; Converse returned complete
 *   input every time. Qwen3 Coder 30B truncated to `{` once in 8 and is not
 *   listed here: the parse check in the stream handler covers it.
 *
 * Requests without tools stream as usual. There are two copies, this one and
 * core/llm/llms/bedrockHelpers.ts (see
 * `bedrockSupportsOneHourCache` for why).
 */
const NON_STREAMING_TOOL_MODELS: RegExp[] = [
  /(^|\.)meta\.llama4-/i,
  // Measured: 70B. Documented only: 8B.
  /(^|\.)meta\.llama3-1-/i,
  // Measured: 70B.
  /(^|\.)meta\.llama3-3-/i,
  // Measured: 2407. Documented only: 2402. Not mistral-large-3.
  /(^|\.)mistral\.mistral-large-24\d\d($|[-:])/i,
  // Measured.
  /(^|\.)mistral\.pixtral-large/i,
  // Documented only.
  /(^|\.)writer\.palmyra-x[45]($|[-:])/i,
  // Measured: half of the requests.
  /(^|\.)qwen\.qwen3-32b($|[-:])/i,
];

export function bedrockToolsNeedNonStreaming(modelId: string): boolean {
  return NON_STREAMING_TOOL_MODELS.some((m) => m.test(modelId));
}

/**
 * Whether the input a toolUse block streamed is JSON. Qwen3 32B opened its
 * input with `path": "src/main.ts"}` (the `{"` missing, 4 of 8 requests) and
 * Qwen3 Coder 30B ended it at `{` (1 of 8), measured 2026-11-10. An empty
 * input is a tool without arguments.
 */
export function toolInputParses(input: string): boolean {
  if (input.trim() === "") return true;
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

/** The env variable that turns streamed tool input repair on ("1"). Off by default. */
export const REPAIR_STREAMED_TOOL_INPUT_ENV =
  "CONTINUE_BEDROCK_REPAIR_STREAMED_TOOL_INPUT";

/**
 * Families whose broken streamed tool input may be repaired when the repair
 * switch is on. Deliberately the two Qwen3 families measured broken
 * (bsf-2026-11-10); a family is added only with recorded broken streams the
 * repair recovers exactly. Two copies, as `bedrockToolsNeedNonStreaming`.
 */
const REPAIRABLE_TOOL_STREAM_MODELS: RegExp[] = [/(^|\.)qwen\.qwen3-/i];

/** Whether to try `repairStreamedToolInput` on this model's broken tool input. */
export function bedrockRepairsStreamedToolInput(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env[REPAIR_STREAMED_TOOL_INPUT_ENV] === "1" &&
    REPAIRABLE_TOOL_STREAM_MODELS.some((m) => m.test(modelId))
  );
}

function plainObjectKeys(text: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return Object.keys(value);
  } catch {
    return undefined;
  }
}

/** The closers that end every bracket still open, or undefined inside a string. */
function openClosers(text: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return undefined;
    }
  }
  return inString ? undefined : stack.reverse().join("");
}

/**
 * A deterministic repair of the tool input a stream delivered, or undefined
 * when it is not safe. Never invents a value: the result is the input with
 * one of two changes, and anything else is rejected (the caller then retries
 * through Converse).
 *
 * 1. The opening `{"` missing (Qwen3 32B, 4 of 8 streams, bsf-2026-11-10:
 *    `path": "src/main.ts"}`): the repair is `{"` before the input, accepted
 *    only when the result is an object and every top-level key is one the tool
 *    declares (`allowedKeys`), so a key that lost its first letters is never
 *    accepted. Without `allowedKeys` this rule does not apply.
 * 2. Brackets left open after a complete member (`{"a": "x"`): the repair is
 *    the closing brackets after the input, accepted only when the input ends
 *    in a string, `true`, `false`, `null` or a closer (not in a string, after
 *    a number that may be cut short, or after `{`, `,` or `:`, where a
 *    truncated stream would be turned into an empty or shorter call, as
 *    Qwen3 Coder 30B's `{` would become `{}`).
 *
 * Input that already parses, and empty input, is returned unchanged.
 */
export function repairStreamedToolInput(
  input: string,
  options: { allowedKeys?: readonly string[] } = {},
): string | undefined {
  if (input.trim() === "") return input;
  if (toolInputParses(input)) return input;
  const { allowedKeys } = options;
  const keysAllowed = (keys: string[]) =>
    allowedKeys !== undefined && keys.every((k) => allowedKeys.includes(k));

  if (/^[A-Za-z_][\w-]*"\s*:/.test(input)) {
    const candidate = `{"${input}`;
    const keys = plainObjectKeys(candidate);
    return keys && keys.length > 0 && keysAllowed(keys) ? candidate : undefined;
  }

  const trimmed = input.trimEnd();
  if (!trimmed.startsWith("{")) return undefined;
  if (!/(["el}\]])$/.test(trimmed) || /[0-9]$/.test(trimmed)) return undefined;
  const closers = openClosers(trimmed);
  if (!closers) return undefined;
  const candidate = trimmed + closers;
  const keys = plainObjectKeys(candidate);
  if (!keys || keys.length === 0) return undefined;
  if (allowedKeys !== undefined && !keysAllowed(keys)) return undefined;
  return candidate;
}

/**
 * Families whose tool-argument deltas are passed on as they arrive, without
 * the hold-and-parse check of `ToolInputGate`. The list is deliberately short:
 * first-party Claude and Nova only. Every other model is held and checked,
 * because 8 of 8 clean streams (bsf-2026-11-10) do not prove a model streams
 * cleanly, and AWS re:Post
 * (https://repost.aws/questions/QUdavvWt4aS-Km2zK71OFUSA) and AgentCore SDK
 * issue 425 report corrupted streamed tool input for gpt-oss, which measured
 * clean here. Holding costs only delayed argument deltas. A follow-up
 * measurement at n>=30 per family decides who can be promoted to this list.
 * Two copies, as `bedrockToolsNeedNonStreaming`.
 */
const CLEAN_TOOL_STREAM_MODELS: RegExp[] = [
  /(^|\.)anthropic\.claude/i,
  /(^|\.)amazon\.nova/i,
];

export function bedrockStreamsToolInputCleanly(modelId: string): boolean {
  return CLEAN_TOOL_STREAM_MODELS.some((m) => m.test(modelId));
}

/**
 * The top-level property names the tool `name` declares in its input schema
 * (toolConfig.tools), or undefined when the tool or its schema is unknown.
 */
export function toolSchemaKeys(
  tools: unknown,
  name: string | undefined,
): string[] | undefined {
  if (!name || !Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    const spec = tool?.toolSpec;
    if (spec?.name !== name) continue;
    const properties = spec.inputSchema?.json?.properties;
    return properties && typeof properties === "object"
      ? Object.keys(properties)
      : undefined;
  }
  return undefined;
}

/**
 * Holds one streamed toolUse block (its start and input fragments) until the
 * block ends, so its input can be checked before any of it reaches the caller,
 * who runs the tool only once the reply is over. `close` says what to do with
 * a block whose input does not parse: retry the turn through Converse when
 * nothing irreversible has gone out (no text or reasoning, no earlier tool
 * call), so no call can run twice; otherwise release the block as streamed.
 * The caller remembers the model either way. A gate made with `hold` false
 * (see `bedrockStreamsToolInputCleanly`) passes everything through, so those
 * models keep progressive tool-argument deltas. Two copies, as
 * `bedrockToolsNeedNonStreaming`.
 */
export class ToolInputGate<T> {
  /**
   * `repair`, when given (see `bedrockRepairsStreamedToolInput`), is tried on
   * input that does not parse: a repaired input is released as the block's
   * start and one fragment made by `repair.fragment`, with the id the stream
   * gave, so nothing is retried and the id the history keeps is unchanged.
   */
  constructor(
    private readonly hold: boolean,
    private readonly repair?: {
      input: (input: string) => string | undefined;
      fragment: (input: string) => T;
    },
  ) {}

  private held: { parts: T[]; input: string } | undefined;
  private released = false;
  private output = false;

  get holding(): boolean {
    return this.held !== undefined;
  }

  /** Text or reasoning went to the caller (or may have), so a retry would repeat it. */
  noteOutput(): void {
    this.output = true;
  }

  /** What to yield now: the block's start, unless the gate is holding it. */
  open(part: T): T[] {
    if (!this.hold) return [part];
    this.held = { parts: [part], input: "" };
    return [];
  }

  add(part: T, fragment: string | undefined): void {
    if (!this.held) return;
    this.held.parts.push(part);
    this.held.input += fragment ?? "";
  }

  close(): { parts: T[]; broken: boolean; retry: boolean } {
    const held = this.held;
    this.held = undefined;
    if (!held) return { parts: [], broken: false, retry: false };
    const broken = !toolInputParses(held.input);
    const repaired = broken ? this.repair?.input(held.input) : undefined;
    if (repaired !== undefined && this.repair) {
      this.released = true;
      return {
        parts: [held.parts[0], this.repair.fragment(repaired)],
        broken: false,
        retry: false,
      };
    }
    const retry = broken && !this.output && !this.released;
    if (retry) return { parts: [], broken, retry };
    this.released = true;
    return { parts: held.parts, broken, retry };
  }
}

/** Bedrock's refusal of tools in ConverseStream, for a retry through Converse. */
export function isStreamingToolUseUnsupportedError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e ?? "");
  return /doesn't support tool use in streaming mode/i.test(message);
}

/**
 * Whether a conversation cache point may only follow a text block of a user
 * message. Nova refuses a cachePoint next to a toolResult ("extraneous key
 * [cachePoint]", seen live 2026-11-08 at the second request of every
 * multi-turn run), so a user message made of tool results gets none. Claude
 * takes a cache point after a toolResult.
 */
export function bedrockCachePointAfterTextOnly(modelId: string): boolean {
  return !/claude/i.test(modelId);
}

/** Bedrock's `stopReason` as OpenAI's `finish_reason`. */
export function bedrockFinishReason(
  stopReason: string,
): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (stopReason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
    case "guardrail_intervened":
      return "content_filter";
    default:
      return "stop";
  }
}
