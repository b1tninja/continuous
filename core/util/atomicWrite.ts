import fs from "node:fs";
import path from "node:path";

export interface AtomicWriteOptions {
  /**
   * Permission bits for the written file. Default: the bits of the file being
   * replaced, or the process default for a new file.
   */
  mode?: number;
  /**
   * What to do when the rename is refused (Windows: the destination is open
   * in another program) or the temp file cannot be created (a directory that
   * is not writable while the file is, or a file name already at the length
   * limit, which the temp name would exceed). `true` (the default) writes the
   * destination in place, because losing the edit is worse than a write that
   * is not atomic. `false` throws and leaves the destination untouched.
   */
  fallbackInPlace?: boolean;
}

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Failures after which an in-place write can still succeed. */
const IN_PLACE_CODES = new Set([...RETRY_CODES, "ENAMETOOLONG"]);
const RENAME_ATTEMPTS = 5;
const RENAME_FIRST_WAIT_MS = 10;

let counter = 0;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Rename, retrying on Windows where a destination that an editor, indexer or
 * virus scanner has open for a moment answers EPERM, EBUSY or EACCES.
 */
function renameWithRetry(from: string, to: string): void {
  let wait = RENAME_FIRST_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const retry =
        process.platform === "win32" &&
        RETRY_CODES.has(errorCode(error) ?? "") &&
        attempt < RENAME_ATTEMPTS;
      if (!retry) throw error;
      sleepSync(wait);
      wait *= 2;
    }
  }
}

/**
 * Replaces `file` with `data` by writing a temp file beside it, flushing it
 * and renaming it over the destination. A crash, a kill or a full disk during
 * the write leaves the previous file complete; readers never see half a file.
 *
 * - The bytes are written as given: line endings and a byte order mark are
 *   the caller's.
 * - The permission bits of the file being replaced are kept (or `mode`).
 *   Owner and group are those of the writing process, and a hard link to the
 *   old file keeps the old contents.
 * - A symbolic link is written through to its target, so the link survives.
 * - A destination the process may not write is refused as an in-place write
 *   would be: a rename alone would have replaced a read-only file.
 * - On Windows the rename is retried for a moment; see `fallbackInPlace` for
 *   what happens when it still fails.
 *
 * This does not guard against two processes replacing the same file: the
 * last rename wins.
 */
export function writeFileAtomicSync(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // Does not exist yet: write the path as given.
  }

  let mode = options.mode;
  try {
    const existing = fs.statSync(target);
    fs.accessSync(target, fs.constants.W_OK);
    mode ??= existing.mode & 0o777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const fallbackInPlace = options.fallbackInPlace ?? true;
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${counter++}.tmp`,
  );
  try {
    const fd = fs.openSync(tmp, "wx", mode ?? 0o666);
    try {
      fs.writeFileSync(fd, data);
      try {
        fs.fsyncSync(fd);
      } catch {
        // Some file systems (network shares) have no fsync; the rename
        // still replaces the file in one step.
      }
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined && process.platform !== "win32") {
      // open() applies the umask; the replaced file's bits are kept exactly.
      fs.chmodSync(tmp, mode);
    }
    renameWithRetry(tmp, target);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    if (!fallbackInPlace || !IN_PLACE_CODES.has(errorCode(error) ?? "")) {
      throw error;
    }
    fs.writeFileSync(target, data, mode === undefined ? {} : { mode });
    if (options.mode !== undefined && process.platform !== "win32") {
      fs.chmodSync(target, options.mode);
    }
  }
}
