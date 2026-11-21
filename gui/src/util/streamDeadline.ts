/**
 * A deadline on the model's stream.
 *
 * The HTTP layer ends a connection that is silent for two hours, and the loop
 * that reads the model's chunks waited without limit. A connection that stayed
 * open and sent nothing therefore showed "Generating…" with no sign of a
 * problem, and the person's next message was sent into a turn that was already
 * dead (plans/research/usage-review-2026-11-21.md, finding 2.2).
 *
 * Silence is measured between chunks. The limit before the first chunk is
 * longer, because a reasoning model may think for a while before it writes, and
 * a local server may be loading the model.
 */

/** Silence allowed once the reply has started. */
export const STALL_AFTER_FIRST_CHUNK_MS = 120_000;
/** Silence allowed before the first chunk arrives. */
export const STALL_BEFORE_FIRST_CHUNK_MS = 600_000;
/** The same two limits for a server the person runs, which may be loading a model. */
export const STALL_AFTER_FIRST_CHUNK_LOCAL_MS = 300_000;
export const STALL_BEFORE_FIRST_CHUNK_LOCAL_MS = 1_800_000;

/** How long the model may be silent, for this stream. */
export function stallLimitMs(options: {
  sawChunk: boolean;
  local: boolean;
}): number {
  if (options.local) {
    return options.sawChunk
      ? STALL_AFTER_FIRST_CHUNK_LOCAL_MS
      : STALL_BEFORE_FIRST_CHUNK_LOCAL_MS;
  }
  return options.sawChunk
    ? STALL_AFTER_FIRST_CHUNK_MS
    : STALL_BEFORE_FIRST_CHUNK_MS;
}

/** "2 minutes", "45 seconds": a length of silence a person can read. */
export function describeSilence(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/**
 * Thrown when the model stopped sending. The words are what the person reads in
 * the error dialog, so they say what happened and what is kept. They avoid the
 * words the retry logic treats as an overload.
 */
export class StreamStalledError extends Error {
  readonly silentMs: number;
  readonly sawChunk: boolean;
  constructor(silentMs: number, sawChunk: boolean) {
    super(
      sawChunk
        ? `The model stopped sending its reply and was silent for ${describeSilence(silentMs)}, so the request was ended. Your message and what arrived are kept; use Resume to continue.`
        : `The model sent nothing for ${describeSilence(silentMs)}, so the request was ended. Your message is kept; use Resume to try again.`,
    );
    this.name = "StreamStalledError";
    this.silentMs = silentMs;
    this.sawChunk = sawChunk;
  }
}

export function isStreamStalled(error: unknown): error is StreamStalledError {
  return error instanceof StreamStalledError;
}

/**
 * `gen.next()`, but it gives up after `ms` of silence: `onStall` is called (it
 * ends the request) and a StreamStalledError is thrown. The timer is always
 * cleared, so a chunk that arrives in time leaves nothing behind. `ms` of
 * Infinity or less than 1 means no deadline.
 */
export async function nextWithDeadline<T>(
  next: () => Promise<T>,
  ms: number,
  sawChunk: boolean,
  onStall?: () => void,
): Promise<T> {
  if (!Number.isFinite(ms) || ms < 1) return next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = next();
  // If the deadline wins, the request is aborted and this promise settles later
  // (usually by rejecting); that must not become an unhandled rejection.
  pending.catch(() => undefined);
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onStall?.();
      } catch {
        // Ending the request failed. The turn still has to end, and the person
        // should be told the model stalled, which is the cause.
      }
      reject(new StreamStalledError(ms, sawChunk));
    }, ms);
  });
  try {
    return await Promise.race([pending, stalled]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
