/**
 * Large strings of a saved session stored once, by content (STOR7).
 *
 * A string of BLOB_THRESHOLD_CHARS or more anywhere in a history item (a
 * tool output, an image's data URL, an editor document's copy of the same
 * image) is written to `sessions/<id>/blobs/<sha256>` and replaced in the
 * session log by `{"$blob": "<sha256>", "n": <length>}`. The same bytes twice
 * are one file.
 *
 * A tool message repeats its tool call's output: its content is
 * `renderContextItems(toolCallState.output)` (gui
 * streamResponseAfterToolCall.ts). When the content matches the output
 * already encoded on the assistant item, it is stored as
 * `{"$join": [<parts>], "sep": "\n\n"}`, built from the same parts, so the
 * output is stored once and the tool message stays self-contained (it does
 * not depend on the assistant item being kept).
 *
 * An object of the session's own that happens to have a `$blob`, `$join` or
 * `$esc` key is wrapped as `{"$esc": {...}}`, so reading never mistakes it
 * for a reference.
 *
 * Node only.
 */
import { createHash } from "node:crypto";

/**
 * Strings at least this long (UTF-16 code units, about bytes for ASCII) are
 * stored as blobs. STOR6/STOR7 suggest 16 KB: below it a file per string
 * costs more than it saves.
 */
export const BLOB_THRESHOLD_CHARS = 16 * 1024;

/**
 * Tool outputs are stored as blobs from this size: an output is kept twice
 * on every tool call (the call's state and the tool message), and a blob is
 * what lets both refer to one copy. Below it, both keep their own (at most
 * twice this per call).
 */
export const TOOL_OUTPUT_BLOB_CHARS = 4 * 1024;

/** The separator `renderContextItems` joins tool outputs with. */
const TOOL_OUTPUT_SEP = "\n\n";

export interface BlobRef {
  $blob: string;
  n: number;
}

type Encoded = unknown;

/** Where encoded blobs go. `put` is called once per new hash in a session. */
export interface BlobSink {
  /** True when the blob is already stored (or queued) for this session. */
  has(hash: string): boolean;
  put(hash: string, text: string): void;
}

