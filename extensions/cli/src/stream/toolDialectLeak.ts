import type { ModelConfig } from "@continuedev/config-yaml";
import { getOllamaShowHint } from "core/util/ollamaShowHint.js";
import {
  detectToolDialectLeak,
  leakHintText,
  providerRecoversText,
} from "core/util/toolDialectLeak.js";

import type { StreamCallbacks } from "./streamChatResponse.types.js";

const hinted = new Set<string>();

/** Forget which models were hinted (tests, and a new session). */
export function resetToolDialectHints(): void {
  hinted.clear();
}

/**
 * Print a one-line hint, once per session per model, when a reply carried a
 * tool call written as text (outside a code fence) and `toolDialect` is not
 * set. Never turns recovery on by itself.
 */
export async function hintToolDialectLeak(args: {
  model: ModelConfig;
  content: string;
  toolCalls: { id?: string; name: string; argumentsStr?: string }[];
  callbacks: StreamCallbacks | undefined;
  print?: (line: string) => void;
  /** Test seam: the Ollama /api/show fetch. */
  fetchFn?: Parameters<typeof getOllamaShowHint>[0]["fetchFn"];
}): Promise<void> {
  const { model } = args;
  if (!providerRecoversText(model.provider, "cli") || hinted.has(model.name))
    return;
  const leak = detectToolDialectLeak({
    content: args.content,
    toolCalls: args.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.argumentsStr ?? "{}",
    })),
    current: model.toolDialect,
    model: model.model,
  });
  if (!leak) return;
  // Claimed before the await so two replies in flight print once.
  hinted.add(model.name);
  // Ollama may already parse this model's calls: then the text is not a leak.
  const show = await getOllamaShowHint({
    provider: model.provider,
    apiBase: model.apiBase,
    model: model.model,
    fetchFn: args.fetchFn,
  });
  if (show?.serverParses) {
    hinted.delete(model.name);
    return;
  }
  const line = leakHintText(model.name, leak.dialect);
  if (args.callbacks?.onStatusMessage) args.callbacks.onStatusMessage(line);
  else (args.print ?? ((l) => console.error(l)))(line);
}
