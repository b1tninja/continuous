/**
 * Turns a drop on the chat input into typed items. Pure: it reads the
 * `DataTransfer`-like object it is given and nothing else, so a path or URI in
 * the result is only a claim. `resolveDrop.ts` checks every resource against
 * the workspace and the security patterns before anything reads it.
 *
 * What VS Code puts on a drag (microsoft/vscode `src/vs/workbench/browser/dnd.ts`,
 * `fillEditorsDragData`): `ResourceURLs` (JSON array, files only),
 * `CodeEditors` (JSON, one entry per file or editor tab), `text/uri-list` (the
 * first URI only, a Chromium limit), `application/vnd.code.uri-list` (every
 * URI, folders first) and `text/plain` (path labels). Chromium lowercases
 * custom type names, so `types` holds `resourceurls` and `codeeditors`. A drag
 * from the operating system's file manager carries `Files` and no path.
 */

export type DropKind =
  "file" | "folder" | "image" | "text" | "url" | "unsupported";

export type DropSource = "explorer" | "editor" | "os" | "text";

export type UnsupportedReason =
  "no-location" | "svg-image" | "untitled" | "unknown-type";

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export interface DataTransferLike {
  types: readonly string[];
  getData(format: string): string;
  files?: ArrayLike<FileLike> | null;
}

export interface DropItem<F extends FileLike = FileLike> {
  kind: DropKind;
  source: DropSource;
  /** Display name: the last path segment, or the file name. */
  name: string;
  /** The resource URI without a fragment, for file, folder and url items. */
  uri?: string;
  /** True when the kind came from the drag data, not a guess. */
  kindCertain?: boolean;
  size?: number;
  mime?: string;
  /** The dropped text, for text items (not yet sanitised). */
  text?: string;
  /** The dropped file, for image items and refused OS files. */
  file?: F;
  reason?: UnsupportedReason;
}

export const VSCODE_URI_LIST = "application/vnd.code.uri-list";
const RESOURCE_URLS = "resourceurls";
const CODE_EDITORS = "codeeditors";
const URI_LIST = "text/uri-list";
const TEXT = "text/plain";
const FILES = "files";

/** Image types the existing image path accepts. SVG is not one: it is text. */
export const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
];

function hasType(types: readonly string[], type: string): boolean {
  return types.some((t) => t.toLowerCase() === type);
}

function safeGet(dt: DataTransferLike, type: string): string {
  try {
    return dt.getData(type) ?? "";
  } catch {
    return "";
  }
}

