import { DataTransferLike, FileLike } from "./classifyDrop";
import { EntryLike, ReadableFile } from "./osSnapshot";

/**
 * Fixture drags shaped like what VS Code and Chromium put on a drag
 * (microsoft/vscode `src/vs/workbench/browser/dnd.ts`, `fillEditorsDragData`).
 * Type names are lowercased the way Chromium reports custom types.
 */
export function fakeDataTransfer(
  data: Record<string, string>,
  files: FileLike[] = [],
): DataTransferLike & { files: FileLike[] } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) lower[k.toLowerCase()] = v;
  const types = Object.keys(lower);
  if (files.length && !types.includes("Files")) types.push("Files");
  return {
    types,
    getData: (format: string) => lower[format.toLowerCase()] ?? "",
    files,
  };
}

export const WS = "file:///Users/user/workspace1";

/** An Explorer drag of two files and one folder. */
export function explorerDrag(
  files: string[],
  folders: string[] = [],
): DataTransferLike & { files: FileLike[] } {
  const all = [...folders, ...files];
  return fakeDataTransfer({
    "text/plain": all.map((u) => u.replace(`${WS}/`, "")).join("\r\n"),
    ...(files.length ? { ResourceURLs: JSON.stringify(files) } : {}),
    ...(files.length
      ? {
          CodeEditors: JSON.stringify(
            files.map((f) => ({
              resource: {
                $mid: 1,
                scheme: "file",
                path: f.replace("file://", ""),
                external: f,
              },
            })),
          ),
        }
      : {}),
    ...(files.length
      ? {
          DownloadURL: `application/octet-stream:${files[0].split("/").pop()}:${files[0]}`,
        }
      : {}),
    "text/uri-list": all[0] ?? "",
    "application/vnd.code.uri-list": all.join("\r\n"),
  });
}

/** An editor tab drag: no ResourceURLs, CodeEditors plus the URI lists. */
export function editorTabDrag(
  uri: string,
): DataTransferLike & { files: FileLike[] } {
  return fakeDataTransfer({
    "text/plain": uri.replace(`${WS}/`, ""),
    CodeEditors: JSON.stringify([
      { resource: { $mid: 1, scheme: "file", external: uri } },
    ]),
    "text/uri-list": uri,
    "application/vnd.code.uri-list": uri,
  });
}

export function osFileDrag(
  ...files: FileLike[]
): DataTransferLike & { files: FileLike[] } {
  return fakeDataTransfer({}, files);
}

export function textDrag(text: string): DataTransferLike & {
  files: FileLike[];
} {
  return fakeDataTransfer({
    "text/plain": text,
    "text/html": `<b>${text}</b>`,
  });
}

export function fakeFile(name: string, type: string, size = 1000): FileLike {
  return { name, type, size };
}

/** A dropped file with bytes, as `File.arrayBuffer()` returns them. */
export function textFile(
  name: string,
  content: string | Uint8Array,
  type = "text/plain",
): ReadableFile & { reads: number } {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const file = {
    name,
    type,
    size: bytes.length,
    reads: 0,
    async arrayBuffer() {
      file.reads++;
      return bytes.slice().buffer as ArrayBuffer;
    },
  };
  return file;
}

/** A file entry, as `webkitGetAsEntry()` returns one. */
export function fakeFileEntry(name: string, file?: ReadableFile): EntryLike {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success, error) {
      if (file) success(file);
      else error?.(new Error("NotFoundError"));
    },
  };
}

/**
 * A folder entry. `children` is either a list of entries, or a map from name
 * to file content (a string) or to a nested map (a folder). `readEntries`
 * hands out at most 100 entries per call, as Chromium does.
 */
export function fakeDirEntry(
  name: string,
  children: EntryLike[] | FolderSpec,
): EntryLike {
  const entries = Array.isArray(children)
    ? children
    : Object.entries(children).map(([n, v]) =>
        typeof v === "string" || v instanceof Uint8Array
          ? fakeFileEntry(n, textFile(n, v))
          : fakeDirEntry(n, v),
      );
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let at = 0;
      return {
        readEntries(success) {
          const batch = entries.slice(at, at + 100);
          at += batch.length;
          setTimeout(() => success(batch), 0);
        },
      };
    },
  };
}

export interface FolderSpec {
  [name: string]: string | Uint8Array | FolderSpec;
}

/**
 * An OS drag whose `items` carry entries, paired with `files` in order. An
 * undefined entry stands for a host without `webkitGetAsEntry`.
 */
export function osEntryDrag(
  pairs: [FileLike, EntryLike | undefined][],
): DataTransferLike & { files: FileLike[] } {
  const dt = fakeDataTransfer(
    {},
    pairs.map(([f]) => f),
  );
  return {
    ...dt,
    items: pairs.map(([, entry]) =>
      entry
        ? { kind: "file", webkitGetAsEntry: () => entry }
        : { kind: "file" },
    ),
  };
}
