import type { ChatMessage } from "core";
import { parseContextOverflow } from "core/llm/contextOverflow";
import { renderChatMessage } from "core/util/messageContent";

/**
 * In-memory diagnostic log for the chat webview. It is off until the person
 * opens it, it is not written to the session, and it is not the prompt-token
 * ageing in core/util/contextAgeing.ts.
 */
export const CHAT_DEBUG_LIMIT = 80;
const SUMMARY_LIMIT = 400;
const DEDUPE_MS = 400;

export type ChatDebugKind =
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

export function noteContextWindow(summary: string): void {
  noteChatDebug("context-window", summary);
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
  noteChatDebug("compile", `Compile failed: ${message}`);
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
      `Context window refused the request${sizes}`,
    );
    return;
  }
  noteChatDebug(
    "provider-error",
    text ? `Provider error: ${text}` : "The provider returned an error",
  );
}

export function noteToolFailure(name: string, detail: unknown): void {
  const why = brief(detail);
  noteChatDebug(
    "tool-error",
    why ? `${name} failed: ${why}` : `${name} failed`,
  );
}

interface StopItem {
  message: { role: string; content?: unknown };
  toolCallStates?: readonly unknown[];
}

/** The reply ended with an assistant message that has neither text nor tool calls. */
export function noteStreamStop(history: readonly StopItem[]): void {
  let assistant: StopItem | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const role = history[i].message.role;
    if (role === "user") break;
    if (role === "assistant") {
      assistant = history[i];
      break;
    }
  }
  if (!assistant) return;
  const content = assistant.message.content;
  const text =
    content == null
      ? ""
      : renderChatMessage(assistant.message as ChatMessage).trim();
  if (text || (assistant.toolCallStates?.length ?? 0) > 0) return;
  noteChatDebug("stream-empty", "Stream stopped with no reply text");
}
