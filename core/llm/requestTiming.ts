import type {
  ChatMessage,
  PromptProgress,
  RequestPhase,
  RequestTiming,
  TimedValue,
  Usage,
} from "../index.js";

/**
 * J15: one request's timing, folded from the chunks of its stream
 * (plans/research/throughput-latency-display.md section 6.1). Nothing is sent
 * and nothing is polled to fill it: every number comes from the stream that is
 * already being read, and each carries where it came from:
 *
 * - `server`: the server's own clock or count (llama.cpp and Strata
 *   `timings`, Ollama's durations, Bedrock's latency, a provider's usage);
 * - `measured`: this client's clock (and, for a rate, the provider's count);
 * - `estimate`: from characters, at four characters per token.
 *
 * The record is plain data, so it travels on `Usage.timing` and in the LLM
 * log with no conversion.
 */

/** No delta for this long while the stream is open is a stall. */
export const STALL_MS = 15_000;
/** The live rate counts the characters of this last stretch. */
export const LIVE_WINDOW_MS = 3_000;
/** No rate is given for fewer tokens than this. */
export const MIN_RATE_TOKENS = 20;
/** Nor a live rate before this much output time. */
export const MIN_LIVE_MS = 1_000;
/** The rule already used by contextBreakdown and forkCost. */
export const CHARS_PER_TOKEN = 4;
/** Phase entries kept per request; later changes update only the live phase. */
const MAX_PHASES = 200;

const utf8 = new TextEncoder();

/** Two significant figures: a live rate is not more precise than that. */
export function twoFigures(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number(n.toPrecision(2));
}

interface Delta {
  phase?: RequestPhase;
  chars: number;
  toolArgBytes: number;
  toolName?: string;
  /** A thinking block whose text the provider does not send. */
  hiddenThinking?: boolean;
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** What one chunk adds to the output, and the phase it puts the request in. */
function deltaOf(m: ChatMessage): Delta | undefined {
  if (m.role === "thinking") {
    const text = typeof m.content === "string" ? m.content : textOf(m.content);
    if (text) return { phase: "thinking", chars: text.length, toolArgBytes: 0 };
    // An empty thinking delta, a signature or a redacted block: the model is
    // thinking, but its text is not sent (Anthropic with display "omitted").
    // Whether it was hidden is told at the end: a signature also follows
    // thinking that was sent.
    return {
      phase: "thinking",
      chars: 0,
      toolArgBytes: 0,
      hiddenThinking: true,
    };
  }
  if (m.role !== "assistant") return undefined;
  if (m.promptProgress || m.recoveryHold) return undefined;
  const text = textOf(m.content);
  let toolArgBytes = 0;
  let toolChars = 0;
  let toolName: string | undefined;
  for (const call of m.toolCalls ?? []) {
    const args = call.function?.arguments ?? "";
    toolChars += args.length;
    toolArgBytes += utf8.encode(args).length;
    if (call.function?.name) toolName = call.function.name;
  }
  const isToolDelta = !!m.toolCalls?.length;
  if (!text && !isToolDelta) return undefined;
  return {
    phase: isToolDelta ? "tool-call" : "writing",
    chars: text.length + toolChars,
    toolArgBytes,
    toolName,
  };
}

export interface FinishOptions {
  /** The request was stopped or failed: its counts are partial, so rates are estimates. */
  stopped?: boolean;
}

/**
 * Records one request. Construct it when the request is sent, hand it every
 * chunk with `chunk`, and read it with `snapshot` (live) or `finish` (with
 * the final usage). `now` is the clock; tests pass a fake one.
 */
export class RequestTimer {
  private readonly record: RequestTiming;
  /** Output characters by arrival time, for the live rate. */
  private window: { at: number; chars: number }[] = [];
  private beforeHold?: RequestPhase;
  private lastProgress?: PromptProgress;
  private usage?: Usage;
  private thinkingChars = 0;
  private sawHiddenThinking = false;

