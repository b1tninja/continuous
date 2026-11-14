/**
 * A streaming JSON scanner that works on bytes, for files too large to read
 * into one string. A session file whose old prompt logs pass V8's string
 * limit (2^29 - 24 characters on 64-bit builds) cannot be `JSON.parse`d at
 * all, and one just under it needs several times its size in heap; this
 * scanner holds one chunk and a few short strings at a time.
 *
 * It reports where each value starts and ends (byte offsets in the input),
 * the path to it, and the text of short strings. Long strings are skipped
 * with `indexOf`, so a 500 MB prompt costs a few memchr passes, not a
 * JavaScript loop per byte. UTF-8 continuation bytes are never `"` or `\`,
 * so scanning bytes is safe for any text.
 *
 * Structure is checked strictly (brackets, commas, colons, literals and
 * numbers); the inside of strings is checked only for terminated escapes.
 */

import { open } from "node:fs/promises";

export type JsonPathPart = string | number;
export type ScalarKind = "string" | "number" | "true" | "false" | "null";

export interface JsonScanEvents {
  /** A container starts at byte `start`. `path` is only valid during the call. */
  open?(
    path: readonly JsonPathPart[],
    kind: "object" | "array",
    start: number,
  ): void;
  /** A container spans `[start, end)`. */
  close?(
    path: readonly JsonPathPart[],
    kind: "object" | "array",
    start: number,
    end: number,
  ): void;
  /**
   * A scalar spans `[start, end)` (for strings, the quotes included). `text`
   * is the decoded value of a string or the token of a number or literal, or
   * undefined for a string longer than the capture limit.
   */
  scalar?(
    path: readonly JsonPathPart[],
    kind: ScalarKind,
    start: number,
    end: number,
    text: string | undefined,
  ): void;
}

