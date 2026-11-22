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
const listeners = new Set<(key: string, facts: LearnedFacts) => void>();

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

/**
 * Keeps what a server said. Listeners hear of it only when it differs from
 * what was known: a model rebuilt with the learned window asks its server
 * again and gets the same answer, which must not start another reload.
 */
export function rememberLearned(key: string, facts: LearnedFacts): void {
  const before = learned.get(key);
  learned.set(key, facts);
  if (
    before?.contextLength === facts.contextLength &&
    before?.maxOutputTokens === facts.maxOutputTokens
  ) {
    return;
  }
  for (const listener of [...listeners]) {
    try {
      listener(key, facts);
    } catch {
      // advisory: the request that learned the window goes on
    }
  }
}

/**
 * Called when a model's limits become known or change. A model object built
 * earlier keeps the limits it was built with, so whoever shows them has to
 * build it again (core reloads the config). Returns the unsubscribe.
 */
export function onLearned(
  listener: (key: string, facts: LearnedFacts) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