  constructor(private readonly now: () => number = Date.now) {
    const t = now();
    this.record = {
      sentAt: t,
      phase: "waiting",
      phaseSince: t,
      phases: [{ phase: "waiting", at: t }],
      outputChars: 0,
    };
  }

  /** The response headers arrived (for a host that sees them). */
  headers(): void {
    this.record.headersAt ??= this.now();
  }

  /** One chunk of the stream, as the provider's parser yields it. */
  chunk(m: ChatMessage): void {
    const t = this.now();
    const r = this.record;
    if (m.role === "assistant" && m.usage) {
      this.usage = m.usage;
      r.firstEventAt ??= t;
    }
    if (m.role === "assistant" && m.promptProgress) {
      r.firstEventAt ??= t;
      this.lastProgress = m.promptProgress;
      if (r.phase === "waiting") this.enter("reading", t);
      return;
    }
    if (m.role === "assistant" && m.recoveryHold) {
      r.firstEventAt ??= t;
      if (m.recoveryHold === "start") {
        if (r.phase !== "held") this.beforeHold = r.phase;
        this.enter("held", t);
      } else if (r.phase === "held") {
        this.enter(this.beforeHold ?? "waiting", t);
      }
      return;
    }
    const d = deltaOf(m);
    if (!d) return;
    r.firstEventAt ??= t;
    r.firstOutputAt ??= t;
    if (d.phase !== "thinking") r.firstContentAt ??= t;
    r.lastOutputAt = t;
    r.outputChars += d.chars;
    if (d.toolArgBytes || d.phase === "tool-call") {
      r.toolArgBytes = (r.toolArgBytes ?? 0) + d.toolArgBytes;
    }
    if (d.phase === "thinking") {
      if (d.chars) this.thinkingChars += d.chars;
      if (d.hiddenThinking) this.sawHiddenThinking = true;
    }
    if (d.chars) this.window.push({ at: t, chars: d.chars });
    // A held stream stays held until its end signal
    if (r.phase === "held") {
      if (d.phase) this.beforeHold = d.phase;
      return;
    }
    if (d.phase) this.enter(d.phase, t, d.toolName);
  }

  private enter(phase: RequestPhase, at: number, tool?: string): void {
    const r = this.record;
    const newTool = phase === "tool-call" && !!tool && tool !== r.toolName;
    if (phase === r.phase && !newTool) return;
    r.phase = phase;
    r.phaseSince = at;
    if (phase === "tool-call" && tool) r.toolName = tool;
    if (r.phases.length < MAX_PHASES) {
      r.phases.push({
        phase,
        at,
        ...(phase === "tool-call" && tool ? { tool } : {}),
      });
    }
  }

  /** The live rate: characters of the last few seconds, a `~` estimate. */
  private liveRate(t: number): TimedValue | undefined {
    const r = this.record;
    if (r.firstOutputAt === undefined) return undefined;
    const sinceFirst = t - r.firstOutputAt;
    if (sinceFirst < MIN_LIVE_MS) return undefined;
    if (r.outputChars / CHARS_PER_TOKEN < MIN_RATE_TOKENS) return undefined;
    this.window = this.window.filter((s) => t - s.at <= LIVE_WINDOW_MS);
    const chars = this.window.reduce((n, s) => n + s.chars, 0);
    if (!chars) return undefined;
    const span = Math.min(LIVE_WINDOW_MS, sinceFirst) / 1000;
    return {
      value: twoFigures(chars / CHARS_PER_TOKEN / span),
      source: "estimate",
    };
  }

  private stalledSince(t: number): number | undefined {
    const r = this.record;
    if (r.phase === "waiting" || r.phase === "reading" || r.phase === "held") {
      return undefined;
    }
    if (r.lastOutputAt === undefined) return undefined;
    return t - r.lastOutputAt >= STALL_MS ? r.lastOutputAt : undefined;
  }

