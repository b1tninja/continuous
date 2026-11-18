/**
 * Turns the files and folders of an operating-system drop into snapshots,
 * within the per-message caps. Separate from `osSnapshot.ts` (which reads one
 * file) so the caps and the folder summary are tested on their own.
 */
import { JSONContent } from "@tiptap/core";
import { DropItem, FileLike } from "./classifyDrop";
import {
  entryFile,
  isSnapshotItem,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_MESSAGE_BYTES,
  ReadableFile,
  readSnapshot,
  Snapshot,
  SnapshotRefusalReason,
  utf8Length,
  walkFolder,
} from "./osSnapshot";
import type { FolderSkip, Refusal, SnapshotFolder } from "./resolveDrop";

export interface SnapshotBudget {
  /** Snapshots already in the message. */
  files: number;
  /** UTF-8 bytes of the snapshots already in the message. */
  bytes: number;
}

/** The snapshots already in an editor document, for the message caps. */
export function snapshotBudgetOf(doc: JSONContent | undefined): SnapshotBudget {
  const budget: SnapshotBudget = { files: 0, bytes: 0 };
  const walk = (node: JSONContent | undefined) => {
    if (!node) return;
    const item = node.attrs?.item;
    if (isSnapshotItem(item)) {
      budget.files++;
      budget.bytes += utf8Length(item.content ?? "");
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return budget;
}

export interface SnapshotDropResult {
  snapshots: Snapshot[];
  /** How many came from loose files (the rest came from folders). */
  fromFiles: number;
  folders: SnapshotFolder[];
  refusals: Refusal[];
  hiddenRemoved: number;
}

const FOLDER_SKIP: Record<SnapshotRefusalReason, FolderSkip> = {
  secret: "secret",
  "secret-content": "secret",
  "snapshot-too-large": "too-large",
  binary: "binary",
  empty: "empty",
  unreadable: "unreadable",
};

/**
 * Read every `os-file` and `os-folder` item of a drop into snapshots, in
 * order, until the message holds `MAX_SNAPSHOT_FILES` snapshots or
 * `MAX_SNAPSHOT_MESSAGE_BYTES` of them.
 */
export async function snapshotDrop<F extends FileLike>(
  items: DropItem<F>[],
  already: SnapshotBudget,
): Promise<SnapshotDropResult> {
  const result: SnapshotDropResult = {
    snapshots: [],
    fromFiles: 0,
    folders: [],
    refusals: [],
    hiddenRemoved: 0,
  };
  let files = already.files;
  let bytes = already.bytes;
  const fits = (s: Snapshot) =>
    files < MAX_SNAPSHOT_FILES && bytes + s.bytes <= MAX_SNAPSHOT_MESSAGE_BYTES;
  const take = (s: Snapshot) => {
    files++;
    bytes += s.bytes;
    result.snapshots.push(s);
    result.hiddenRemoved += s.hiddenRemoved;
  };

  for (const item of items) {
    if (item.kind === "os-file" && item.file) {
      if (files >= MAX_SNAPSHOT_FILES) {
        // Over the count cap nothing is read.
        result.refusals.push({ name: item.name, reason: "snapshot-limit" });
        continue;
      }
      const read = await readSnapshot(
        item.file as unknown as ReadableFile,
        item.name,
      );
      if (!read.ok) {
        result.refusals.push({
          name: item.name,
          reason: read.reason,
          detail: read.detail,
        });
      } else if (!fits(read.snapshot)) {
        result.refusals.push({ name: item.name, reason: "snapshot-total" });
      } else {
        take(read.snapshot);
        result.fromFiles++;
      }
    } else if (item.kind === "os-folder") {
      if (!item.entry?.createReader) {
        result.refusals.push({ name: item.name, reason: "folder-unavailable" });
        continue;
      }
      const walk = await walkFolder(item.entry);
      const folder: SnapshotFolder = {
        name: item.name,
        added: 0,
        skipped: {},
        tooDeep: walk.tooDeep,
        truncated: walk.truncated,
      };
      const skip = (k: FolderSkip, n = 1) => {
        if (n) folder.skipped[k] = (folder.skipped[k] ?? 0) + n;
      };
      skip("ignored-folder", walk.skippedFolders);
      skip("secret", walk.secretNames);
      for (const f of walk.files) {
        if (files >= MAX_SNAPSHOT_FILES) {
          skip("limit");
          continue;
        }
        const file = await entryFile(f.entry);
        if (!file) {
          skip("unreadable");
          continue;
        }
        const read = await readSnapshot(file, f.path);
        if (!read.ok) skip(FOLDER_SKIP[read.reason]);
        else if (!fits(read.snapshot)) skip("limit");
        else {
          take(read.snapshot);
          folder.added++;
        }
      }
      result.folders.push(folder);
      if (!folder.added) {
        result.refusals.push({ name: item.name, reason: "folder-empty" });
      }
    }
  }
  return result;
}
