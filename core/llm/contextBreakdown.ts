import type { ChatHistoryItem, MessagePart } from "..";
import { BuiltInToolNames } from "../tools/builtIn";
import { sendAttachmentsOnce } from "../util/contextReferences";
import {
  removedToolResultStub,
  withRemovedParts,
} from "../util/contextRemoval";
import {
  renderContextItems,
  renderContextItemsWithStatus,
} from "../util/messageContent";
import {
  type ContextClass,
  contextLimits,
  countingSafetyBuffer,
  outputReserve,
} from "./contextThresholds";
import { chatMessageIsEmpty } from "./messages";
import type { PromptSegment } from "./promptSegments";

/**
 * What the context window holds, by category: a first slice of the J0
 * `contextBreakdown` of plans/research/area-caching-cost-visibility.md, used by
 * the IDE's context meter. Pure, with no node imports, so the GUI webview can
 * use it: it reads the request's segments (the tools and the system message as
 * split by `describeChatRequest`) and the session history the request is built
 * from, and changes nothing that is sent.
 *
 * Sizes are estimates at four characters per token, the repo's proxy
 * (core/llm/promptSegments.ts), and an image counts as core's flat 1,024
 * tokens (core/llm/countTokens.ts `countImageTokens`). When the provider has
 * reported a total, every category is scaled to it and the split is marked as
 * estimated. See plans/research/context-usage-breakdown.md.
 */

export type ContextCategoryKey =
  | "system"
  | "tools"
  | "rules"
  | "summary"
  | "context"
  | "user"
  | "assistant"
  | "toolCalls"
  | "toolResults"
  | "terminal"
  | "images"
  | "reasoning"
  | "other";

/** Display order: the request's own order, setup first, then the conversation. */
export const CONTEXT_CATEGORIES: ReadonlyArray<{
  key: ContextCategoryKey;
  label: string;
}> = [
  { key: "system", label: "System prompt" },
  { key: "tools", label: "Tool definitions" },
  { key: "rules", label: "Rules and instructions" },
  { key: "summary", label: "Conversation summary" },
  { key: "context", label: "Attached context" },
  { key: "user", label: "Your messages" },
  { key: "assistant", label: "Replies" },
  { key: "toolCalls", label: "Tool calls" },
  { key: "toolResults", label: "Tool results" },
  { key: "terminal", label: "Terminal output" },
  { key: "images", label: "Images" },
  { key: "reasoning", label: "Reasoning" },
  { key: "other", label: "Not itemised" },
];

/** Characters per token for the estimate (core/llm/promptSegments.ts). */
export const CHARS_PER_TOKEN = 4;
/** What core counts for one image (core/llm/countTokens.ts countImageTokens). */
export const IMAGE_TOKENS = 1024;
/**
 * A provider count more than this many times the estimate is not shared out:
 * the estimate does not describe that request (a history that changed since,
 * tools counted differently), so scaling would inflate every category. The
 * difference is shown as "Not itemised" instead.
 */
export const MAX_SCALE_FACTOR = 2;
/** Items smaller than this are not listed among the largest. */
export const LARGEST_ITEM_MIN_TOKENS = 500;
export const LARGEST_ITEM_COUNT = 3;

export interface ContextCategory {
  key: ContextCategoryKey;
  label: string;
  tokens: number;
  /** Share of the window, 0..1; of the used total when the window is unknown. */
  share: number;
}

export interface ContextItemSize {
  category: ContextCategoryKey;
  /** "Read src/x.ts", "@ file README.md", "Your message". */
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  /** Categories with any tokens, in `CONTEXT_CATEGORIES` order. */
  categories: ContextCategory[];
  /** Tokens the context holds: the reported total when scaled, else the estimate. */
  usedTokens: number;
  /** The four-characters-per-token estimate before any scaling. */
  estimatedTokens: number;
  /**
   * True when the categories were scaled to a provider-reported total: the
   * total is the provider's, the split between categories is estimated.
   */
  scaled: boolean;
  /** The model's window, when known. */
  window?: number;
  /** Kept back for the reply and the counting buffer, when the window is known. */
  reservedTokens?: number;
  /** Room left before the reserve, when the window is known. */
  freeTokens?: number;
  /**
   * Where the chat starts dropping the oldest messages, a block at a time
   * (the force threshold of contextThresholds.ts), when the window is known.
   * The IDE has no automatic compaction.
   */
  pruneAtTokens?: number;
  /** Used share of the window, 0..1 (may pass 1 when over). */
  fraction?: number;
  /** The biggest single items, largest first. */
  largest: ContextItemSize[];
}

