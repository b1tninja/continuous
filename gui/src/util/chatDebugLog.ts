import { parseContextOverflow } from "core/llm/contextOverflow";
import { measureModelTurn, type TurnItem } from "./emptyStop";

/**
 * In-memory diagnostic log for the chat webview. It is off until the person
 * opens it, it is not written to the session, and it is not the prompt-token
 * ageing in core/util/contextAgeing.ts.
 */
export const CHAT_DEBUG_LIMIT = 80;
const SUMMARY_LIMIT = 700;
const DEDUPE_MS = 400;

export type ChatDebugKind =
  | "turn"
  | "stream-empty"
  | "context-window"
  | "tool-error"
  | "compile"
  | "provider-error";

export interface ChatDebugEvent {
  id: number;
  at: number;
  kind: ChatDebugKind;
  summary: string;
}

const KIND_LABEL: Record<ChatDebugKind, string> = {
  turn: "Turn",
  "stream-empty": "Stream",
  "context-window": "Context",
  compile: "Compile",
  "tool-error": "Tool",
  "provider-error": "Provider",
};

export function chatDebugKindLabel(kind: ChatDebugKind): string {
  return KIND_LABEL[kind];
}

type Listener = () => void;

let events: ChatDebugEvent[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

function clip(summary: string): string {
  return summary.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);
}

export function noteChatDebug(kind: ChatDebugKind, summary: string): void {
  const text = clip(summary);
  if (!text) return;
  const at = Date.now();
  const last = events[events.length - 1];
  if (
    last &&
    last.kind === kind &&
    last.summary === text &&
    at - last.at < DEDUPE_MS
  ) {
    return;
  }
  const next = events.concat({ id: nextId++, at, kind, summary: text });
  events =
    next.length > CHAT_DEBUG_LIMIT ? next.slice(-CHAT_DEBUG_LIMIT) : next;
  emit();
}

export function getChatDebugEvents(): readonly ChatDebugEvent[] {
  return events;
}

