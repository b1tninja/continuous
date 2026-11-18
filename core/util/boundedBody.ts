/**
 * Read a response body with a byte ceiling and a deadline, instead of
 * `resp.text()`, which reads everything the server sends for as long as it
 * sends it. The ceiling applies to the bytes the HTTP client hands over, which
 * is after content decoding (node-fetch inflates gzip and brotli), so a small
 * compressed body that expands enormously is cut at the same limit.
 */

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_FETCH_DEADLINE_MS = 20_000;

export interface BoundedBody {
  text: string;
  /** More bytes were available than the ceiling allowed. */
  truncated: boolean;
  bytes: number;
}

type AnyBody = {
  getReader?: () => {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  destroy?: (error?: Error) => void;
};

export class FetchDeadlineError extends Error {
  /** The deadline that passed, in milliseconds. */
  readonly ms: number;
  constructor(ms: number) {
    super(`The request did not finish within ${Math.round(ms / 1000)} seconds`);
    this.name = "FetchDeadlineError";
    this.ms = ms;
  }
}

/** Rejects when the signal aborts; never resolves. */
function aborted(signal: AbortSignal | undefined, ms: number): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fail = () => reject(new FetchDeadlineError(ms));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function charsetOf(contentType: string | null | undefined): string {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "");
  return m ? m[1] : "utf-8";
}

function decode(bytes: Uint8Array, charset: string, truncated: boolean) {
  let text: string;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  // A cut can land inside a multi-byte character
  return truncated ? text.replace(/�$/, "") : text;
}

type CappedResponse = {
  body?: unknown;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get?(name: string): string | null };
};

interface CapOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  deadlineMs?: number;
}

/** The body as bytes, cut at the ceiling, read before the deadline. */
export async function readBytesCapped(
  resp: CappedResponse,
  options: CapOptions = {},
): Promise<{ data: Uint8Array; truncated: boolean }> {
  const max = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const ms = options.deadlineMs ?? DEFAULT_FETCH_DEADLINE_MS;
  const body = resp.body as AnyBody | null | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  // Returns true when the ceiling was reached and reading should stop.
  const take = (chunk: Uint8Array | string): boolean => {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    const room = max - total;
    if (bytes.length > room) {
      chunks.push(bytes.subarray(0, room));
      total += room;
      truncated = true;
      return true;
    }
    chunks.push(bytes);
    total += bytes.length;
    // A body of exactly `max` bytes is only known to be complete once the next read ends
    return false;
  };

  const abort = aborted(options.signal, ms);
  abort.catch(() => undefined);

  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), abort]);
        if (done) break;
        if (value && take(value)) break;
      }
    } finally {
      if (truncated || options.signal?.aborted) {
        reader.cancel().catch(() => undefined);
      }
    }
  } else if (body && typeof body[Symbol.asyncIterator] === "function") {
    const it = body[Symbol.asyncIterator]!();
    try {
      for (;;) {
        const { done, value } = await Promise.race([it.next(), abort]);
        if (done) break;
        if (take(value as Uint8Array | string)) break;
      }
    } finally {
      if (truncated || options.signal?.aborted) {
        body.destroy?.();
        it.return?.()?.catch?.(() => undefined);
      }
    }
  } else if (typeof resp.arrayBuffer === "function") {
    // No stream to read (a minimal Response): bounded after the fact
    take(new Uint8Array(await Promise.race([resp.arrayBuffer(), abort])));
  } else {
    take(await Promise.race([resp.text(), abort]));
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return { data, truncated };
}

/** Decode body bytes by the header's charset, else UTF-8. */
export function decodeBytes(
  data: Uint8Array,
  contentType: string | null | undefined,
  truncated: boolean,
): string {
  return decode(data, charsetOf(contentType), truncated);
}

export async function readBodyCapped(
  resp: CappedResponse,
  options: CapOptions = {},
): Promise<BoundedBody> {
  const { data, truncated } = await readBytesCapped(resp, options);
  return {
    text: decodeBytes(data, resp.headers?.get?.("content-type"), truncated),
    truncated,
    bytes: data.length,
  };
}

/**
 * Run `work` with a signal that aborts after `ms`. The deadline covers the
 * whole call (connect, redirects, body), and a `work` that ignores the signal
 * is still abandoned when it passes.
 */
export async function withDeadline<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([
      work(controller.signal),
      aborted(controller.signal, ms),
    ]);
  } catch (e) {
    if (controller.signal.aborted && !(e instanceof FetchDeadlineError)) {
      throw new FetchDeadlineError(ms);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
