import { DataTransferLike, FileLike } from "./classifyDrop";

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
