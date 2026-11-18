import type { ChatMessage, ToolResultChatMessage } from "..";

/**
 * Masking of old tool results (plans/memory-ageing.md, row VA1).
 *
 * Pure functions over a list of chat messages. Nothing here is wired into a
 * request path: no caller exists yet, so no request changes. The replay
 * harness (cacheReplay.ts) is what decides whether the policy pays for itself.
 *
 * Masking replaces the body of an old tool result with a one-line stub that
 * names the tool, the size and a recall handle. The full body is returned to
 * the caller in `masked`, which is the only place it is kept: the caller owns
 * the lossless copy (the session log, a spill file) and can put a body back
 * with `unmaskToolResults`. Tool inputs, assistant text, user text and
 * thinking are never touched.
 *
 * Every edit to a message that was already sent rewrites the cached prompt
 * prefix from that message onward. Masking therefore must run in batches, not
 * on every turn; `maskOldToolResults` is deterministic and idempotent so a
 * batch applied twice produces the same bytes.
 */

/** Most recent tool results left untouched. Proposal; tuned by the replay harness. */
export const AGEING_KEEP_RECENT_TOOL_RESULTS = 5;

/** A result shorter than this is not worth a stub (the stub is about 25 tokens). */
export const AGEING_MIN_RESULT_CHARS = 600;

/** Characters per token for the size estimate. Rough on purpose. */
export const AGEING_CHARS_PER_TOKEN = 4;

/** Tools whose results are never masked: the task list is re-sent each turn anyway. */
export const AGEING_PROTECTED_TOOLS: readonly string[] = [
  "task_list",
  "Checklist",
];

/**
 * Name of the built-in tool that returns a masked body. The stub text names
 * it, and core/tools/builtIn.ts must carry the same string (a test checks).
 */
export const RECALL_TOOL_NAME = "recall_masked_result";

/** Marks a masked message, in `metadata` and at the start of the stub text. */
export const AGEING_STUB_PREFIX = "[tool result masked";
export const AGEING_METADATA_KEY = "maskedResult";

export interface MaskOptions {
  /** Newest tool results to leave alone. Default AGEING_KEEP_RECENT_TOOL_RESULTS. */
  keepRecent?: number;
  /** Results shorter than this stay. Default AGEING_MIN_RESULT_CHARS. */
  minChars?: number;
  /** Tool names never masked. Default AGEING_PROTECTED_TOOLS. */
  protectedTools?: readonly string[];
  /**
   * Extra veto: return true to keep a result (for example a pinned one, or an
   * error from the last turns). Receives the tool name when it can be found.
   */
  keep?: (
    message: ToolResultChatMessage,
    toolName: string | undefined,
  ) => boolean;
  /**
   * The stub text for a masked result. Default `stubText` (which names the
   * recall tool). Must be deterministic, so the same input gives the same bytes.
   */
  stub?: (
    message: ToolResultChatMessage,
    toolName: string | undefined,
    chars: number,
    handle: string,
  ) => string;
}

export interface MaskedResult {
  /** Handle written in the stub; stable for the same call and body. */
  handle: string;
  toolCallId: string;
  toolName: string | undefined;
  /** Index of the message in the input list. */
  index: number;
  /** The full original body, for the caller to store. */
  original: string;
  originalChars: number;
}

export interface MaskOutcome {
  /** A new list; the input list and its messages are not modified. */
  messages: ChatMessage[];
  masked: MaskedResult[];
  freedChars: number;
  freedTokensEstimate: number;
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / AGEING_CHARS_PER_TOKEN);
}

/** FNV-1a, 32 bit, as 8 hex digits. Not security relevant: a label for a handle. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function recallHandle(toolCallId: string, body: string): string {
  return `mask-${fnv1a(`${toolCallId}\n${body}`)}`;
}

export function isMaskedToolResult(message: ChatMessage): boolean {
  return (
    message.role === "tool" &&
    (message.metadata?.[AGEING_METADATA_KEY] !== undefined ||
      message.content.startsWith(AGEING_STUB_PREFIX))
  );
}

/** One line, fixed wording, so the same input always gives the same bytes. */
export function stubText(
  handle: string,
  toolName: string | undefined,
  chars: number,
): string {
  return `${AGEING_STUB_PREFIX}: ${toolName ?? "unknown tool"}, ${chars} chars. Call ${RECALL_TOOL_NAME} with handle ${handle} to read it again]`;
}

