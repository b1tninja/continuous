/**
 * The local pre-warm of a prepared compaction (C106,
 * plans/research/cache-friendly-context-trimming.md sections 6.3 and 6.4).
 *
 * Once the background summary is ready (C105) and the person is still idle,
 * the post-compaction prompt `[head][summary message][tail]` is sent once with
 * `max_tokens: 1`, built exactly as the next real request will be: the GUI
 * builds the messages and options with `buildChatRequest` on the session as it
 * will be after the summary is saved, and this compiles them with the same
 * `compileChatMessages` that `llm/compileChat` uses. The server reads the
 * summary and the tail while nobody waits, and the read becomes its live
 * session, so the turn that applies the compaction starts from a warm cache
 * instead of reading about 58k tokens (12.5 s on Strata) in the foreground.
 *
 * On Strata the request also carries `strata_prefix: {"messages": K}`, where
 * the first K messages are the system message and the summary message: the
 * engine pins the checkpoint at the end of the summary (Strata
 * `docs/DETAILS.md`, "strata_prefix"; `serve/server.py` `resolve_prefix`), so
 * a later edit in the tail falls back to the summary's end, not to the
 * 16,384-token root. The pre-warm is a conversation request, not a one-shot:
 * it must not carry `strata_checkpoint: false` (`requestBodyHints.oneShot`),
 * which would make Strata keep no session and checkpoint nothing.
 *
 * Only Strata and llama.cpp's `llama-server` are pre-warmed (the note's C106
 * row): both keep the prompt they last read. Strata's `/v1/status`
 * `machine.ram` is checked first, and the pre-warm is skipped when the free
 * memory is less than what it could take (the earlier OOM was a parked 390k
 * conversation, about 7 GB).
 *
 * UNTESTED ON A LIVE SERVER. The request fields follow Strata's documentation
 * and source; whether a 1-token request with `strata_prefix` pins the
 * boundary and whether the next real request then hits there is the release
 * gate of C106 (see the PR).
 */
import type {
  ChatMessage,
  ILLM,
  LLMFullCompletionOptions,
  ModelContextManagement,
  PrewarmSetting,
} from "../index.js";
import { isSummaryMessage } from "../util/summaryMessage.js";
import {
  isLocalApiBase,
  isStrataServer,
  localServerEndpoint,
  serverCapabilities,
} from "./localServers.js";

type FetchFn = typeof fetch;

/** `contextManagement.prewarm` unset: pre-warm local servers only (D6). */
export const DEFAULT_PREWARM: PrewarmSetting = "local";

/** The model's `contextManagement.prewarm`, or the default. */
export function prewarmSetting(model: {
  contextManagement?: ModelContextManagement;
}): PrewarmSetting {
  const value = model.contextManagement?.prewarm;
  return value === "off" || value === "local" || value === "always"
    ? value
    : DEFAULT_PREWARM;
}

/**
 * Whether the setting lets a model be pre-warmed. "always" also asks for a
 * cloud pre-warm, which is C109 and not built: a cloud model is never
 * pre-warmed by this module.
 */
export function prewarmAllowed(
  setting: PrewarmSetting,
  local: boolean,
): boolean {
  if (setting === "off") return false;
  return local;
}

/**
 * Host memory per token of a parked conversation: about 7 GB for a 390k one
 * (the earlier OOM, the note's section 3.8).
 */
export const KV_BYTES_PER_TOKEN = 7e9 / 390_000;
/** One Strata checkpoint, about 118 MB (`DETAILS.md`). */
export const CHECKPOINT_BYTES = 118e6;
/** Strata's `--prompt-cache` default: at most this many checkpoints. */
export const STRATA_MAX_CHECKPOINTS = 6;
/** Strata's `--prompt-cache-every` default. */
export const STRATA_CHECKPOINT_EVERY = 16_384;

