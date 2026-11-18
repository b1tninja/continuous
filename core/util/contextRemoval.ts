import type {
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  MessagePart,
  RemovedByUser,
} from "..";
import {
  maskOldToolResults,
  unmaskToolResults,
  type MaskOutcome,
  type MaskedResult,
} from "./contextAgeing";

/**
 * What "Choose what to keep" (selective compaction) changes in a request:
 * plans/research/context-usage-breakdown.md section 8.
 *
 * Pure, with no node imports, so the GUI can use it. The marks live on the
 * history items (`ChatHistoryItem.removedByUser`); nothing is deleted from the
 * session. A removed tool result is sent as a one-line stub in the same tool
 * message, with the same `toolCallId`, so every call keeps its result and the
 * request stays valid for every provider: it is history ageing's masking
 * (`maskOldToolResults`) applied to a chosen set. A removed attached context
 * item and a removed image become one line of text each. A removed old turn
 * is left out whole; turns are only removed from the start of the
 * conversation, so a tool exchange is never cut in two.
 */

/** Ends the stubs for attached context. */
export const REMOVED_BY_USER_SUFFIX = " removed by you]";
export const IMAGE_REMOVED_STUB = "[image removed by you]";

/** Characters per token for the size in a stub. Rough on purpose. */
const CHARS_PER_TOKEN = 4;

/** "950", "12k": the same steps as the context meter (sessionUsage formatTokens). */
function tokensText(chars: number): string {
  const n = Math.ceil(chars / CHARS_PER_TOKEN);
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "[output removed by you: 12k tokens, Read src/config/parseConfig.ts]". */
export function removedToolResultStub(
  label: string | undefined,
  originalChars: number,
): string {
  return `[output removed by you: ${tokensText(originalChars)} tokens, ${label ?? "tool result"}]`;
}

/** "[attached README.md removed by you]". */
export function removedContextItemStub(item: ContextItemWithId): string {
  const name = (item.name || item.description || "context").trim();
  return `[attached ${name}${REMOVED_BY_USER_SUFFIX}`;
}

export function hasRemovals(mark: RemovedByUser | undefined): boolean {
  return !!(
    mark &&
    (mark.turn ||
      mark.toolResults?.length ||
      mark.contextItems?.length ||
      mark.images?.length)
  );
}

/**
 * The item with its removed attached context and images replaced by stubs.
 * Tool results are not touched here: `maskRemovedToolResults` stubs them in
 * the built messages. Returns the same object when nothing is removed.
 */
export function withRemovedParts(item: ChatHistoryItem): ChatHistoryItem {
  const mark = item.removedByUser;
  if (!mark?.contextItems?.length && !mark?.images?.length) return item;
  const ctx = new Set(mark.contextItems ?? []);
  const images = new Set(mark.images ?? []);
  const contextItems = ctx.size
    ? item.contextItems.map((c, i) =>
        ctx.has(i) ? { ...c, content: removedContextItemStub(c) } : c,
      )
    : item.contextItems;
  let message = item.message;
  if (images.size && Array.isArray(message.content)) {
    const parts = (message.content as MessagePart[]).map(
      (part, i): MessagePart =>
        images.has(i) && part.type === "imageUrl"
          ? { type: "text", text: IMAGE_REMOVED_STUB }
          : part,
    );
    message = { ...message, content: parts } as ChatMessage;
  }
  return { ...item, contextItems, message };
}

/** Tool call ids whose results the person removed, with the call's label. */
export function removedToolResultLabels(
  history: ChatHistoryItem[],
  label: (
    state: NonNullable<ChatHistoryItem["toolCallStates"]>[number],
  ) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of history) {
    const ids = item.removedByUser?.toolResults;
    if (!ids?.length) continue;
    for (const state of item.toolCallStates ?? []) {
      if (ids.includes(state.toolCallId))
        out.set(state.toolCallId, label(state));
    }
  }
  return out;
}

/**
 * Replace the bodies of the chosen tool results with a stub, keeping each
 * tool message and its `toolCallId`. Results are chosen by id, never by age:
 * every other result is kept whatever its size or tool. The originals are in
 * `masked`; `restoreRemovedToolResults` puts them back.
 */
export function maskRemovedToolResults(
  messages: ChatMessage[],
  labels: ReadonlyMap<string, string>,
): MaskOutcome {
  if (labels.size === 0) {
    return { messages, masked: [], freedChars: 0, freedTokensEstimate: 0 };
  }
  return maskOldToolResults(messages, {
    keepRecent: 0,
    minChars: 0,
    protectedTools: [],
    keep: (m) => !labels.has(m.toolCallId),
    stub: (m, _name, chars) =>
      removedToolResultStub(labels.get(m.toolCallId), chars),
  });
}

/** The inverse of `maskRemovedToolResults`, from its `masked` list. */
export function restoreRemovedToolResults(
  messages: ChatMessage[],
  masked: readonly MaskedResult[],
): ChatMessage[] {
  return unmaskToolResults(
    messages,
    new Map(masked.map((m) => [m.handle, m.original])),
  );
}
