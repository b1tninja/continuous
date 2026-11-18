/**
 * The model's reasoning in a streamed reply: what the terminal UI shows while
 * the model thinks, what `--format stream-json` reports, and what is sent
 * back to the provider on the next request when it needs it.
 *
 * The adapters put reasoning on a chunk's delta in one of these shapes:
 * `reasoning_content` (Anthropic, Bedrock, Gemini, DeepSeek, most
 * OpenAI-compatible servers), `reasoning` as a string (OpenRouter, vLLM) or
 * as `{ content: [{ text }] }` (OpenAI's Responses API), and
 * `reasoning_details` (OpenRouter's text and summary entries; Anthropic's and
 * Bedrock's signatures and redacted thinking).
 */

/** One reply's reasoning, as kept on its history item. */
export interface StreamedReasoning {
  text: string;
  /** When the first reasoning arrived (ms since the epoch). */
  startAt: number;
  /** When the answer or a tool call began, or the stream ended. */
  endAt: number;
  /**
   * What Claude needs back to continue: one `reasoning.text` entry per signed
   * thinking block (its text and signature) and the redacted blocks, in the
   * order they came. Empty for providers that sign nothing.
   */
  details: Record<string, unknown>[];
}

type Delta = Record<string, unknown> | undefined | null;

function textOfReasoningObject(value: unknown): string {
  const content = (value as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof (part as { text?: unknown })?.text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

/**
 * The reasoning text a delta adds. The first field that has text wins: a
 * provider that sends the same text twice (OpenRouter's `reasoning` and its
 * `reasoning_details`) is counted once.
 */
export function reasoningTextOfDelta(delta: Delta): string {
  if (!delta) return "";
  const { reasoning_content, reasoning, reasoning_details } = delta;
  if (typeof reasoning_content === "string" && reasoning_content) {
    return reasoning_content;
  }
  if (typeof reasoning === "string" && reasoning) return reasoning;
  const fromObject = reasoning ? textOfReasoningObject(reasoning) : "";
  if (fromObject) return fromObject;
  if (!Array.isArray(reasoning_details)) return "";
  return reasoning_details
    .map((detail: Record<string, unknown>) => {
      if (
        detail?.type === "reasoning.text" &&
        typeof detail.text === "string"
      ) {
        return detail.text;
      }
      if (
        detail?.type === "reasoning.summary" &&
        typeof detail.summary === "string"
      ) {
        return detail.summary;
      }
      return "";
    })
    .join("");
}

/** Collects one reply's reasoning from its chunks. */
export class ReasoningAccumulator {
  private text = "";
  /** Text of the thinking block not yet closed by a signature. */
  private openBlock = "";
  private details: Record<string, unknown>[] = [];
  private startAt: number | undefined;
  private endAt: number | undefined;

  /** Reads a delta; returns the reasoning text it added (empty if none). */
  add(delta: Delta, now: number): string {
    if (!delta) return "";
    const added = reasoningTextOfDelta(delta);
    if (added) {
      this.startAt ??= now;
      this.text += added;
      this.openBlock += added;
    }
    const details = delta.reasoning_details;
    if (Array.isArray(details)) {
      for (const detail of details as Record<string, unknown>[]) {
        if (detail?.type === "reasoning.encrypted") {
          this.startAt ??= now;
          this.details.push({ type: "reasoning.encrypted", data: detail.data });
        } else if (typeof detail?.signature === "string" && detail.signature) {
          // A signature closes the thinking block it signs
          this.details.push({
            type: "reasoning.text",
            text: this.openBlock,
            signature: detail.signature,
          });
          this.openBlock = "";
        }
      }
    }
    return added;
  }

  /** The answer (text or a tool call) has begun: thinking time ends here. */
  markAnswer(now: number): void {
    if (this.startAt !== undefined && this.endAt === undefined) {
      this.endAt = now;
    }
  }

  /** The reply's reasoning, or undefined when it had none. */
  result(now: number): StreamedReasoning | undefined {
    if (this.startAt === undefined) return undefined;
    if (!this.text && this.details.length === 0) return undefined;
    return {
      text: this.text,
      startAt: this.startAt,
      endAt: this.endAt ?? now,
      details: this.details,
    };
  }
}

/** "Thought for 4s" / "Thought for 1m 5s" for a reasoning span. */
export function thoughtForLabel(startAt: number, endAt: number): string {
  const seconds = Math.max(0, Math.round((endAt - startAt) / 1000));
  if (seconds < 60) return `Thought for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `Thought for ${minutes}m ${seconds % 60}s`;
}