/** Tool name for each tool call id, read from the assistant messages. */
function toolNamesById(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      if (call.id && call.function?.name)
        names.set(call.id, call.function.name);
    }
  }
  return names;
}

export function maskOldToolResults(
  messages: ChatMessage[],
  options: MaskOptions = {},
): MaskOutcome {
  const keepRecent = Math.max(
    0,
    options.keepRecent ?? AGEING_KEEP_RECENT_TOOL_RESULTS,
  );
  const minChars = options.minChars ?? AGEING_MIN_RESULT_CHARS;
  const protectedTools = options.protectedTools ?? AGEING_PROTECTED_TOOLS;
  const names = toolNamesById(messages);

  const toolIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") toolIndexes.push(i);
  });
  const eligibleEnd = toolIndexes.length - keepRecent;
  const oldIndexes = new Set(toolIndexes.slice(0, Math.max(0, eligibleEnd)));

  const out: ChatMessage[] = [];
  const masked: MaskedResult[] = [];
  let freedChars = 0;
  messages.forEach((m, index) => {
    if (m.role !== "tool" || !oldIndexes.has(index) || isMaskedToolResult(m)) {
      out.push(m);
      return;
    }
    const toolName = names.get(m.toolCallId);
    const chars = m.content.length;
    if (
      chars < minChars ||
      (toolName !== undefined && protectedTools.includes(toolName)) ||
      options.keep?.(m, toolName)
    ) {
      out.push(m);
      return;
    }
    const handle = recallHandle(m.toolCallId, m.content);
    const content = options.stub
      ? options.stub(m, toolName, chars, handle)
      : stubText(handle, toolName, chars);
    out.push({
      ...m,
      content,
      metadata: { ...m.metadata, [AGEING_METADATA_KEY]: handle },
    });
    masked.push({
      handle,
      toolCallId: m.toolCallId,
      toolName,
      index,
      original: m.content,
      originalChars: chars,
    });
    freedChars += chars - content.length;
  });

  return {
    messages: out,
    masked,
    freedChars,
    freedTokensEstimate: estimateTokens(freedChars),
  };
}

/**
 * Put bodies back. `originals` maps a handle to its body (built from
 * `MaskOutcome.masked`, or read back from the caller's store). A handle with
 * no body leaves the stub in place.
 */
export function unmaskToolResults(
  messages: ChatMessage[],
  originals: ReadonlyMap<string, string>,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool") return m;
    const handle = m.metadata?.[AGEING_METADATA_KEY];
    if (typeof handle !== "string") return m;
    const body = originals.get(handle);
    if (body === undefined) return m;
    const { [AGEING_METADATA_KEY]: _dropped, ...rest } = m.metadata ?? {};
    return {
      ...m,
      content: body,
      metadata: Object.keys(rest).length ? rest : undefined,
    };
  });
}

// ---- the recall store ----

/** Bodies kept for recall in this process. Oldest dropped first. */
export const AGEING_STORE_MAX_ENTRIES = 500;
export const AGEING_STORE_MAX_CHARS = 20_000_000;

const recallStore = new Map<string, string>();
let recallStoreChars = 0;

/** Keep the bodies of freshly masked results so the model can ask for one back. */
export function rememberMasked(items: readonly MaskedResult[]): void {
  for (const item of items) {
    const old = recallStore.get(item.handle);
    if (old !== undefined) {
      recallStoreChars -= old.length;
      recallStore.delete(item.handle);
    }
    recallStore.set(item.handle, item.original);
    recallStoreChars += item.original.length;
  }
  for (const key of recallStore.keys()) {
    if (
      recallStore.size <= AGEING_STORE_MAX_ENTRIES &&
      recallStoreChars <= AGEING_STORE_MAX_CHARS
    ) {
      break;
    }
    recallStoreChars -= recallStore.get(key)!.length;
    recallStore.delete(key);
  }
}

/** The text the recall tool returns for a handle. */
export function recallMasked(handle: string): string {
  const body = recallStore.get(handle);
  if (body !== undefined) return body;
  return `No stored result for handle ${handle}. It may come from an earlier run of the editor; run the original tool call again if you still need it.`;
}

