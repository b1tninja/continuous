import type { ModelConfig } from "@continuedev/config-yaml";
import type { PromptProgress } from "core/index.js";
import {
  promptProgressOf,
  streamsPromptProgress,
} from "core/llm/localServers.js";
import { formatPromptProgress } from "core/llm/promptProgressText.js";

import type { StreamCallbacks } from "./streamChatResponse.types.js";

/** The spinner row changes at most once a second. */
export const TUI_PROGRESS_INTERVAL_MS = 1000;
/** Headless `--verbose` prints at most one progress line every 10 s. */
export const HEADLESS_PROGRESS_INTERVAL_MS = 10_000;

export { formatPromptProgress, promptProgressOf };

/**
 * Where one request's prompt-reading updates go: `update` passes on at most
 * one update per interval (the first at once), `clear` says the reading is
 * over, once, and only when an update was passed on.
 */
export interface PromptProgressSink {
  update(progress: PromptProgress): void;
  clear(): void;
}

export function throttledProgressSink(
  emit: (progress: PromptProgress | undefined) => void,
  intervalMs: number,
  now: () => number = Date.now,
): PromptProgressSink {
  let last: number | undefined;
  let shown = false;
  return {
    update(progress) {
      const t = now();
      if (last !== undefined && t - last < intervalMs) return;
      last = t;
      shown = true;
      emit(progress);
    },
    clear() {
      if (!shown) return;
      shown = false;
      emit(undefined);
    },
  };
}

function isVerbose(): boolean {
  return process.argv.includes("--verbose");
}

/**
 * The sink for a request, or none when nobody would see the updates: the
 * caller's `onPromptProgress` (the TUI's spinner row), else in headless mode
 * with `--verbose` a line on stderr every 10 s at most. Headless without
 * `--verbose` shows nothing.
 */
export function promptProgressSinkFor(
  callbacks: StreamCallbacks | undefined,
  isHeadless: boolean,
): PromptProgressSink | undefined {
  const onPromptProgress = callbacks?.onPromptProgress;
  if (onPromptProgress) {
    return throttledProgressSink(onPromptProgress, TUI_PROGRESS_INTERVAL_MS);
  }
  if (isHeadless && isVerbose()) {
    return throttledProgressSink((progress) => {
      if (progress) process.stderr.write(`${formatPromptProgress(progress)}\n`);
    }, HEADLESS_PROGRESS_INTERVAL_MS);
  }
  return undefined;
}

/**
 * Whether to ask this model's server for `prompt_progress` with
 * `return_progress: true`: only a local server whose `/props` answers as
 * llama.cpp's does (llama.cpp, Strata), asked once per address. A cloud API
 * is never asked and never sent the field. The same detection the IDE uses
 * (core/llm/localServers.ts).
 */
export function requestsPromptProgress(model: ModelConfig): Promise<boolean> {
  return streamsPromptProgress(
    model.apiBase,
    model.apiKey,
    fetch,
    model.requestOptions as Parameters<typeof streamsPromptProgress>[3],
  ).catch(() => false);
}
