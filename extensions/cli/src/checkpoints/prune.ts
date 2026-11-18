import fs from "fs";
import path from "path";

import { isSafeSessionId } from "./model.js";

/**
 * Remove the checkpoints of sessions that no longer exist (deleted, or
 * removed by `continuous clean`). A folder younger than `minAgeMs` is kept,
 * because a new session writes checkpoints before its first save.
 */
export function pruneOrphanedCheckpoints(
  root: string,
  sessionExists: (sessionId: string) => boolean,
  options: { now?: number; minAgeMs?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 24 * 60 * 60 * 1000;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!isSafeSessionId(name) || sessionExists(name)) continue;
    const dir = path.join(root, name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      let mtime = stat.mtimeMs;
      try {
        mtime = Math.max(
          mtime,
          fs.statSync(path.join(dir, "index.json")).mtimeMs,
        );
      } catch {
        // no index: the folder's own time
      }
      if (now - mtime < minAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Not ours to worry about; try again next time.
    }
  }
  return removed;
}