export class JsonScanError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at byte ${offset}`);
    this.name = "JsonScanError";
  }
}

/** Strings up to this many raw bytes are decoded and handed to `scalar`. */
export const STRING_CAPTURE_LIMIT = 256;
/** Object keys up to this many raw bytes are decoded; longer keys read as "". */
const KEY_CAPTURE_LIMIT = 1024;
const ATOM_LIMIT = 512;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const State = {
  Value: 0,
  ValueOrClose: 1,
  Key: 2,
  KeyOrClose: 3,
  Colon: 4,
  After: 5,
  String: 6,
  Atom: 7,
  End: 8,
} as const;
type State = (typeof State)[keyof typeof State];

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

function isAtomByte(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x61 && c <= 0x7a) || // a-z
    c === 0x2d || // -
    c === 0x2b || // +
    c === 0x2e || // .
    c === 0x45 // E
  );
}

export class JsonStreamScanner {
  private state: State = State.Value;
  /** Absolute offset of the first byte of the next chunk. */
  private offset = 0;
  private readonly kinds: ("object" | "array")[] = [];
  private readonly starts: number[] = [];
  private readonly counts: number[] = [];
  private readonly path: JsonPathPart[] = [];

  private stringIsKey = false;
  private stringStart = 0;
  private escape = false;
  private captured: Buffer[] = [];
  private capturedBytes = 0;
  private captureLimit = 0;
  private captureOverflow = false;

  private atom = "";
  private atomStart = 0;

  constructor(private readonly events: JsonScanEvents = {}) {}

  /** Bytes consumed so far. */
  get position(): number {
    return this.offset;
  }

  write(chunk: Buffer): void {
    const n = chunk.length;
    let i = 0;
    // Cached positions of the next quote and backslash in this chunk.
    let nextQuote = -1;
    let nextBackslash = -1;
    while (i < n) {
      if (this.state === State.String) {
        const segment = i;
        let end = -1;
        while (i < n) {
          if (this.escape) {
            this.escape = false;
            i++;
            continue;
          }
          if (nextBackslash < i) {
            nextBackslash = chunk.indexOf(BACKSLASH, i);
            if (nextBackslash === -1) nextBackslash = n;
          }
          if (nextQuote < i) {
            nextQuote = chunk.indexOf(QUOTE, i);
            if (nextQuote === -1) nextQuote = n;
          }
          if (nextBackslash < nextQuote) {
            i = nextBackslash + 1;
            this.escape = true;
            continue;
          }
          if (nextQuote < n) end = nextQuote;
          break;
        }
        this.capture(chunk, segment, end === -1 ? n : end);
        if (end === -1) {
          i = n;
          break;
        }
        i = end + 1;
        this.endString(this.offset + i);
        continue;
      }

      const c = chunk[i];
      if (this.state === State.Atom) {
        if (isAtomByte(c)) {
          this.atom += String.fromCharCode(c);
          if (this.atom.length > ATOM_LIMIT) {
            throw new JsonScanError(
              "Number or literal too long",
              this.offset + i,
            );
          }
          i++;
          continue;
        }
        this.endAtom(this.offset + i);
        continue; // the byte is read again in the new state
      }

      if (isWhitespace(c)) {
        i++;
        continue;
      }
      const at = this.offset + i;
      switch (this.state) {
        case State.Value:
        case State.ValueOrClose:
          if (c === 0x5d /* ] */ && this.state === State.ValueOrClose) {
            this.closeContainer("array", at);
          } else {
            this.beginValue(c, at);
          }
          break;
        case State.Key:
        case State.KeyOrClose:
          if (c === QUOTE) {
            this.beginString(true, at);
          } else if (c === 0x7d /* } */ && this.state === State.KeyOrClose) {
            this.closeContainer("object", at);
          } else {
            throw new JsonScanError("Expected a key", at);
          }
          break;
        case State.Colon:
          if (c !== 0x3a /* : */) throw new JsonScanError("Expected ':'", at);
          this.state = State.Value;
          break;
        case State.After: {
          const kind = this.kinds[this.kinds.length - 1];
          if (c === 0x2c /* , */) {
            this.state = kind === "object" ? State.Key : State.Value;
          } else if (c === 0x7d && kind === "object") {
            this.closeContainer("object", at);
          } else if (c === 0x5d && kind === "array") {
            this.closeContainer("array", at);
          } else {
            throw new JsonScanError("Expected ',' or a closing bracket", at);
          }
          break;
        }
        case State.End:
          throw new JsonScanError("Unexpected data after the end", at);
      }
      i++;
    }
    this.offset += n;
  }

  /** Call after the last chunk. Throws if the input was not one complete value. */
  end(): void {
    if (this.state === State.Atom) this.endAtom(this.offset);
    if (this.state !== State.End) {
      throw new JsonScanError("Unexpected end of input", this.offset);
    }
  }

  private beginValue(c: number, at: number): void {
    const depth = this.kinds.length;
    if (depth > 0 && this.kinds[depth - 1] === "array") {
      this.path[depth - 1] = this.counts[depth - 1]++;
    }
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      const kind = c === 0x7b ? "object" : "array";
      this.events.open?.(this.path, kind, at);
      this.kinds.push(kind);
      this.starts.push(at);
      this.counts.push(0);
      this.path.push(kind === "array" ? 0 : "");
      this.state = kind === "object" ? State.KeyOrClose : State.ValueOrClose;
    } else if (c === QUOTE) {
      this.beginString(false, at);
    } else if (isAtomByte(c)) {
      this.atom = String.fromCharCode(c);
      this.atomStart = at;
      this.state = State.Atom;
    } else {
      throw new JsonScanError("Expected a value", at);
    }
  }

  private closeContainer(kind: "object" | "array", at: number): void {
    const start = this.starts.pop()!;
    this.kinds.pop();
    this.counts.pop();
    this.path.pop();
    this.events.close?.(this.path, kind, start, at + 1);
    this.afterValue();
  }

  private afterValue(): void {
    this.state = this.kinds.length === 0 ? State.End : State.After;
  }

  private beginString(isKey: boolean, at: number): void {
    this.stringIsKey = isKey;
    this.stringStart = at;
    this.escape = false;
    this.captured = [];
    this.capturedBytes = 0;
    this.captureOverflow = false;
    this.captureLimit = isKey ? KEY_CAPTURE_LIMIT : STRING_CAPTURE_LIMIT;
    this.state = State.String;
  }

  private capture(chunk: Buffer, from: number, to: number): void {
    if (this.captureOverflow || to <= from) return;
    if (this.capturedBytes + (to - from) > this.captureLimit) {
      this.captureOverflow = true;
      this.captured = [];
      return;
    }
    this.captured.push(Buffer.from(chunk.subarray(from, to)));
    this.capturedBytes += to - from;
  }

  private decodeCaptured(): string | undefined {
    if (this.captureOverflow) return undefined;
    const raw = Buffer.concat(this.captured).toString("utf8");
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      throw new JsonScanError("Bad string escape", this.stringStart);
    }
  }

  private endString(end: number): void {
    const text = this.decodeCaptured();
    this.captured = [];
    if (this.stringIsKey) {
      this.path[this.path.length - 1] = text ?? "";
      this.state = State.Colon;
      return;
    }
    this.events.scalar?.(this.path, "string", this.stringStart, end, text);
    this.afterValue();
  }

  private endAtom(end: number): void {
    const token = this.atom;
    let kind: ScalarKind;
    if (token === "true" || token === "false" || token === "null") {
      kind = token;
    } else if (NUMBER_RE.test(token)) {
      kind = "number";
    } else {
      throw new JsonScanError("Bad number or literal", this.atomStart);
    }
    this.events.scalar?.(this.path, kind, this.atomStart, end, token);
    this.atom = "";
    this.afterValue();
  }
}

export const SCAN_CHUNK_BYTES = 1 << 20;

/**
 * Scans a whole file in chunks. Reading is asynchronous, so a scan of a large
 * file in the extension host lets other work run between chunks.
 */
export async function scanJsonFile(
  file: string,
  events: JsonScanEvents,
  options: { signal?: AbortSignal; chunkBytes?: number } = {},
): Promise<{ bytes: number }> {
  const handle = await open(file, "r");
  try {
    const scanner = new JsonStreamScanner(events);
    const buffer = Buffer.allocUnsafe(options.chunkBytes ?? SCAN_CHUNK_BYTES);
    for (;;) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      scanner.write(buffer.subarray(0, bytesRead));
    }
    scanner.end();
    return { bytes: scanner.position };
  } finally {
    await handle.close();
  }
}
