/**
 * Files dropped from the operating system's file manager arrive as `File`
 * objects with a name and bytes but no path, so they cannot become `@file`
 * chips. A text file becomes a snapshot instead: its content, read once on
 * drop, decoded, cleaned of hidden characters, checked for secrets and
 * attached as an inline context item labelled with the file name. It is not
 * kept in sync with the file.
 *
 * Every check that can run without reading the file runs first: the name
 * against the security patterns, then the size. Content is read only after
 * both pass, and nothing read is attached when the secret scan finds
 * anything.
 */
import { ContextItemWithId } from "core";
import { securityPatternHit } from "core/indexing/securityPatterns";
import { scanText } from "core/util/secretScan/scan";
import { sanitizeDroppedText } from "./sanitizeDroppedText";

/** Largest file read for a snapshot. Checked before reading. */
export const MAX_SNAPSHOT_FILE_BYTES = 200 * 1024;
/** Most snapshot text one message can hold, counting earlier drops. */
export const MAX_SNAPSHOT_MESSAGE_BYTES = 1024 * 1024;
/** Most snapshots one message can hold, counting earlier drops. */
export const MAX_SNAPSHOT_FILES = 20;
/** Folder levels below a dropped folder that are opened (its files are level 1). */
export const MAX_FOLDER_DEPTH = 2;
/** Entries a folder walk looks at before it stops, files and folders alike. */
export const MAX_FOLDER_ENTRIES = 200;
/** Folders a folder walk never opens. */
export const SKIPPED_FOLDER_NAMES = ["node_modules", ".git", "dist"];
/**
 * Invalid UTF-8 tolerated before a file counts as binary: one bad sequence,
 * or 1% of the characters in a longer file.
 */
export const INVALID_UTF8_RATIO = 0.01;

/** The context provider title that marks a snapshot item. */
export const SNAPSHOT_PROVIDER = "dropped-file";
export const SNAPSHOT_DESCRIPTION = "snapshot — not kept in sync";

export type SnapshotRefusalReason =
  | "secret"
  | "secret-content"
  | "snapshot-too-large"
  | "binary"
  | "empty"
  | "unreadable";

export interface ReadableFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export type Decoded =
  | { ok: true; text: string; encoding: "utf-8" | "utf-16le" | "utf-16be" }
  | { ok: false };

function countReplacements(text: string): number {
  let n = 0;
  for (let i = text.indexOf("�"); i !== -1; i = text.indexOf("�", i + 1)) {
    n++;
  }
  return n;
}

function tooManyInvalid(text: string): boolean {
  const invalid = countReplacements(text);
  return invalid > Math.max(1, Math.floor(text.length * INVALID_UTF8_RATIO));
}

/**
 * Decode a file's bytes as text, or say it is binary. A UTF-16 file needs its
 * byte order mark; without one the bytes are read as UTF-8 (a UTF-8 BOM is
 * dropped). A NUL, or more invalid sequences than `INVALID_UTF8_RATIO`
 * allows, makes the file binary.
 */
export function decodeText(bytes: Uint8Array): Decoded {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), "utf-16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Swap to little-endian: `utf-16be` is not in every TextDecoder.
    const body = bytes.subarray(2);
    const swapped = new Uint8Array(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    if (body.length % 2) swapped[body.length - 1] = body[body.length - 1];
    return decodeUtf16(swapped, "utf-16be");
  }
  let start = 0;
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    start = 3;
  }
  const body = bytes.subarray(start);
  if (body.includes(0)) return { ok: false };
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
  if (tooManyInvalid(text)) return { ok: false };
  return { ok: true, text, encoding: "utf-8" };
}

function decodeUtf16(
  body: Uint8Array,
  encoding: "utf-16le" | "utf-16be",
): Decoded {
  const text = new TextDecoder("utf-16le", { ignoreBOM: true }).decode(body);
  if (text.includes("\u0000") || tooManyInvalid(text)) return { ok: false };
  return { ok: true, text, encoding };
}

/**
 * True when a name or a path inside a dropped folder matches the security
 * patterns (`.env*`, `*.pem`, `*.key`, `id_rsa`, `.ssh/` and the rest).
 */
export function isSecretName(path: string): boolean {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = clean.split("/").filter(Boolean);
  const candidates = [clean, segments[segments.length - 1] ?? ""].filter(
    Boolean,
  );
  return candidates.some(
    (p) => securityPatternHit(p) || securityPatternHit(`${p}/`),
  );
}

/**
 * The kinds of secret the shared scanner finds in `text` (the at-rest rule
 * set, without its low-confidence entropy rule). Kinds only: never values.
 */
export function secretKindsIn(text: string, name: string): string[] {
  const findings = scanText(text, "at-rest", { path: name, allowMarker: "" });
  const kinds = new Set<string>();
  for (const f of findings) {
    if (f.confidence !== "low") kinds.add(f.kind);
  }
  return [...kinds];
}

async function readBytes(file: ReadableFile): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  if (typeof FileReader !== "undefined" && file instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }
  throw new Error("not readable");
}

export interface Snapshot {
  /** The label: the file name, or its path inside a dropped folder. */
  name: string;
  text: string;
  /** UTF-8 length of `text`, the measure the message cap uses. */
  bytes: number;
  hiddenRemoved: number;
}