/** RFC 2483 uri-list: one URI per line, `#` starts a comment line. */
export function parseUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseJsonArray(text: string): unknown[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The URI without its fragment (an editor selection such as `#L10`). */
export function stripFragment(uri: string): string {
  const hash = uri.indexOf("#");
  return hash === -1 ? uri : uri.slice(0, hash);
}

function schemeOf(uri: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  return match ? match[1].toLowerCase() : "";
}

/** Last path segment, percent-decoded where valid. */
export function uriBasename(uri: string): string {
  const withoutQuery = stripFragment(uri).split("?")[0];
  const segments = withoutQuery.replace(/\/+$/, "").split("/");
  const last = segments[segments.length - 1] || withoutQuery;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A `CodeEditors` entry's resource as a URI string, if it has one. */
function editorResourceUri(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const resource = (entry as { resource?: unknown }).resource;
  if (typeof resource === "string") return resource;
  if (resource && typeof resource === "object") {
    const external = (resource as { external?: unknown }).external;
    if (typeof external === "string") return external;
  }
  return undefined;
}

function resourceItem(
  uri: string,
  source: DropSource,
  folder: boolean | undefined,
): DropItem {
  const clean = stripFragment(uri);
  const scheme = schemeOf(clean);
  const name = uriBasename(clean);
  if (scheme === "http" || scheme === "https") {
    return { kind: "url", source, name: clean, uri: clean, kindCertain: true };
  }
  if (scheme === "untitled") {
    return {
      kind: "unsupported",
      source,
      name,
      uri: clean,
      reason: "untitled",
    };
  }
  if (!scheme) {
    return { kind: "unsupported", source, name, reason: "unknown-type" };
  }
  return {
    kind: folder ? "folder" : "file",
    source,
    name,
    uri: clean,
    kindCertain: folder !== undefined,
  };
}

export function fileItem<F extends FileLike>(file: F): DropItem<F> {
  const mime = (file.type || "").toLowerCase();
  const base = {
    source: "os" as const,
    name: file.name,
    size: file.size,
    mime,
    file,
  };
  if (IMAGE_MIME_TYPES.includes(mime)) {
    return { ...base, kind: "image", kindCertain: true };
  }
  if (mime === "image/svg+xml" || /\.svg$/i.test(file.name)) {
    return { ...base, kind: "unsupported", reason: "svg-image" };
  }
  // A file from the operating system has bytes and a name but no location
  // (Electron removed File.path, and a webview has no Node to ask).
  return { ...base, kind: "unsupported", reason: "no-location" };
}

/**
 * Classify a drop. Resources (URIs) win over files, and both win over text,
 * because VS Code's own drags also carry a `text/plain` list of path labels
 * that must not be pasted as text.
 */
export function classifyDrop<F extends FileLike = FileLike>(
  dt: DataTransferLike & { files?: ArrayLike<F> | null },
): DropItem<F>[] {
  const types = Array.from(dt.types ?? []).map((t) => t.toLowerCase());

  const codeUriList = hasType(types, VSCODE_URI_LIST)
    ? parseUriList(safeGet(dt, VSCODE_URI_LIST))
    : [];
  const plainUriList = hasType(types, URI_LIST)
    ? parseUriList(safeGet(dt, URI_LIST))
    : [];
  const resourceUrls = hasType(types, RESOURCE_URLS)
    ? parseJsonArray(safeGet(dt, RESOURCE_URLS)).filter(
        (u): u is string => typeof u === "string",
      )
    : [];
  const editorUris = hasType(types, CODE_EDITORS)
    ? parseJsonArray(safeGet(dt, CODE_EDITORS))
        .map(editorResourceUri)
        .filter((u): u is string => typeof u === "string")
    : [];

  const fromVsCode =
    hasType(types, VSCODE_URI_LIST) ||
    hasType(types, RESOURCE_URLS) ||
    hasType(types, CODE_EDITORS);

  const source: DropSource = hasType(types, RESOURCE_URLS)
    ? "explorer"
    : editorUris.length > 0
      ? "editor"
      : fromVsCode
        ? "explorer"
        : "os";

  // VS Code's uri-list is the complete one; text/uri-list holds only the
  // first entry. ResourceURLs and CodeEditors add nothing new in VS Code but
  // are read in case a host sends only them.
  const ordered = [
    ...codeUriList,
    ...(codeUriList.length ? [] : plainUriList),
    ...resourceUrls,
    ...editorUris,
  ];
  const seen = new Set<string>();
  const uris: string[] = [];
  for (const raw of ordered) {
    const clean = stripFragment(raw);
    if (seen.has(clean)) continue;
    seen.add(clean);
    uris.push(raw);
  }

  if (uris.length > 0) {
    // In VS Code every file in a drag yields a CodeEditors entry (and a
    // ResourceURLs entry from the Explorer); a folder yields neither. So a URI
    // in VS Code's list that is in neither is a folder.
    const fileUris = new Set(
      [...resourceUrls, ...editorUris].map((u) => stripFragment(u)),
    );
    return uris.map((raw) => {
      const clean = stripFragment(raw);
      let folder: boolean | undefined;
      if (fromVsCode && hasType(types, VSCODE_URI_LIST)) {
        folder = !fileUris.has(clean);
      } else if (/\/$/.test(clean)) {
        folder = true;
      }
      return resourceItem(raw, source, folder) as DropItem<F>;
    });
  }

  const files = dt.files ? Array.from(dt.files) : [];
  if (files.length > 0) {
    return files.map((f) => fileItem(f));
  }

  if (hasType(types, TEXT) || (!types.length && safeGet(dt, TEXT))) {
    const text = safeGet(dt, TEXT);
    if (text) {
      return [{ kind: "text", source: "text", name: "text", text }];
    }
  }

  if (hasType(types, FILES)) {
    // Files announced but not readable (some hosts only expose them on drop).
    return [
      {
        kind: "unsupported",
        source: "os",
        name: "file",
        reason: "no-location",
      },
    ];
  }

  return [];
}

/**
 * Whether a drag is worth showing the drop target for. During `dragover`
 * only the type list is readable (values arrive on `drop`).
 */
export function isHandledDrag(types: readonly string[] | undefined): boolean {
  if (!types) return false;
  const lower = Array.from(types).map((t) => t.toLowerCase());
  return [VSCODE_URI_LIST, RESOURCE_URLS, CODE_EDITORS, URI_LIST, FILES, TEXT]
    .map((t) => t.toLowerCase())
    .some((t) => lower.includes(t));
}

export interface ClipboardItemLike<F extends FileLike = FileLike> {
  kind: string;
  type: string;
  getAsFile(): F | null;
}

export interface ClipboardDataLike<F extends FileLike = FileLike> {
  types?: readonly string[];
  getData(format: string): string;
  items?: ArrayLike<ClipboardItemLike<F>> | null;
  files?: ArrayLike<F> | null;
}

/**
 * The files of a paste. Chromium lists a pasted file under `items` and again
 * under `files`; `items` is read first and `files` only when it has none.
 */
function pastedFiles<F extends FileLike>(cb: ClipboardDataLike<F>): F[] {
  const fromItems: F[] = [];
  for (const item of Array.from(cb.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems.length ? fromItems : Array.from(cb.files ?? []);
}

/**
 * Turns a paste into the items to add, or none when the editor should paste
 * as usual. Only files are taken: a screenshot or an image copied from a
 * browser (`image/png`, sometimes with `text/html` holding an `<img>` tag).
 *
 * A paste with real text keeps the editor's own paste. Office apps put a
 * picture of the copied cells or paragraph next to the text, and the text is
 * what was meant; a copied image has no `text/plain`.
 */
export function classifyPaste<F extends FileLike = FileLike>(
  cb: ClipboardDataLike<F>,
): DropItem<F>[] {
  const files = pastedFiles(cb);
  if (files.length === 0) return [];
  let text = "";
  try {
    text = cb.getData(TEXT) ?? "";
  } catch {
    text = "";
  }
  if (text.trim()) return [];
  return files.map((f) => fileItem(f));
}
