import type { PromptProgress } from "../index.js";

/** "140k", "900". */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  return `${Math.round(s / 60)} min`;
}

/**
 * "Reading the prompt: 140k of 300k tokens, 120k from the cache, about
 * 40 s left". The cached part is read in no time, so the share done and the
 * time left count only the rest: llama.cpp's own rule,
 * (processed - cache) / (total - cache). The GUI's toolbar and the CLI's
 * spinner row both show this line.
 */
export function formatPromptProgress(p: PromptProgress): string {
  const toRead = Math.max(0, p.total - p.cache);
  const read = Math.max(0, Math.min(toRead, p.processed - p.cache));
  const parts = [
    `Reading the prompt: ${formatTokens(read)} of ${formatTokens(toRead)} tokens`,
  ];
  if (p.cache > 0) parts.push(`${formatTokens(p.cache)} from the cache`);
  if (read > 0 && p.timeMs > 0 && read < toRead) {
    const msLeft = ((toRead - read) * p.timeMs) / read;
    parts.push(`about ${formatSeconds(msLeft)} left`);
  }
  return parts.join(", ");
}