export interface ContextBreakdownInput {
  /** The request's segments (`describeChatRequest`); history-region ones are ignored. */
  segments: PromptSegment[];
  /** The session history the request is built from. */
  history: ChatHistoryItem[];
  /** The model's context window. */
  contextLength?: number;
  /** The model's reply limit (`completionOptions.maxTokens`). */
  maxTokens?: number;
  /** Local server or hosted provider: which thresholds apply. Cloud if unset. */
  contextClass?: ContextClass;
  /** The provider's count for this context, when one is known. */
  reportedTokens?: number;
}

export function estimateTextTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

/**
 * The reserve core keeps out of the input budget (compileChatMessages): the
 * counting safety buffer and the room for the reply (contextThresholds.ts).
 */
export function reservedTokensFor(window: number, maxTokens?: number): number {
  return Math.round(
    countingSafetyBuffer(window) + outputReserve(window, maxTokens),
  );
}

function segmentCategory(segment: PromptSegment): ContextCategoryKey | null {
  if (segment.region === "history") return null;
  if (segment.region === "tools" || segment.source === "format") return "tools";
  switch (segment.source) {
    case "rules":
    case "memory":
    case "tail":
    case "task-list":
      return "rules";
    case "summary":
      return "summary";
    default:
      return "system";
  }
}

/** The history the request carries: what follows the newest summary. */
export function historyAfterSummary(
  history: ChatHistoryItem[],
): ChatHistoryItem[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) return history.slice(i + 1);
  }
  return history;
}

function partsOf(content: unknown): MessagePart[] {
  if (Array.isArray(content)) return content as MessagePart[];
  return typeof content === "string" ? [{ type: "text", text: content }] : [];
}

function partTokens(parts: MessagePart[]): { text: number; images: number } {
  let text = 0;
  let images = 0;
  for (const part of parts) {
    if (part.type === "imageUrl") images += IMAGE_TOKENS;
    else if (part.type === "text") text += estimateTextTokens(part.text);
  }
  return { text, images };
}

function shorten(s: string, max = 48): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "Read src/x.ts", "run_terminal_command npm test": the tool and its main argument. */
export function describeToolCall(name: string, args: unknown): string {
  let parsed: Record<string, unknown> | undefined;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = undefined;
    }
  } else if (args && typeof args === "object") {
    parsed = args as Record<string, unknown>;
  }
  const main = parsed
    ? [
        "filepath",
        "path",
        "file",
        "command",
        "query",
        "url",
        "pattern",
        "dirPath",
      ]
        .map((k) => parsed?.[k])
        .find((v): v is string => typeof v === "string" && v.length > 0)
    : undefined;
  const verb = name === BuiltInToolNames.ReadFile ? "Read" : name;
  return shorten(main ? `${verb} ${main}` : verb);
}

/**
 * The estimate for each category of the context, scaled to the reported total
 * when one is given.
 */