  private common(): RequestTiming {
    const r = this.record;
    const out: RequestTiming = { ...r, phases: [...r.phases] };
    if (this.sawHiddenThinking && !this.thinkingChars) {
      out.thinkingHidden = true;
    }
    if (r.firstOutputAt !== undefined) {
      out.firstTokenMs = {
        value: r.firstOutputAt - r.sentAt,
        source: "measured",
      };
    }
    return out;
  }

  /** The record as it stands, with the live rate and any stall. */
  snapshot(): RequestTiming {
    const t = this.now();
    const out = this.common();
    const rate = this.liveRate(t);
    if (rate) out.outputRate = rate;
    const stalled = this.stalledSince(t);
    if (stalled !== undefined) out.stalledSince = stalled;
    return out;
  }

  /**
   * The record at the end of the request: the final rate with its source,
   * the server's prefill, drafts and latency. `usage` defaults to the last
   * one the stream carried. It can be called more than once (the usage chunk,
   * then the end of the stream); each call reads the clock.
   */
  finish(
    usage: Usage | undefined = this.usage,
    opts: FinishOptions = {},
  ): RequestTiming {
    const endAt = this.now();
    const out = this.common();
    out.endAt = endAt;
    const server = usage?.serverTimings;
    const estimated = Math.round(out.outputChars / CHARS_PER_TOKEN);
    const counted =
      !opts.stopped && usage?.completionTokens ? usage.completionTokens : 0;
    if (counted) {
      out.outputTokens = { value: counted, source: "server" };
    } else if (estimated) {
      out.outputTokens = { value: estimated, source: "estimate" };
    }
    if (usage?.promptTokens) out.promptTokens = usage.promptTokens;

    const span =
      out.firstOutputAt === undefined ? 0 : endAt - out.firstOutputAt;
    const serverTokens = server?.predictedN ?? counted;
    if (
      !opts.stopped &&
      server?.predictedPerSecond &&
      serverTokens >= MIN_RATE_TOKENS
    ) {
      out.outputRate = { value: server.predictedPerSecond, source: "server" };
    } else if (counted >= MIN_RATE_TOKENS && span > 0) {
      out.outputRate = {
        value: (counted * 1000) / span,
        source: "measured",
      };
    } else if (!counted && estimated >= MIN_RATE_TOKENS && span > 0) {
      out.outputRate = {
        value: twoFigures((estimated * 1000) / span),
        source: "estimate",
      };
    }

    if (server?.promptN !== undefined) {
      out.prefill = {
        read: server.promptN,
        cached: server.cacheN ?? 0,
        ...(server.promptMs !== undefined && { ms: server.promptMs }),
        ...(server.promptPerSecond !== undefined && {
          rate: server.promptPerSecond,
        }),
        source: "server",
      };
    } else if (this.lastProgress) {
      // The progress updates say how much was read, not how fast in the end
      const p = this.lastProgress;
      out.prefill = {
        read: Math.max(0, p.total - p.cache),
        cached: p.cache,
        source: "server",
      };
    }
    if (server?.draftN !== undefined) {
      out.drafts = {
        offered: server.draftN,
        accepted: server.draftNAccepted ?? 0,
      };
    }
    if (usage?.response?.latencyMs !== undefined) {
      out.serverLatencyMs = usage.response.latencyMs;
    }
    if (server?.loadMs !== undefined) out.loadMs = server.loadMs;
    return out;
  }
}

/**
 * Hands a chunk to the timer and, on the chunk that carries the usage, puts
 * the record on it as `usage.timing`.
 */
export function withTiming(m: ChatMessage, timer: RequestTimer): ChatMessage {
  timer.chunk(m);
  if (m.role !== "assistant" || !m.usage) return m;
  return { ...m, usage: { ...m.usage, timing: timer.finish(m.usage) } };
}
