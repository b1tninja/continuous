/**
 * Where a chat request stops being an extension of the previous one.
 *
 * A prompt cache reuses the longest prefix two requests share. A local
 * server (Strata, llama.cpp, vLLM, LM Studio, Ollama) keeps the previous
 * request's prompt and its answer, so when an earlier message of the next
 * request differs, it reads the whole conversation again from that message:
 * minutes at 400k tokens. This keeps, per request, a hash of each part the
 * prompt is built from (the request options that change the prompt, the
 * tool list, the system message and each message) and finds the first part
 * that differs from the previous request's. It keeps sizes and hashes, never
 * text, so the result can be logged and recorded.
 *
 * Plain TypeScript with no node imports, so the GUI webview can use it.
 * Docs: local servers, "Why a turn re-reads the whole prompt".
 */
import type { ChatMessage } from "../index.js";
import { contentHash } from "../util/contextReferences.js";

export type PromptPartKind =
  "options" | "tools" | "system" | "user" | "assistant" | "thinking" | "tool";

/** One part of a request: no text, only what it is, its size and a hash. */
export interface PromptPart {
  kind: PromptPartKind;
  /** The message's index in the request (the system message is 0); -1 before the messages. */
  index: number;
  /** For a user message: which one it is, counting from 1. */
  userNumber?: number;
  hash: string;
  chars: number;
}

