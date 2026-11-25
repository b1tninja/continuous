import type { ModelConfig } from "@continuedev/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionFunctionTool } from "openai/resources.mjs";

import { loopItemRunning } from "../loop/loopSession.js";
import { services } from "../services/index.js";
import { getSessionTaskPlan } from "../session.js";
import {
  cliToolListForRequest,
  heldToolsLifetimeMs,
  noteToolHoldRequest,
  withoutReasoningBefore,
} from "../tools/toolListHold.js";

import { cacheReadTokens } from "./streamChatResponse.helpers.js";
import type { StreamCallbacks } from "./streamChatResponse.types.js";

/** A part of the key, or a fallback when it cannot be read (test doubles). */
function keyPart<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * The session conversation's tool list for one request (C80): the list the
 * previous request offered while the prompt cache is warm and a change
 * waits, else the current one. Subagents and the review worker have caches
 * of their own and always take the current list.
 */
export function holdRequestTools(args: {
  rawTools: ChatCompletionFunctionTool[];
  model: ModelConfig;
  historyLength: number;
  main: boolean;
  callbacks?: StreamCallbacks;
}): { tools: ChatCompletionFunctionTool[]; thinkingCut?: number } {
  if (!args.main) return { tools: args.rawTools };
  const key = JSON.stringify([
    keyPart(() => services.toolPermissions?.getCurrentMode?.(), undefined),
    args.model.provider,
    args.model.model,
    keyPart(() => loopItemRunning(), false),
    keyPart(() => !!getSessionTaskPlan()?.items.length, false),
  ]);
  const result = cliToolListForRequest({
    live: args.rawTools,
    key,
    model: args.model.model,
    historyLength: args.historyLength,
  });
  if (result.notice) args.callbacks?.onSystemMessage?.(result.notice);
  return { tools: result.tools, thinkingCut: result.thinkingCut };
}

/** The history as the request sends it, after a tool list change (see toolListHold.ts). */
export function historyForHeldTools(
  history: ChatHistoryItem[],
  thinkingCut: number | undefined,
): ChatHistoryItem[] {
  return withoutReasoningBefore(history, thinkingCut);
}

/** The usage of a session request, for whether the cache is warm. */
export function noteHeldToolsUsage(
  model: ModelConfig,
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: Parameters<typeof cacheReadTokens>[0] & {
          cache_write_tokens?: number;
        };
      }
    | undefined,
): void {
  if (!usage?.prompt_tokens) return;
  noteToolHoldRequest({
    provider: model.provider,
    model: model.model,
    usage: {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens ?? 0,
      promptTokensDetails: {
        cachedTokens: cacheReadTokens(usage.prompt_tokens_details),
        cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens,
      },
    },
    lifetimeMs: heldToolsLifetimeMs(model.cacheBehavior?.ttl),
  });
}