export function computeContextBreakdown(
  input: ContextBreakdownInput,
): ContextBreakdown {
  const totals = new Map<ContextCategoryKey, number>();
  const items: ContextItemSize[] = [];
  const add = (key: ContextCategoryKey, tokens: number, label?: string) => {
    if (tokens <= 0) return;
    totals.set(key, (totals.get(key) ?? 0) + tokens);
    if (label) items.push({ category: key, label, tokens });
  };

  for (const segment of input.segments) {
    const key = segmentCategory(segment);
    if (key) add(key, segment.tokens);
  }

  // The same walk as constructMessages: the newest summary cuts the history,
  // tool messages are rebuilt from the assistant's tool call states, and empty
  // messages are left out.
  // What the person removed ("Choose what to keep") counts as its stub, and a
  // removed old turn not at all (core/util/contextRemoval.ts). A repeated
  // attachment counts as its stub, as sent (core/util/contextReferences.ts).
  const sentHistory = sendAttachmentsOnce(
    historyAfterSummary(input.history)
      .filter((original) => !original.removedByUser?.turn)
      .map(withRemovedParts),
  );
  for (const item of sentHistory) {
    const removedResults = item.removedByUser?.toolResults ?? [];
    const removedCtx = item.removedByUser?.contextItems ?? [];
    const message = item.message;
    if (
      message.role === "system" ||
      message.role === "tool" ||
      chatMessageIsEmpty(message)
    ) {
      continue;
    }
    if (message.role === "user") {
      (item.contextItems ?? []).forEach((ctx, i) => {
        if (!ctx.content?.trim()) return;
        add(
          "context",
          estimateTextTokens(`${ctx.content}\n`),
          removedCtx.includes(i)
            ? undefined
            : shorten(ctx.description || ctx.name || "Attached context"),
        );
      });
      const { text, images } = partTokens(partsOf(message.content));
      add("user", text, "Your message");
      add("images", images, "Image");
      continue;
    }
    if (message.role === "thinking") {
      const { text } = partTokens(partsOf(message.content));
      add(
        "reasoning",
        text +
          estimateTextTokens(message.redactedThinking) +
          estimateTextTokens(message.signature),
        "Reasoning",
      );
      continue;
    }
    if (message.role === "assistant") {
      const { text, images } = partTokens(partsOf(message.content));
      add("assistant", text, "Reply");
      add("images", images);
      for (const call of message.toolCalls ?? []) {
        add(
          "toolCalls",
          estimateTextTokens(JSON.stringify(call)),
          `Call ${describeToolCall(call.function?.name ?? "tool", call.function?.arguments)}`,
        );
      }
      for (const state of item.toolCallStates ?? []) {
        const name = state.toolCall?.function?.name ?? "tool";
        const terminal = name === BuiltInToolNames.RunTerminalCommand;
        const full = state.output
          ? terminal
            ? renderContextItemsWithStatus(state.output)
            : renderContextItems(state.output)
          : "";
        const label = describeToolCall(
          name,
          state.parsedArgs ?? state.toolCall?.function?.arguments,
        );
        const removed = !!full && removedResults.includes(state.toolCallId);
        add(
          terminal ? "terminal" : "toolResults",
          estimateTextTokens(
            removed ? removedToolResultStub(label, full.length) : full,
          ),
          removed ? undefined : label,
        );
      }
    }
  }

  const estimatedTokens = [...totals.values()].reduce((a, b) => a + b, 0);
  const reported = input.reportedTokens;
  // With a provider count, the total is that count, so it matches the meter
  // (which shows the provider's count) and the shares add up to it. Up to
  // MAX_SCALE_FACTOR times the estimate it is shared out by size; past that
  // the categories stay as estimated and the rest is "Not itemised".
  const scaled = reported !== undefined && reported > 0 && estimatedTokens > 0;
  const unexplained =
    scaled && reported > estimatedTokens * MAX_SCALE_FACTOR
      ? reported - estimatedTokens
      : 0;
  const factor = scaled && !unexplained ? reported / estimatedTokens : 1;
  if (unexplained) totals.set("other", unexplained);
  const usedTokens = scaled ? reported : estimatedTokens;

  const window =
    input.contextLength && input.contextLength > 0
      ? input.contextLength
      : undefined;
  const denominator = window ?? (usedTokens || 1);

  const categories: ContextCategory[] = [];
  for (const { key, label } of CONTEXT_CATEGORIES) {
    const raw = totals.get(key);
    if (!raw) continue;
    const tokens = Math.round(raw * factor);
    categories.push({ key, label, tokens, share: tokens / denominator });
  }

  const largest = items
    .map((i) => ({ ...i, tokens: Math.round(i.tokens * factor) }))
    .filter((i) => i.tokens >= LARGEST_ITEM_MIN_TOKENS)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LARGEST_ITEM_COUNT);

  const result: ContextBreakdown = {
    categories,
    usedTokens,
    estimatedTokens,
    scaled,
    largest,
  };
  if (window) {
    const reservedTokens = reservedTokensFor(window, input.maxTokens);
    result.window = window;
    result.reservedTokens = reservedTokens;
    result.pruneAtTokens = contextLimits(
      window,
      input.maxTokens,
      input.contextClass ?? "cloud",
    ).forceAt;
    result.freeTokens = Math.max(0, window - reservedTokens - usedTokens);
    result.fraction = usedTokens / window;
  }
  return result;
}