/** The completion options that change the prompt the server reads. */
export interface PromptShapingOptions {
  tools?: unknown[];
  reasoning?: boolean;
  reasoningBudgetTokens?: number;
  toolChoice?: unknown;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

function part(
  kind: PromptPartKind,
  index: number,
  text: string,
  extra: Partial<PromptPart> = {},
): PromptPart {
  return {
    kind,
    index,
    hash: `${text.length.toString(36)}.${contentHash(text)}`,
    chars: text.length,
    ...extra,
  };
}

/**
 * The parts of a request, in the order the server reads them: the options
 * that change the start of the prompt (a local chat template puts the
 * reasoning setting first), the tools, then the messages.
 */
export function promptParts(
  messages: readonly ChatMessage[],
  options: PromptShapingOptions = {},
): PromptPart[] {
  const parts: PromptPart[] = [
    part(
      "options",
      -1,
      stableJson([
        options.reasoning ?? null,
        options.reasoningBudgetTokens ?? null,
        options.toolChoice ?? null,
      ]),
    ),
    part("tools", -1, stableJson(options.tools ?? [])),
  ];
  let users = 0;
  messages.forEach((message, index) => {
    const {
      id: _id,
      usage: _usage,
      metadata: _metadata,
      ...sent
    } = message as ChatMessage & {
      id?: unknown;
      usage?: unknown;
      metadata?: unknown;
    };
    const kind = message.role as PromptPartKind;
    parts.push(
      part(
        kind,
        index,
        stableJson(sent),
        kind === "user" ? { userNumber: ++users } : {},
      ),
    );
  });
  return parts;
}

export interface PromptDivergence {
  /** The first part of the new request that differs, or undefined when it only grew. */
  changed?: PromptPart;
  /** That part's position among the parts (0 is the options). */
  at?: number;
  /** Characters of the previous request before the change (all of it when it only grew). */
  unchangedChars: number;
  previousChars: number;
  /** Parts in the previous and the new request. */
  previousParts: number;
  parts: number;
}

/**
 * Compares a request with the previous one. Every part of the previous
 * request must come back unchanged, in place, except a trailing task list
 * (`trailingVolatile`), which moves to the end of every request by design.
 */
export function comparePromptParts(
  previous: readonly PromptPart[],
  next: readonly PromptPart[],
  trailingVolatile = 0,
): PromptDivergence {
  const compared = previous.slice(0, previous.length - trailingVolatile);
  const previousChars = previous.reduce((n, p) => n + p.chars, 0);
  let unchangedChars = 0;
  for (let i = 0; i < compared.length; i++) {
    const before = compared[i];
    const after = next[i];
    if (!after || after.hash !== before.hash || after.kind !== before.kind) {
      return {
        changed: after ?? before,
        at: i,
        unchangedChars,
        previousChars,
        previousParts: previous.length,
        parts: next.length,
      };
    }
    unchangedChars += before.chars;
  }
  return {
    unchangedChars: previousChars,
    previousChars,
    previousParts: previous.length,
    parts: next.length,
  };
}

const KIND_WORDS: Record<PromptPartKind, string> = {
  options: "the reasoning or tool-choice setting",
  tools: "the tool list",
  system: "the system message (a rule, a summary or the mode's prompt)",
  user: "a user message",
  assistant: "an answer",
  thinking: "a reasoning block",
  tool: "a tool result",
};

/**
 * The cause in words, for the cache-miss notice and the ledger:
 * "message 3 (your first message) changed: a user message". Indices and
 * kinds only.
 */
export function describePromptDivergence(d: PromptDivergence): string {
  const changed = d.changed;
  if (!changed) {
    return "the prompt only grew since the previous request, so the server dropped its cache (it was busy with another conversation, unloaded the model or ran out of cache room)";
  }
  if (changed.index < 0) return `${KIND_WORDS[changed.kind]} changed`;
  if (changed.kind === "system") return `${KIND_WORDS.system} changed`;
  const which =
    changed.kind === "user" && changed.userNumber === 1
      ? " (your first message)"
      : changed.kind === "user" && changed.userNumber
        ? ` (user message ${changed.userNumber})`
        : "";
  return `message ${changed.index + 1}${which} changed: ${KIND_WORDS[changed.kind]}`;
}

/** One debug line: positions, kinds and sizes, never text. */
export function promptDivergenceLogLine(
  d: PromptDivergence,
  reuse?: { readTokens: number; promptTokens: number },
): string {
  const where = d.changed
    ? `part ${d.at} of ${d.parts} (${d.changed.kind}${d.changed.index >= 0 ? ` #${d.changed.index}` : ""})`
    : "none (the prompt only grew)";
  const read = reuse
    ? `; server reused ${reuse.readTokens} of ${reuse.promptTokens} tokens`
    : "";
  return `[prompt cache] first change from the previous request: ${where}; unchanged ${d.unchangedChars} of ${d.previousChars} chars${read}`;
}

/**
 * Whether the server reused far less than the unchanged part of the prompt
 * should have let it: under half of it, and at least `minTokens` short.
 * `promptTokens` scales characters to the server's tokens.
 */
export function reuseFarBelowPrefix(
  d: PromptDivergence,
  readTokens: number,
  promptTokens: number,
  nextChars: number,
  minTokens = 4096,
): boolean {
  if (!(nextChars > 0) || !(promptTokens > 0)) return false;
  const expected = (d.unchangedChars / nextChars) * promptTokens;
  return readTokens < expected * 0.5 && expected - readTokens >= minTokens;
}

/**
 * The previous request's parts, per conversation, in memory only: what the
 * next request is compared with. A conversation is a session on one model.
 */
export class PromptPartsMemory {
  private readonly last = new Map<
    string,
    { parts: PromptPart[]; trailingVolatile: number }
  >();
  constructor(private readonly limit = 32) {}

  /**
   * Stores `parts` for `key` and returns how they differ from the previous
   * request's, or undefined for the first request. `trailingVolatile` is how
   * many parts at the end of this request the next one replaces by design
   * (the task list).
   */
  note(
    key: string,
    parts: PromptPart[],
    trailingVolatile = 0,
  ): PromptDivergence | undefined {
    const previous = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, { parts, trailingVolatile });
    while (this.last.size > this.limit) {
      this.last.delete(this.last.keys().next().value as string);
    }
    return previous
      ? comparePromptParts(previous.parts, parts, previous.trailingVolatile)
      : undefined;
  }

  forget(key?: string): void {
    if (key === undefined) this.last.clear();
    else this.last.delete(key);
  }
}
