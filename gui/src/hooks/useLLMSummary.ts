import {
  calculateRequestCost,
  CostBreakdown,
} from "core/llm/utils/calculateRequestCost";
import { useMemo } from "react";
import { LLMInteraction, LLMResult } from "./useLLMLog";

/**
 * The first logged item that is part of the reply: not a local server's
 * prompt progress, a recovery hold or an empty chunk.
 */
export function firstOutputItem(results: LLMResult[][]): LLMResult | undefined {
  for (const group of results) {
    for (const item of group) {
      if (item.kind === "chunk") {
        if (item.chunk) return item;
        continue;
      }
      const m = item.message;
      if (m.role !== "assistant" && m.role !== "thinking") continue;
      if (m.role === "assistant" && (m.promptProgress || m.recoveryHold)) {
        continue;
      }
      const hasText =
        typeof m.content === "string" ? m.content !== "" : !!m.content?.length;
      if (
        hasText ||
        !!m.toolCalls?.length ||
        (m.role === "thinking" && (m.signature || m.redactedThinking))
      ) {
        return item;
      }
    }
  }
  return undefined;
}

/**
 * Hook returning memoized information about single logged prompt/response
 * query to the LLM.
 */
export default function useLLMSummary(interaction: LLMInteraction) {
  return useMemo(() => {
    if (interaction.start == undefined) {
      return {
        result: "",
        type: "",
      };
    }

    const type = interaction.start.kind.slice(5);

    let result;
    switch (interaction.end?.kind) {
      case "cancel":
        result = "Cancelled";
        break;
      case "error":
        result = "Error";
        break;
      case "success":
        result = "Success";
        break;
      case undefined:
        result = "";
    }

    let totalTime,
      toFirstToken,
      tokensPerSecond,
      promptTokens,
      generatedTokens,
      thinkingTokens;
    // The request's own record when it has ended (J21): first token from the
    // first output, not a local server's first prompt-progress update
    const timing = interaction.end?.timing;
    if (timing?.firstTokenMs) {
      toFirstToken = timing.firstTokenMs.value;
    } else {
      const firstItem = firstOutputItem(interaction.results);
      toFirstToken = firstItem
        ? firstItem.timestamp - interaction.start.timestamp
        : undefined;
    }
    if (interaction.end != undefined) {
      totalTime = interaction.end.timestamp - interaction.start.timestamp;
      promptTokens = interaction.end.promptTokens;
      generatedTokens = interaction.end.generatedTokens;
      thinkingTokens = interaction.end.thinkingTokens;
      if (timing?.outputRate) {
        tokensPerSecond = timing.outputRate.value;
      } else if (toFirstToken != undefined) {
        tokensPerSecond =
          (generatedTokens + thinkingTokens) /
          ((totalTime - toFirstToken) / 1000);
      }
    } else {
      const lastGroup = interaction.results[interaction.results.length - 1];
      const lastItem = lastGroup ? lastGroup[lastGroup.length - 1] : undefined;
      totalTime = lastItem
        ? lastItem.timestamp - interaction.start.timestamp
        : undefined;
    }

    let costBreakdown: CostBreakdown | null = null;
    if (
      interaction.end?.usage &&
      interaction.start?.provider &&
      interaction.start?.options?.model
    ) {
      costBreakdown = calculateRequestCost(
        interaction.start.provider,
        interaction.start.options.model,
        interaction.end.usage,
      );
    }

    return {
      result,
      type,
      totalTime,
      toFirstToken,
      tokensPerSecond,
      promptTokens,
      generatedTokens,
      thinkingTokens,
      costBreakdown,
    };
  }, [interaction]);
}
