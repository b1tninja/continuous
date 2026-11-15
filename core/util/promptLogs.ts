import type { ChatHistoryItem, PromptLog } from "../index.js";

/**
 * The full prompt of each model request was kept on the history item that
 * answered it (`promptLogs`), and every prompt holds the conversation up to
 * that point, so a session grew with the square of its length: 424 of a
 * 432 MB session file were old prompts (1,290 items, 445 requests). The
 * webview held all of it, sent it to the extension on every save, and ran
 * out of memory.
 *
 * Only the thumbs up/down buttons read a prompt log, to send it as feedback,
 * and every request is already logged in full when it is made (dev data,
 * `chatInteraction`). So in memory only the newest request keeps its full
 * prompt, and a session file keeps none: older logs keep the small fields
 * (model, completion) and this marker in place of the prompt.
 */
export const DROPPED_PROMPT_MARKER = "[prompt not kept: older request]";

/** A prompt log without its prompt (the completion and the model stay). */
export function withoutPrompt(log: PromptLog): PromptLog {
  if (log.prompt === DROPPED_PROMPT_MARKER) return log;
  return { ...log, prompt: DROPPED_PROMPT_MARKER };
}

function hasFullPrompt(logs: PromptLog[] | undefined): boolean {
  return !!logs?.some((log) => log.prompt !== DROPPED_PROMPT_MARKER);
}

/**
 * The history with the full prompt kept only on the newest request's log.
 * Items that need nothing are returned as they are, and a history that
 * needs nothing is the same array.
 */
export function keepLatestPromptOnly(
  history: ChatHistoryItem[],
): ChatHistoryItem[] {
  let newest = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].promptLogs?.length) {
      newest = i;
      break;
    }
  }
  let changed = false;
  const out = history.map((item, i) => {
    const logs = item.promptLogs;
    if (!logs?.length) return item;
    const kept =
      i === newest
        ? // the newest item: only its last request keeps the prompt
          logs.map((log, j) =>
            j === logs.length - 1 ? log : withoutPrompt(log),
          )
        : logs.map(withoutPrompt);
    if (kept.every((log, j) => log === logs[j])) return item;
    changed = true;
    return { ...item, promptLogs: kept };
  });
  return changed ? out : history;
}

/**
 * The history with no full prompt at all: what a session file holds. A
 * history that has none is returned as the same array.
 */
export function withoutPrompts(history: ChatHistoryItem[]): ChatHistoryItem[] {
  if (!history.some((item) => hasFullPrompt(item.promptLogs))) return history;
  return history.map((item) =>
    hasFullPrompt(item.promptLogs)
      ? { ...item, promptLogs: item.promptLogs!.map(withoutPrompt) }
      : item,
  );
}