export function clearRecallStore(): void {
  recallStore.clear();
  recallStoreChars = 0;
}

// ---- ageing a request (used by compileChatMessages, off by default) ----

/** Environment switch. Anything but "1", "true" or "on" leaves ageing off. */
export const AGEING_ENV = "CONTINUE_HISTORY_AGEING";

export function historyAgeingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env[AGEING_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** Results masked per batch step: the masked count only moves in multiples of this. */
export const AGEING_BATCH_STEP = 5;
/** Start ageing when the raw history reaches this share of the usable window. */
export const AGEING_TRIGGER_FRACTION = 0.5;
/** Above this share, age even with a warm cache: pruning would rebuild it anyway. */
export const AGEING_FORCE_FRACTION = 0.9;
/** A request after this long is taken to find the cache cold (the 5 minute lifetime). */
export const AGEING_CACHE_LIFETIME_MS = 300_000;

export interface AgeingState {
  /** Identifies the conversation (first user message); a new one resets the rest. */
  key: string;
  /** How many of the oldest tool results are masked, a multiple of the batch step. */
  maskedThrough: number;
  lastRequestAt?: number;
}

export function newAgeingState(): AgeingState {
  return { key: "", maskedThrough: 0 };
}

export interface AgeRequestOutcome {
  messages: ChatMessage[];
  /** True on the request where the masked set grew: the cached prefix is rewritten here. */
  didAge: boolean;
  masked: MaskedResult[];
}

function charsOf(m: ChatMessage): number {
  if (typeof m.content === "string") return m.content.length;
  let n = 0;
  for (const part of m.content)
    n += part.type === "text" ? part.text.length : 4000;
  return n;
}

function conversationKey(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  return first
    ? fnv1a(
        typeof first.content === "string"
          ? first.content
          : JSON.stringify(first.content),
      )
    : "";
}

/**
 * Apply ageing to a request. Pure apart from the `state` it updates.
 *
 * The masked set is the oldest `state.maskedThrough` tool results, so between
 * batches the same messages give the same bytes and the cached prefix holds.
 * The count grows only when the raw history is large (AGEING_TRIGGER_FRACTION
 * of `availableTokens`) and either the cache has expired (a rebuild is free
 * then) or the window is nearly full (AGEING_FORCE_FRACTION), and then only in
 * multiples of AGEING_BATCH_STEP.
 */
export function ageRequest(
  messages: ChatMessage[],
  args: {
    state: AgeingState;
    availableTokens: number;
    now?: number;
    options?: MaskOptions;
  },
): AgeRequestOutcome {
  const { state, availableTokens } = args;
  const now = args.now ?? Date.now();
  const keepRecent =
    args.options?.keepRecent ?? AGEING_KEEP_RECENT_TOOL_RESULTS;
  const key = conversationKey(messages);
  if (key !== state.key) {
    state.key = key;
    state.maskedThrough = 0;
    state.lastRequestAt = undefined;
  }
  const cold =
    state.lastRequestAt === undefined ||
    now - state.lastRequestAt > AGEING_CACHE_LIFETIME_MS;
  state.lastRequestAt = now;

  const toolCount = messages.filter((m) => m.role === "tool").length;
  const rawTokens = estimateTokens(
    messages.reduce((s, m) => s + charsOf(m), 0),
  );
  let desired = 0;
  if (rawTokens >= availableTokens * AGEING_TRIGGER_FRACTION) {
    desired =
      Math.floor(Math.max(0, toolCount - keepRecent) / AGEING_BATCH_STEP) *
      AGEING_BATCH_STEP;
  }
  const force = rawTokens >= availableTokens * AGEING_FORCE_FRACTION;
  let didAge = false;
  if (desired > state.maskedThrough && (cold || force)) {
    state.maskedThrough = desired;
    didAge = true;
  }
  if (state.maskedThrough === 0) return { messages, didAge: false, masked: [] };

  const outcome = maskOldToolResults(messages, {
    ...args.options,
    keepRecent: Math.max(0, toolCount - state.maskedThrough),
  });
  rememberMasked(outcome.masked);
  return { messages: outcome.messages, didAge, masked: outcome.masked };
}