export function subscribeChatDebug(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearChatDebug(): void {
  if (events.length === 0) return;
  events = [];
  emit();
}

/** Drops events between tests. */
export function resetChatDebugForTests(): void {
  events = [];
  nextId = 1;
  requestFacts = undefined;
  turnEndNoted = false;
  emit();
}

function brief(value: unknown): string {
  if (typeof value === "string") return clip(value);
  if (value == null) return "";
  try {
    return clip(JSON.stringify(value));
  } catch {
    return "";
  }
}

/** The request that was just sent, so a later stop can name the cap and the window. */
export interface RequestFacts {
  model?: string;
  provider?: string;
  /** Cap that will be sent, after the model and window fit. */
  maxTokens?: number;
  /** Configured cap, when it differs from what will be sent. */
  askedMaxTokens?: number;
  /** A thinking raise may not pass this. */
  ceiling?: number;
  /** Our token estimate of the compiled prompt, tools included. */
  promptEstimate?: number;
  contextLength?: number;
  pruned?: boolean;
  outputTokensAvailable?: number;
}

let requestFacts: RequestFacts | undefined;
/** Set when this turn's ending was already written, so setInactive does not write it again. */
let turnEndNoted = false;

export function noteRequestSent(facts: RequestFacts): void {
  requestFacts = facts;
  turnEndNoted = false;
}

function requestSuffix(): string {
  const facts = requestFacts;
  if (!facts) return "";
  const asked =
    facts.askedMaxTokens !== undefined &&
    facts.askedMaxTokens !== facts.maxTokens
      ? `, asked=${facts.askedMaxTokens}`
      : "";
  const ceiling =
    facts.ceiling !== undefined && facts.ceiling !== facts.maxTokens
      ? `, ceiling=${facts.ceiling}`
      : "";
  const bits = [
    facts.provider ? `provider=${facts.provider}` : "",
    facts.model ? `model=${facts.model}` : "",
    facts.maxTokens !== undefined
      ? `maxTokens=${facts.maxTokens}${asked}${ceiling}`
      : "",
    facts.contextLength !== undefined ? `context=${facts.contextLength}` : "",
    facts.promptEstimate !== undefined
      ? `promptEstimate=${facts.promptEstimate}`
      : "",
    facts.outputTokensAvailable !== undefined
      ? `room=${facts.outputTokensAvailable}`
      : "",
    facts.pruned ? "pruned" : "",
  ].filter((bit) => bit.length > 0);
  return bits.length ? ` ${bits.join(", ")}.` : "";
}

export function noteContextWindow(summary: string): void {
  noteChatDebug("context-window", `${summary}${requestSuffix()}`);
}

/** A compile that changed the request: pruned to the window, or prompt ageing. */
export function noteCompiledRequest(flags: {
  didPrune?: boolean;
  didAge?: boolean;
}): void {
  if (!flags.didPrune && !flags.didAge) return;
  const parts = ["Compiled the request"];
  if (flags.didPrune) {
    parts.push("pruned messages to fit the context window");
  }
  if (flags.didAge) {
    parts.push("aged old tool results out of the prompt");
  }
  noteChatDebug("compile", parts.join("; "));
}

export function noteCompileFailure(message: string): void {
  noteChatDebug("compile", `Compile failed: ${message}${requestSuffix()}`);
}

export function noteProviderFailure(message: string | undefined): void {
  const text = (message ?? "").trim();
  const overflow = text ? parseContextOverflow(text) : undefined;
  if (
    overflow ||
    /not enough context|context length|maximum context|prompt is too long|input is too long/i.test(
      text,
    )
  ) {
    const sizes =
      overflow?.actualTokens !== undefined && overflow.maxTokens !== undefined
        ? ` (${overflow.actualTokens} tokens, limit ${overflow.maxTokens})`
        : "";
    noteChatDebug(
      "context-window",
      `Context window refused the request${sizes}${text ? `: ${text}` : ""}${requestSuffix()}`,
    );
    return;
  }
  const capRefused =
    /maximum tokens|max_tokens|model limit|output token maximum/i.test(text);
  noteChatDebug(
    "provider-error",
    text
      ? `${capRefused ? "Output cap refused" : "Provider error"}: ${text}${requestSuffix()}`
      : `The provider returned an error${requestSuffix()}`,
  );
}

/**
 * The agent is not going on to another model turn. One line names the stop
 * reason, what the turn contained, and the cap and window that were sent.
 */
export function noteTurnEnded(input: {
  history: readonly TurnItem[];
  stopReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** no-tool-call: nothing to run, so the loop ends. approval: waiting on the person. */
  why: "no-tool-call" | "approval";
}): void {
  turnEndNoted = true;
  const shape = measureModelTurn(input.history);
  const stop = input.stopReason ?? "not reported";
  let lead: string;
  if (input.why === "approval") {
    lead = "Paused for approval. The agent has not stopped.";
  } else if (input.stopReason === "model_context_window_exceeded") {
    lead = "Stopped because the reply hit the context window.";
  } else if (
    input.stopReason === "length" ||
    input.stopReason === "max_tokens"
  ) {
    lead = shape.lacksReply
      ? "Stopped because the output limit was reached before a reply."
      : "Stopped because the output limit was reached.";
  } else if (shape.lacksReply) {
    lead =
      shape.thinkingChars > 0
        ? "Stopped with no reply and no tool call. The only text was reasoning."
        : "Stopped with no reply and no tool call.";
  } else if (shape.toolCalls === 0) {
    lead =
      "Stopped after a reply, with no tool call, so the agent did not continue.";
  } else {
    lead = "Turn ended.";
  }
  const usage = [
    input.promptTokens !== undefined
      ? `promptTokens=${input.promptTokens}`
      : "",
    input.completionTokens !== undefined
      ? `completionTokens=${input.completionTokens}`
      : "",
  ].filter((bit) => bit.length > 0);
  noteChatDebug(
    shape.lacksReply ? "stream-empty" : "turn",
    `${lead} stop=${stop}. answer=${shape.answerChars} chars, thinking=${shape.thinkingChars} chars, tool calls=${shape.toolCalls}.${
      usage.length ? ` ${usage.join(", ")}.` : ""
    }${requestSuffix()}`,
  );
}

/** Stop, a steer, a failed request, or a retry. Suppresses the empty-stream note from setInactive. */
export function noteStreamCancelled(
  reason: "stopped" | "steer" | "error" | "retry",
): void {
  turnEndNoted = true;
  if (reason === "stopped") {
    noteChatDebug("turn", `Stopped by you.${requestSuffix()}`);
  } else if (reason === "steer") {
    noteChatDebug(
      "turn",
      `Interrupted to steer. The reply was cut off so a queued message could be sent.${requestSuffix()}`,
    );
  }
}

/**
 * The agent stopped somewhere that used to return without a word: the stream
 * was cut off before its tool calls, or compaction aborted the next request.
 * A turn line written in the last two seconds (Stop, steer) already says why.
 */
export function noteAgentCut(summary: string): void {
  const last = events[events.length - 1];
  if (
    last &&
    (last.kind === "turn" || last.kind === "stream-empty") &&
    Date.now() - last.at < 2000
  ) {
    return;
  }
  noteChatDebug("turn", `${summary}${requestSuffix()}`);
}

export function noteToolFailure(name: string, detail: unknown): void {
  const why = brief(detail);
  noteChatDebug(
    "tool-error",
    why ? `${name} failed: ${why}` : `${name} failed`,
  );
}

/** The model's turn wrote thinking or an empty assistant, and no answer or tool call. */
export function noteStreamStop(history: readonly TurnItem[]): void {
  if (turnEndNoted) {
    turnEndNoted = false;
    return;
  }
  const shape = measureModelTurn(history);
  if (!shape.lacksReply) return;
  const reasoning =
    shape.thinkingChars > 0 ? " The only text was reasoning." : "";
  noteChatDebug(
    "stream-empty",
    `Stopped with no reply and no tool call.${reasoning} stop=not reported. answer=0 chars, thinking=${shape.thinkingChars} chars, tool calls=0.${requestSuffix()}`,
  );
}