/**
 * The host memory the pre-warm could take on Strata, in bytes: the K/V of the
 * prompt it reads, its checkpoints (one every 16,384 tokens, the pin and the
 * turn boundary, at most 6), and the K/V of the conversation it replaces,
 * which Strata's conversation cache may park in host RAM before it switches.
 * `strata_prefix` is documented not to park the branch it leaves, but that
 * is unverified on the owner's engine, and parking is what ran out of memory
 * before, so it is counted.
 */
export function prewarmMemoryBytes(
  promptTokens: number,
  liveTokens = 0,
): number {
  const checkpoints = Math.min(
    STRATA_MAX_CHECKPOINTS,
    Math.ceil(Math.max(0, promptTokens) / STRATA_CHECKPOINT_EVERY) + 2,
  );
  return (
    Math.max(0, promptTokens) * KV_BYTES_PER_TOKEN +
    Math.max(0, liveTokens) * KV_BYTES_PER_TOKEN +
    checkpoints * CHECKPOINT_BYTES
  );
}

/** Free host memory from Strata's `/v1/status` `machine.ram`, in bytes. */
export function freeMemoryFromStatus(status: unknown): number | undefined {
  const ram = (
    status as {
      machine?: { ram?: { used_gib?: unknown; total_gib?: unknown } };
    }
  )?.machine?.ram;
  const used = ram?.used_gib;
  const total = ram?.total_gib;
  if (typeof used !== "number" || typeof total !== "number") return undefined;
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return Math.max(0, total - used) * 2 ** 30;
}

/**
 * How many leading messages Strata's pin covers: up to and including the
 * summary message, which is the first message after the system message, the
 * same test the block drop uses to keep it with the head (countTokens.ts).
 * Undefined when there is no summary message there, or nothing after it.
 */
export function summaryPinMessages(
  messages: readonly ChatMessage[],
): number | undefined {
  const at = messages[0]?.role === "system" ? 1 : 0;
  if (!isSummaryMessage(messages[at])) return undefined;
  const k = at + 1;
  // Strata ignores a prefix that does not leave at least the last message
  return k < messages.length ? k : undefined;
}

export type PrewarmServer = "strata" | "llama.cpp";

/** Strata (`/v1/status`), llama.cpp (`/props`), or neither. */
export async function prewarmServerKind(
  apiBase: string,
  apiKey?: string,
  fetchFn: FetchFn = fetch,
): Promise<PrewarmServer | undefined> {
  if (!isLocalApiBase(apiBase)) return undefined;
  if (await isStrataServer(apiBase, fetchFn)) return "strata";
  const caps = await serverCapabilities(apiBase, apiKey, fetchFn);
  return caps.llamaCppStyle ? "llama.cpp" : undefined;
}

export type PrewarmSkipReason =
  | "off"
  | "cloud"
  | "unsupported-server"
  | "pruned"
  | "no-summary-message"
  | "memory-unknown"
  | "low-memory"
  | "aborted"
  | "failed";

export type PrewarmResult =
  | {
      status: "sent";
      server: PrewarmServer;
      /** The messages Strata's pin covers (system and summary); none on llama.cpp */
      pinMessages?: number;
      durationMs: number;
    }
  | { status: "skipped"; reason: PrewarmSkipReason; detail: string };

export interface LocalPrewarmArgs {
  llm: Pick<
    ILLM,
    "apiBase" | "apiKey" | "streamChat" | "compileChatMessages"
  > & { contextManagement?: ModelContextManagement };
  /** The post-compaction request's messages, as buildChatRequest made them */
  messages: ChatMessage[];
  /** The same request's options: tools, reasoning, cache settings */
  options: LLMFullCompletionOptions;
  /** Tokens of the pre-warm's prompt (head, summary and tail) */
  promptTokens: number;
  /** Tokens of the conversation the server holds now */
  liveTokens?: number;
  signal: AbortSignal;
  fetchFn?: FetchFn;
  now?: () => number;
}

const GB = (bytes: number) => (bytes / 1e9).toFixed(1);