/** A label safe to show and to put in a fence's info string: one line, no hidden characters. */
export function displayName(label: string): string {
  return sanitizeDroppedText(label)
    .text.replace(/[\r\n\t`]+/g, " ")
    .trim();
}

export type SnapshotResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: SnapshotRefusalReason; detail?: string };

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Read one dropped file as a snapshot, or say why not. `label` is the name
 * shown on the chip (a path inside a dropped folder, or the file name).
 */
export async function readSnapshot(
  file: ReadableFile,
  label = file.name,
): Promise<SnapshotResult> {
  if (isSecretName(label)) return { ok: false, reason: "secret" };
  if (file.size > MAX_SNAPSHOT_FILE_BYTES) {
    return { ok: false, reason: "snapshot-too-large" };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // The size a File reports can be stale; the bytes are what counts.
  if (bytes.length > MAX_SNAPSHOT_FILE_BYTES) {
    return { ok: false, reason: "snapshot-too-large" };
  }
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  const decoded = decodeText(bytes);
  if (!decoded.ok) return { ok: false, reason: "binary" };
  const clean = sanitizeDroppedText(decoded.text);
  if (!clean.text.trim()) return { ok: false, reason: "empty" };
  // Scan what would be sent: after hidden characters are gone, so one placed
  // inside a key does not hide it.
  const kinds = secretKindsIn(clean.text, label);
  if (kinds.length) {
    return { ok: false, reason: "secret-content", detail: kinds.join(", ") };
  }
  return {
    ok: true,
    snapshot: {
      name: displayName(label),
      text: clean.text,
      bytes: utf8Length(clean.text),
      hiddenRemoved: clean.removed,
    },
  };
}

let snapshotCounter = 0;

/** The inline context item a snapshot chip holds. No URI: none is known. */
export function snapshotContextItem(snapshot: Snapshot): ContextItemWithId {
  snapshotCounter++;
  return {
    id: {
      providerTitle: SNAPSHOT_PROVIDER,
      itemId: `dropped-${Date.now().toString(36)}-${snapshotCounter}`,
    },
    name: snapshot.name,
    description: SNAPSHOT_DESCRIPTION,
    content: snapshot.text,
  };
}

export function isSnapshotItem(item: unknown): boolean {
  return (
    !!item &&
    typeof item === "object" &&
    (item as ContextItemWithId).id?.providerTitle === SNAPSHOT_PROVIDER
  );
}

/** A `FileSystemEntry` as Chromium hands it out from `webkitGetAsEntry()`. */
export interface EntryLike {
  name: string;
  fullPath?: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (
    success: (file: ReadableFile) => void,
    error?: (err: unknown) => void,
  ) => void;
  createReader?: () => {
    readEntries(
      success: (entries: EntryLike[]) => void,
      error?: (err: unknown) => void,
    ): void;
  };
}

export interface FolderFile {
  /** Path from the dropped folder, starting with its name: `notes/a/b.md`. */
  path: string;
  entry: EntryLike;
}

export interface FolderWalk {
  files: FolderFile[];
  /** Folders not opened: `node_modules`, `.git`, `dist` or a secret pattern. */
  skippedFolders: number;
  /** Files refused by name before anything read them. */
  secretNames: number;
  /** True when a folder deeper than `MAX_FOLDER_DEPTH` was left closed. */
  tooDeep: boolean;
  /** True when the walk stopped at `MAX_FOLDER_ENTRIES`. */
  truncated: boolean;
}

function readAllEntries(dir: EntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader?.();
  if (!reader) return Promise.resolve([]);
  const out: EntryLike[] = [];
  return new Promise((resolve) => {
    const next = () => {
      reader.readEntries(
        (batch) => {
          // Chromium returns at most 100 entries per call; an empty batch
          // ends the listing.
          if (!batch.length || out.length > MAX_FOLDER_ENTRIES) {
            resolve(out);
            return;
          }
          out.push(...batch);
          next();
        },
        () => resolve(out),
      );
    };
    next();
  });
}

/**
 * List the files under a dropped folder, bounded: at most `MAX_FOLDER_DEPTH`
 * levels and `MAX_FOLDER_ENTRIES` entries, never opening `node_modules`,
 * `.git`, `dist` or a folder that matches the security patterns, and leaving
 * out files whose path matches them. Nothing is read here.
 */
export async function walkFolder(root: EntryLike): Promise<FolderWalk> {
  const walk: FolderWalk = {
    files: [],
    skippedFolders: 0,
    secretNames: 0,
    tooDeep: false,
    truncated: false,
  };
  let seen = 0;
  const visit = async (dir: EntryLike, path: string, depth: number) => {
    const entries = (await readAllEntries(dir)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (seen >= MAX_FOLDER_ENTRIES) {
        walk.truncated = true;
        return;
      }
      seen++;
      const childPath = `${path}/${entry.name}`;
      if (entry.isDirectory) {
        if (
          SKIPPED_FOLDER_NAMES.includes(entry.name) ||
          isSecretName(`${childPath}/`)
        ) {
          walk.skippedFolders++;
        } else if (depth + 1 >= MAX_FOLDER_DEPTH) {
          walk.tooDeep = true;
        } else {
          await visit(entry, childPath, depth + 1);
        }
      } else if (entry.isFile) {
        if (isSecretName(childPath)) walk.secretNames++;
        else walk.files.push({ path: childPath, entry });
      }
    }
  };
  await visit(root, root.name, 0);
  return walk;
}

/** The `File` behind a file entry, or undefined when it cannot be opened. */
export function entryFile(entry: EntryLike): Promise<ReadableFile | undefined> {
  return new Promise((resolve) => {
    if (!entry.file) {
      resolve(undefined);
      return;
    }
    try {
      entry.file(
        (file) => resolve(file),
        () => resolve(undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
}
