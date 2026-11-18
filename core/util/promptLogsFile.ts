import type { PromptLog } from "../index.js";
import { withoutPrompt } from "./promptLogs.js";

// Node only (Buffer): promptLogs.ts is also used by the webview.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const COLON = 0x3a;
const PROMPT_LOGS_KEY = Buffer.from('"promptLogs"');

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function skipWhitespace(bytes: Buffer, at: number): number {
  while (at < bytes.length && isWhitespace(bytes[at])) at++;
  return at;
}

/** Whether the quote at `at` is not escaped (an even run of backslashes). */
function isUnescaped(bytes: Buffer, at: number): boolean {
  let slashes = 0;
  for (let i = at - 1; i >= 0 && bytes[i] === BACKSLASH; i--) slashes++;
  return slashes % 2 === 0;
}

/** The index just past the string that opens at `at`, or -1. */
function endOfString(bytes: Buffer, at: number): number {
  let i = at + 1;
  for (;;) {
    const quote = bytes.indexOf(QUOTE, i);
    if (quote < 0) return -1;
    if (isUnescaped(bytes, quote)) return quote + 1;
    i = quote + 1;
  }
}

/** The index just past the array or object that opens at `at`, or -1. */
function endOfContainer(bytes: Buffer, at: number): number {
  let depth = 0;
  let i = at;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === QUOTE) {
      i = endOfString(bytes, i);
      if (i < 0) return -1;
      continue;
    }
    if (byte === OPEN_BRACKET || byte === OPEN_BRACE) depth++;
    else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * The text of a session file with the prompt of every prompt log replaced by
 * the marker, done on the bytes before the session is parsed, so that a file
 * written before prompts were dropped (hundreds of MB, nearly all old
 * prompts) is never held as one string or one object. Only one prompt log
 * array is parsed at a time. JSON's structural characters are ASCII and no
 * byte of a multi-byte UTF-8 character is, so scanning bytes is safe.
 *
 * A file with no prompt logs is returned as it is; a file that cannot be
 * scanned is returned as it is too, for the JSON parser to judge.
 */
export function stripPromptsFromSessionBytes(bytes: Buffer): Buffer {
  let found = bytes.indexOf(PROMPT_LOGS_KEY);
  if (found < 0) return bytes;
  const parts: Buffer[] = [];
  let copied = 0;
  while (found >= 0) {
    const next = found + PROMPT_LOGS_KEY.length;
    // An unescaped quote is a string's delimiter, and only a key is followed
    // by a colon; anything else is text that happens to say "promptLogs".
    const colon = skipWhitespace(bytes, next);
    const start = skipWhitespace(bytes, colon + 1);
    if (
      !isUnescaped(bytes, found) ||
      bytes[colon] !== COLON ||
      bytes[start] !== OPEN_BRACKET
    ) {
      found = bytes.indexOf(PROMPT_LOGS_KEY, next);
      continue;
    }
    const end = endOfContainer(bytes, start);
    if (end < 0) return bytes;
    let logs: unknown;
    try {
      logs = JSON.parse(bytes.subarray(start, end).toString("utf8"));
    } catch {
      return bytes;
    }
    if (Array.isArray(logs)) {
      const stripped = logs.map((log) =>
        log && typeof log === "object" && typeof log.prompt === "string"
          ? withoutPrompt(log as PromptLog)
          : log,
      );
      parts.push(
        bytes.subarray(copied, start),
        Buffer.from(JSON.stringify(stripped), "utf8"),
      );
      copied = end;
    }
    found = bytes.indexOf(PROMPT_LOGS_KEY, end);
  }
  if (copied === 0) return bytes;
  parts.push(bytes.subarray(copied));
  return Buffer.concat(parts);
}
