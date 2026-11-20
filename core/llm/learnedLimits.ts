/**
 * Limits a model's own server reported, learned in this process for a model
 * whose window nobody published (core/util/listedModelLimits.ts reads them).
 * `BaseLLM` consults this after the person's config and the provider's API,
 * so a reloaded config comes back with the real window. Kept in memory only:
 * the next start asks the server again, one `GET /models`.
 */
import type { ListedLimits } from "../util/listedModelLimits.js";

export interface LearnedFacts {
  contextLength?: number;
  maxOutputTokens?: number;
}

const learned = new Map<string, LearnedFacts>();
const attempted = new Set<string>();

/** One model on one endpoint. The address is as the person configured it. */
export function learnedKey(
  provider: string | undefined,
  apiBase: string | undefined,
  model: string | undefined,
): string {
  return [
    provider ?? "",
    (apiBase ?? "").replace(/\/+$/, ""),
    model ?? "",
  ].join("\n");
}

export function learnedFactsFor(key: string): LearnedFacts | undefined {
  return learned.get(key);
}

/**
 * What of a server's report may set the window: the window it runs the model
 * with, or the most it lists. The trained window is a ceiling and does not
 * set one.
 */
export function usableLearnedFacts(
  limits: ListedLimits | undefined,
): LearnedFacts | undefined {
  if (!limits) return undefined;
  const window =
    limits.kind === "loaded" || limits.kind === "max"
      ? limits.contextLength
      : undefined;
  if (window === undefined && limits.maxOutputTokens === undefined) {
    return undefined;
  }
  return {
    ...(window !== undefined ? { contextLength: window } : {}),
    ...(limits.maxOutputTokens !== undefined
      ? { maxOutputTokens: limits.maxOutputTokens }
      : {}),
  };
}

export function rememberLearned(key: string, facts: LearnedFacts): void {
  learned.set(key, facts);
}

/** True the first time a key is asked about, so a server is asked once. */
export function firstAttempt(key: string): boolean {
  if (attempted.has(key)) return false;
  attempted.add(key);
  return true;
}

/** For tests. */
export function resetLearned(): void {
  learned.clear();
  attempted.clear();
}
