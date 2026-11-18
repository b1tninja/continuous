import type { ModelDescription } from "core";
import { LOCAL_CACHE_WARM_MS } from "./promptCache";

/**
 * What Ollama is asked to keep the model loaded for when the config sets
 * nothing: core's Ollama provider sends `keep_alive` with every request, 30
 * minutes unless `completionOptions.keepAlive` (seconds) says otherwise
 * (core/llm/llms/Ollama.ts). A per-request `keep_alive` overrides the
 * server's `OLLAMA_KEEP_ALIVE`, whose own default is 5 minutes
 * (https://docs.ollama.com/faq, checked 2026-11-11), so that server setting
 * does not apply to requests from this app.
 */
export const OLLAMA_REQUEST_KEEP_ALIVE_MS = 30 * 60 * 1000;

/**
 * How long after its last request a local server is taken to still hold the
 * conversation. Ollama unloads the model after its keep-alive, so that is the
 * window (a negative keep-alive keeps it loaded, 0 unloads at once).
 * llama.cpp and similar servers keep prompt slots with no time limit, so
 * their window stays the generic guess, LOCAL_CACHE_WARM_MS.
 */
export function localCacheWarmMs(
  model: ModelDescription | null | undefined,
): number {
  if (model?.provider?.toLowerCase() !== "ollama") return LOCAL_CACHE_WARM_MS;
  const keepAlive = model.completionOptions?.keepAlive;
  if (typeof keepAlive !== "number" || !Number.isFinite(keepAlive)) {
    return OLLAMA_REQUEST_KEEP_ALIVE_MS;
  }
  return keepAlive < 0 ? Number.POSITIVE_INFINITY : keepAlive * 1000;
}