/** What `encodeItem` remembers between items of one session. */
export interface EncodeContext {
  sink: BlobSink;
  /**
   * Tool call id to the hash of its rendered output and the encoded parts,
   * filled when an item with tool call states is encoded and read when the
   * tool message for that call is.
   */
  toolOutputs: Map<string, { hash: string; parts: Encoded[] }>;
  threshold?: number;
  toolOutputThreshold?: number;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const SPECIAL_KEYS = ["$blob", "$join", "$esc"];

function hasSpecialKey(obj: object): boolean {
  return SPECIAL_KEYS.some((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function encodeString(
  text: string,
  ctx: EncodeContext,
  threshold = ctx.threshold ?? BLOB_THRESHOLD_CHARS,
): Encoded {
  if (text.length < threshold) return text;
  const hash = sha256(text);
  if (!ctx.sink.has(hash)) ctx.sink.put(hash, text);
  const ref: BlobRef = { $blob: hash, n: text.length };
  return ref;
}

function encodeValue(value: unknown, ctx: EncodeContext): Encoded {
  if (typeof value === "string") return encodeString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => encodeValue(v, ctx));
  if (value && typeof (value as any).toJSON === "function") {
    // As JSON.stringify would write it (a Date as its ISO string)
    return encodeValue((value as any).toJSON(), ctx);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = encodeValue(v, ctx);
    }
    return hasSpecialKey(value) ? { $esc: out } : out;
  }
  return value;
}

/** An encoded object, unwrapped if it was escaped. */
function unwrap(encoded: any): any {
  return encoded && typeof encoded === "object" && "$esc" in encoded
    ? encoded.$esc
    : encoded;
}

function toolThreshold(ctx: EncodeContext): number {
  return ctx.toolOutputThreshold ?? TOOL_OUTPUT_BLOB_CHARS;
}

function outputContents(state: any): string[] | undefined {
  const output = state?.output;
  if (!state?.toolCallId || !Array.isArray(output) || !output.length) {
    return undefined;
  }
  return output.map((o: any) =>
    typeof o?.content === "string" ? o.content : "",
  );
}

/**
 * Notes the rendered output of each finished tool call on `item`, so the
 * tool message that repeats it is stored as a join of the same parts.
 */
export function rememberToolOutputs(item: any, ctx: EncodeContext): void {
  const states = item?.toolCallStates;
  if (!Array.isArray(states)) return;
  for (const state of states) {
    const contents = outputContents(state);
    if (!contents) continue;
    const rendered = contents.join(TOOL_OUTPUT_SEP);
    if (rendered.length < toolThreshold(ctx)) continue;
    ctx.toolOutputs.set(state.toolCallId, {
      hash: sha256(rendered),
      parts: contents.map((c) => encodeString(c, ctx, toolThreshold(ctx))),
    });
  }
}

/**
 * The item as written to the session log: large strings replaced by blob
 * references (tool outputs from a lower size), a tool message that repeats
 * its call's output replaced by a join of that output's parts. Does not
 * change `item`.
 */
export function encodeItem(item: unknown, ctx: EncodeContext): Encoded {
  rememberToolOutputs(item, ctx);
  const src = item as any;
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return encodeValue(item, ctx);
  }
  // Fields encoded on their own are blanked in the shell and patched in after
  const shell: any = { ...src };
  const patches: ((encoded: any) => void)[] = [];

  if (Array.isArray(src.toolCallStates)) {
    shell.toolCallStates = src.toolCallStates.map((state: any, i: number) => {
      if (!outputContents(state)) return state;
      return {
        ...state,
        output: state.output.map((o: any, j: number) => {
          if (typeof o?.content !== "string") return o;
          patches.push((encoded) => {
            const target = unwrap(
              unwrap(unwrap(encoded).toolCallStates[i]).output[j],
            );
            target.content = encodeString(o.content, ctx, toolThreshold(ctx));
          });
          return { ...o, content: "" };
        }),
      };
    });
  }

  const message = src.message;
  if (
    message?.role === "tool" &&
    typeof message.content === "string" &&
    typeof message.toolCallId === "string"
  ) {
    const known = ctx.toolOutputs.get(message.toolCallId);
    if (known && sha256(message.content) === known.hash) {
      // The rendered text is not stored: the parts already are
      shell.message = { ...message, content: "" };
      patches.push((encoded) => {
        unwrap(unwrap(encoded).message).content = {
          $join: known.parts,
          sep: TOOL_OUTPUT_SEP,
        };
      });
    }
  }

  const encoded = encodeValue(shell, ctx);
  for (const patch of patches) patch(encoded);
  return encoded;
}

/** Blob hashes an encoded value refers to. */
export function blobRefs(
  value: unknown,
  into = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) blobRefs(v, into);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$blob === "string") into.add(obj.$blob);
    else for (const v of Object.values(obj)) blobRefs(v, into);
  }
  return into;
}

/** Reads a blob's text, or undefined when it is not stored. */
export type BlobSource = (hash: string) => string | undefined;

export interface DecodeStats {
  /** Hashes referred to that could not be read. */
  missing: Set<string>;
}

function decodeValue(
  value: unknown,
  read: BlobSource,
  stats: DecodeStats,
): unknown {
  if (Array.isArray(value))
    return value.map((v) => decodeValue(v, read, stats));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.$blob === "string") {
    const text = read(obj.$blob);
    if (text !== undefined) return text;
    stats.missing.add(obj.$blob);
    return `[stored content ${obj.$blob.slice(0, 12)} is missing]`;
  }
  if (Array.isArray(obj.$join)) {
    return obj.$join
      .map((p) => decodeValue(p, read, stats))
      .join(typeof obj.sep === "string" ? obj.sep : TOOL_OUTPUT_SEP);
  }
  const inner =
    obj.$esc && typeof obj.$esc === "object" && !Array.isArray(obj.$esc)
      ? (obj.$esc as Record<string, unknown>)
      : obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inner)) {
    out[k] = decodeValue(v, read, stats);
  }
  return out;
}

/**
 * The item as it was saved, with blob references read through `read`. A
 * blob that cannot be read becomes a one-line marker and is counted in
 * `stats.missing`; the rest of the item is kept.
 */
export function decodeItem<T = unknown>(
  encoded: unknown,
  read: BlobSource,
  stats: DecodeStats = { missing: new Set() },
): T {
  return decodeValue(encoded, read, stats) as T;
}
