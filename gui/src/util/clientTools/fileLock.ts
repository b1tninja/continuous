/**
 * One edit at a time per file. A model that sends several edit calls for the
 * same file in one turn had each call read the file, compute its result and
 * open its diff at once, so every call after the first found the document
 * changed under it ("The file changed in the editor while the edit was being
 * applied"). A call takes the file's lock before it reads the file and gives
 * it back once its diff has closed.
 */

const tails = new Map<string, Promise<void>>();

/**
 * Resolves with a release function once every earlier holder of `key` has
 * released. Release is safe to call more than once.
 */
export function acquireFileLock(key: string): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let resolveMine: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    resolveMine = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  const release = () => {
    resolveMine();
    // Drop the entry when nobody queued behind this holder
    if (tails.get(key) === tail) tails.delete(key);
  };
  return previous.then(() => release);
}

/** Polls until `isDone()` or `timeoutMs` passes. Resolves true when done. */
export async function waitUntil(
  isDone: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDone()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return isDone();
}

/** How long a file stays locked for a diff nobody has closed. */
export const FILE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Gives the lock back once the tool call's diff has closed (or after the
 * timeout). Runs in the background: the tool call does not wait for it.
 */
export function releaseWhenClosed(
  release: () => void,
  isClosed: () => boolean,
  timeoutMs = FILE_LOCK_TIMEOUT_MS,
): void {
  void waitUntil(isClosed, timeoutMs)
    .catch(() => false)
    .finally(release);
}