/** What the next real request's compiled messages and options are, plus the pre-warm's own fields. */
export function prewarmRequestOptions(
  options: LLMFullCompletionOptions,
  pinMessages: number | undefined,
): LLMFullCompletionOptions {
  return {
    ...options,
    maxTokens: 1,
    ...(pinMessages !== undefined && {
      strataPrefix: { messages: pinMessages },
    }),
  };
}

/**
 * Sends the pre-warm, or says why not. Never throws: it runs in the
 * background, and a failure only means the switch-over reads the summary and
 * the tail at the next turn, as it would have without it.
 */
export async function localPrewarm(
  args: LocalPrewarmArgs,
): Promise<PrewarmResult> {
  const { llm, signal } = args;
  const fetchFn = args.fetchFn ?? fetch;
  const now = args.now ?? Date.now;
  const skipped = (
    reason: PrewarmSkipReason,
    detail: string,
  ): PrewarmResult => ({ status: "skipped", reason, detail });

  const setting = prewarmSetting(llm);
  const local = !!llm.apiBase && isLocalApiBase(llm.apiBase);
  if (setting === "off") {
    return skipped("off", "contextManagement.prewarm is off");
  }
  if (!prewarmAllowed(setting, local) || !llm.apiBase) {
    return skipped(
      "cloud",
      "Only local servers are pre-warmed (a cloud pre-warm is not built yet)",
    );
  }
  try {
    const server = await prewarmServerKind(llm.apiBase, llm.apiKey, fetchFn);
    if (!server) {
      return skipped(
        "unsupported-server",
        "The server is neither Strata nor llama.cpp, so it may not keep the prompt it read",
      );
    }
    signal.throwIfAborted();

    // The same compile as the real request (llm/compileChat)
    const compiled = llm.compileChatMessages(args.messages, args.options);
    if (compiled.didPrune) {
      return skipped(
        "pruned",
        "The compacted conversation still had to be cut to fit, so the next request would not start with it",
      );
    }
    const messages = compiled.compiledChatMessages;
    const pin = summaryPinMessages(messages);
    if (pin === undefined) {
      return skipped(
        "no-summary-message",
        "The request has no summary message after the system message",
      );
    }

    if (server === "strata") {
      const status = await fetchJson(
        new URL("status", withSlash(llm.apiBase)),
        fetchFn,
        llm.apiKey,
      );
      const free = freeMemoryFromStatus(status);
      const need = prewarmMemoryBytes(args.promptTokens, args.liveTokens);
      if (free === undefined) {
        return skipped(
          "memory-unknown",
          "Strata's /v1/status does not report machine.ram, so the pre-warm could not be checked against free memory",
        );
      }
      if (free < need) {
        return skipped(
          "low-memory",
          `Strata reports about ${GB(free)} GB of free memory and the pre-warm could need about ${GB(need)} GB, so it was not sent`,
        );
      }
    }
    signal.throwIfAborted();

    const start = now();
    const stream = llm.streamChat(
      messages,
      signal,
      prewarmRequestOptions(
        args.options,
        server === "strata" ? pin : undefined,
      ),
      { precompiled: true },
    );
    for await (const _ of stream) {
      // The one token is not used
    }
    return {
      status: "sent",
      server,
      ...(server === "strata" && { pinMessages: pin }),
      durationMs: now() - start,
    };
  } catch (e) {
    if (signal.aborted) return skipped("aborted", "Stopped by activity");
    return skipped("failed", e instanceof Error ? e.message : String(e));
  }
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchJson(
  url: URL,
  fetchFn: FetchFn,
  apiKey?: string,
): Promise<unknown> {
  try {
    const response = await fetchFn(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/** Strata's `/metrics`, for the Compact now estimate's speeds (read only). */
export async function strataMetrics(
  apiBase: string | undefined,
  apiKey?: string,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  if (!apiBase || !isLocalApiBase(apiBase)) return undefined;
  if (!(await isStrataServer(apiBase, fetchFn))) return undefined;
  return fetchJson(localServerEndpoint(apiBase, "metrics"), fetchFn, apiKey);
}
