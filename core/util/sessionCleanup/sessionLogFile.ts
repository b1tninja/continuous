/**
 * Clean up old sessions for sessions saved as an append-only log (#869):
 * `sessions/<id>.jsonl` with large strings stored once in
 * `sessions/<id>/blobs/<sha256>`.
 *
 * A log holds no full prompts (its writer drops them), so what a cleanup can
 * reclaim from it is blobs: an output whose item was edited, cut or
 * compacted away stays in the blob folder until the session is deleted. A
 * blob is stale only when the session, read the way a load reads it, does
 * not refer to it. A blob the session refers to is never touched.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { blobRefs } from "../sessionBlobs.js";
import { replaySessionLog, type ReplayResult } from "../sessionLog.js";

const CHUNK_BYTES = 1 << 20;
/** A blob's name: the sha256 of its text. */
const BLOB_NAME_RE = /^[0-9a-f]{64}$/;

export interface SessionLogRefs {
  sessionId: string;
  /** Blob hashes the session refers to, in its items and its fields. */
  referenced: Set<string>;
  /** Lines in the middle that did not parse: what they referred to is unknown. */
  badLines: number;
}

/**
 * Replays a `.jsonl` session in 1 MiB pieces and collects the blobs it
 * refers to. Items are kept as stored (references, not text), so memory
 * follows the log's live size, not its blobs. Throws when the file is not a
 * session log.
 */
export async function scanSessionLogRefs(
  file: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionLogRefs> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let replay: ReplayResult | undefined;
  const feed = (text: string) => {
    const r = replaySessionLog(text, replay);
    if ("reason" in r) throw new Error(r.reason);
    replay = r;
  };
  const stream = fs.createReadStream(file, { highWaterMark: CHUNK_BYTES });
  for await (const chunk of stream) {
    options.signal?.throwIfAborted();
    pending += decoder.write(chunk as Buffer);
    const nl = pending.lastIndexOf("\n");
    if (nl === -1) continue;
    feed(pending.slice(0, nl + 1));
    pending = pending.slice(nl + 1);
  }
  pending += decoder.end();
  // A cut-off last line is ignored, as a load ignores it
  if (pending || !replay) feed(pending);
  const r = replay!;
  const referenced = new Set<string>();
  for (const item of r.items) blobRefs(item, referenced);
  for (const value of r.meta.values()) blobRefs(value, referenced);
  return { sessionId: r.sessionId, referenced, badLines: r.badLines };
}

export interface StaleBlob {
  file: string;
  bytes: number;
  mtimeMs: number;
}

export interface BlobFolderScan {
  /** Every file in the folder. */
  totalBytes: number;
  stale: StaleBlob[];
  staleBytes: number;
}

/**
 * The files of a blob folder the session does not refer to. Files written
 * since `newerThan` are left out: a blob is written before the line that
 * refers to it, so a recent one may be about to be used. Leftover temporary
 * files of a write that did not finish count as stale.
 */
export async function scanBlobFolder(
  dir: string,
  referenced: ReadonlySet<string>,
  newerThan: number,
): Promise<BlobFolderScan> {
  const out: BlobFolderScan = { totalBytes: 0, stale: [], staleBytes: 0 };
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.totalBytes += st.size;
    const isBlob = BLOB_NAME_RE.test(name);
    const isTemp = name.endsWith(".tmp");
    if (!isBlob && !isTemp) continue; // not ours: left alone
    if (isBlob && referenced.has(name)) continue;
    if (st.mtimeMs >= newerThan) continue;
    out.stale.push({ file, bytes: st.size, mtimeMs: st.mtimeMs });
    out.staleBytes += st.size;
  }
  return out;
}

/** `sessions/<id>/blobs` of a session file, `.json` or `.jsonl`. */
export function blobFolderOf(sessionFile: string): string {
  const id = path.basename(sessionFile).replace(/\.jsonl?$/, "");
  return path.join(path.dirname(sessionFile), id, "blobs");
}
