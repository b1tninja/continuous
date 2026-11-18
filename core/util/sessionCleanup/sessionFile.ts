/**
 * Old prompt logs in one session file: find them without loading the file
 * (`scanSessionFile`), write a copy without them (`writeWithEdits`), and
 * check the copy holds the same conversation (`verifySessionCopy`).
 *
 * Every model request used to keep its full prompt on the history item that
 * answered it (`promptLogs[].prompt`), so a session grew with the square of
 * its length. A session file now keeps no prompt (`../promptLogs.ts`): the
 * newest one lives in memory for the feedback buttons, and loading replaces
 * every stored prompt with the marker. So a cleaned file holds what the
 * product would write: each prompt replaced by `DROPPED_PROMPT_MARKER`, the
 * rest of each log (model, completion) as it was.
 */
import { open, readFile } from "node:fs/promises";

import { DROPPED_PROMPT_MARKER } from "../promptLogs.js";
import {
  scanJsonFile,
  SCAN_CHUNK_BYTES,
  type JsonPathPart,
} from "./jsonStreamScan.js";

export { DROPPED_PROMPT_MARKER };
const MARKER_JSON = JSON.stringify(DROPPED_PROMPT_MARKER);
const MARKER_BYTES = Buffer.byteLength(MARKER_JSON);

/** Replace the bytes `[start, end)` of the file with `text`. */
export interface ByteEdit {
  start: number;
  end: number;
  text: string;
}

export interface SessionFileScan {
  file: string;
  /** Bytes scanned (the file's size at scan time). */
  bytes: number;
  sessionId?: string;
  /** Number of history items. */
  items: number;
  /** `message.id` of each history item, in order ("" where there is none). */
  messageIds: string[];
  /** Prompt logs in the file, kept or not. */
  promptLogs: number;
  /** Prompt logs whose prompt is still stored in full. */
  fullPrompts: number;
  /** Bytes the edits remove. */
  reclaimableBytes: number;
  edits: ByteEdit[];
}

interface PromptSpan {
  start: number;
  end: number;
  dropped: boolean;
}

function isHistoryItemPath(path: readonly JsonPathPart[]): boolean {
  return (
    path.length === 2 && path[0] === "history" && typeof path[1] === "number"
  );
}

/**
 * Reads the file once, in chunks, and plans its edits. Throws `JsonScanError`
 * for a file that is not one JSON value.
 */
export async function scanSessionFile(
  file: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionFileScan> {
  const messageIds: string[] = [];
  const prompts: PromptSpan[] = [];
  let sessionId: string | undefined;
  let promptLogs = 0;
  let rootIsObject = false;

  const { bytes } = await scanJsonFile(
    file,
    {
      open(path, kind) {
        if (path.length === 0) rootIsObject = kind === "object";
        else if (kind === "object" && isHistoryItemPath(path)) {
          messageIds.push("");
        } else if (
          kind === "object" &&
          path.length === 4 &&
          path[0] === "history" &&
          path[2] === "promptLogs" &&
          typeof path[3] === "number"
        ) {
          promptLogs++;
        }
      },
      scalar(path, kind, start, end, text) {
        if (path.length === 1 && path[0] === "sessionId" && kind === "string") {
          sessionId = text;
          return;
        }
        if (path[0] !== "history" || typeof path[1] !== "number") return;
        if (
          path.length === 4 &&
          path[2] === "message" &&
          path[3] === "id" &&
          kind === "string"
        ) {
          messageIds[messageIds.length - 1] = text ?? "";
        } else if (
          path.length === 5 &&
          path[2] === "promptLogs" &&
          typeof path[3] === "number" &&
          path[4] === "prompt" &&
          kind === "string"
        ) {
          prompts.push({
            start,
            end,
            dropped: text === DROPPED_PROMPT_MARKER,
          });
        }
      },
    },
    { signal: options.signal },
  );
  if (!rootIsObject) {
    throw new Error("the file does not hold a session");
  }

  const edits: ByteEdit[] = [];
  let reclaimableBytes = 0;
  let fullPrompts = 0;
  for (const p of prompts) {
    if (p.dropped) continue;
    fullPrompts++;
    edits.push({ start: p.start, end: p.end, text: MARKER_JSON });
    reclaimableBytes += Math.max(0, p.end - p.start - MARKER_BYTES);
  }
  return {
    file,
    bytes,
    sessionId,
    items: messageIds.length,
    messageIds,
    promptLogs,
    fullPrompts,
    reclaimableBytes,
    edits,
  };
}

/**
 * Copies `source` to `target` with `edits` applied (sorted, not overlapping),
 * in chunks. The target is created owner-only and must not exist.
 */
export async function writeWithEdits(
  source: string,
  target: string,
  edits: readonly ByteEdit[],
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  const input = await open(source, "r");
  try {
    const output = await open(target, "wx", 0o600);
    let written = 0;
    try {
      const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
      let position = 0;
      const copyUntil = async (end: number) => {
        while (position < end) {
          options.signal?.throwIfAborted();
          const want = Math.min(buffer.length, end - position);
          const { bytesRead } = await input.read(buffer, 0, want, position);
          if (bytesRead === 0) {
            throw new Error("the session file got shorter while it was copied");
          }
          await output.write(buffer, 0, bytesRead);
          position += bytesRead;
          written += bytesRead;
        }
      };
      for (const edit of edits) {
        if (edit.start < position) throw new Error("overlapping edits");
        await copyUntil(edit.start);
        const text = Buffer.from(edit.text, "utf8");
        await output.write(text);
        written += text.length;
        position = edit.end;
      }
      const { size } = await input.stat();
      await copyUntil(size);
      await output.sync();
    } finally {
      await output.close();
    }
    return written;
  } finally {
    await input.close();
  }
}

/** Below this size the copy is also checked with `JSON.parse`. */
const PARSE_CHECK_BYTES = 64 * 1024 * 1024;

/**
 * Throws unless `copy` is valid JSON holding the same session as `original`
 * describes: the same id, the same number of items and the same message ids
 * in order, the same number of prompt logs, and no prompt in full.
 */
export async function verifySessionCopy(
  original: SessionFileScan,
  copy: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionFileScan> {
  const after = await scanSessionFile(copy, options);
  const problems: string[] = [];
  if (after.sessionId !== original.sessionId) problems.push("session id");
  if (after.items !== original.items) problems.push("item count");
  if (
    after.messageIds.length !== original.messageIds.length ||
    after.messageIds.some((id, i) => id !== original.messageIds[i])
  ) {
    problems.push("message ids");
  }
  if (after.promptLogs !== original.promptLogs)
    problems.push("prompt log count");
  if (after.fullPrompts > 0) problems.push("prompts still in full");
  if (after.bytes <= PARSE_CHECK_BYTES) {
    try {
      JSON.parse(await readFile(copy, "utf8"));
    } catch {
      problems.push("JSON.parse");
    }
  }
  if (problems.length) {
    throw new Error(`the cleaned copy differs: ${problems.join(", ")}`);
  }
  return after;
}
