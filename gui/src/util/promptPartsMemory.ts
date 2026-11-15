import { PromptPartsMemory } from "core/llm/promptDivergence";

/**
 * The previous chat request's prompt parts per session and model, in memory
 * only (hashes and sizes, no text): what the next request to a local server
 * is compared with, so a cache miss can name what changed
 * (core/llm/promptDivergence.ts).
 */
export const requestPartsMemory = new PromptPartsMemory();

/** The conversation a request belongs to: a session on one model. */
export function requestPartsKey(sessionId: string, modelTitle: string): string {
  return `${sessionId}\u0000${modelTitle}`;
}
