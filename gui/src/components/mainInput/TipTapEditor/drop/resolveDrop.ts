/**
 * Decides what each dropped item becomes. Resources are checked here before
 * anything reads them:
 *
 * 1. A path that matches the security patterns (the list the indexer and the
 *    `@` file picker already exclude: `.env*`, keys, certificates, `.ssh/`,
 *    cloud credential folders and so on) is refused by name, before any host
 *    call that names the file.
 * 2. A resource outside every workspace folder is refused.
 * 3. The host is asked whether the resource exists and whether it is a file
 *    or a folder (`listDir` of its parent). Nothing reads the file's content:
 *    a file becomes an `@file` mention, read by the file provider at send
 *    time, exactly as if it had been picked from the `@` list.
 */
import { securityPatternHit } from "core/indexing/securityPatterns";
import { stripInvisible } from "core/util/fetchedText";
import { findUriInDirs } from "core/util/uri";
import { DropItem, FileLike, stripFragment, uriBasename } from "./classifyDrop";

/** Image caps for one message (owner decision D3 in the input research). */
export const MAX_IMAGES_PER_MESSAGE = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type RefusalReason =
  | "secret"
  | "outside-workspace"
  | "not-found"
  | "no-location"
  | "svg-image"
  | "untitled"
  | "unknown-type"
  | "no-vision"
  | "too-many-images"
  | "image-too-large"
  | "unreadable-image"
  | "no-file-provider"
  | "no-folder-provider";

export interface Refusal {
  name: string;
  reason: RefusalReason;
}

export interface ResolvedMention {
  kind: "file" | "folder";
  uri: string;
  name: string;
  relativePath: string;
}

export interface DropHost {
  getWorkspaceDirs(): Promise<string[]>;
  /** The entries of a directory, as [name, FileType] (1 file, 2 directory). */
  listDir(dirUri: string): Promise<[string, number][]>;
}

const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIRECTORY = 2;
const FILE_TYPE_SYMLINK = 64;

function parentUri(uri: string): string {
  const clean = stripFragment(uri).replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash === -1 ? clean : clean.slice(0, slash);
}

/** The last two path segments, as `isSecurityConcern` checks them. */
function tailOf(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}

/**
 * True when a dropped resource looks like it holds credentials. Checks the
 * workspace-relative path when there is one, and always the last two segments
 * and the name, so a key file outside the workspace is named as a secret
 * rather than only as "outside".
 */
export function isCredentialPath(
  uri: string,
  relativePath: string | null,
): boolean {
  let decodedPath = stripFragment(uri).replace(
    /^[a-zA-Z][\w+.-]*:\/\/[^/]*/,
    "",
  );
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    // keep the raw path
  }
  const candidates = [
    relativePath ?? "",
    tailOf(decodedPath),
    uriBasename(uri),
  ].filter(Boolean);
  // A folder pattern such as `.ssh/` only matches with the trailing slash, and
  // the kind is not known yet (nothing has asked the host), so try both.
  return candidates.some(
    (p) => securityPatternHit(p) || securityPatternHit(`${p}/`),
  );
}

export interface ResourceResult {
  mentions: ResolvedMention[];
  refusals: Refusal[];
}

export async function resolveResources(
  items: DropItem[],
  host: DropHost,
  providers: { file: boolean; folder: boolean },
): Promise<ResourceResult> {
  const resources = items.filter(
    (i) => (i.kind === "file" || i.kind === "folder") && i.uri,
  );
  const mentions: ResolvedMention[] = [];
  const refusals: Refusal[] = [];
  if (resources.length === 0) return { mentions, refusals };

  let dirs: string[] = [];
  try {
    dirs = await host.getWorkspaceDirs();
  } catch {
    dirs = [];
  }

  const listings = new Map<string, Promise<[string, number][]>>();
  const listOnce = (dir: string) => {
    let p = listings.get(dir);
    if (!p) {
      p = host.listDir(dir).catch(() => []);
      listings.set(dir, p);
    }
    return p;
  };

  for (const item of resources) {
    const uri = stripFragment(item.uri!);
    let found: ReturnType<typeof findUriInDirs> | undefined;
    try {
      found = findUriInDirs(uri, dirs);
    } catch {
      found = undefined;
    }
    const relativePath = found?.foundInDir
      ? found.relativePathOrBasename
      : null;

    // 1. Credentials first, by name only: nothing has asked the host about
    //    this file yet.
    if (isCredentialPath(uri, relativePath)) {
      refusals.push({ name: item.name, reason: "secret" });
      continue;
    }
    // 2. Workspace boundary.
    if (!found?.foundInDir || relativePath === null) {
      refusals.push({ name: item.name, reason: "outside-workspace" });
      continue;
    }
    // 3. Does it exist, and is it a file or a folder? The workspace folder
    //    itself has no parent inside the workspace; it is a folder.
    let isFolder: boolean;
    if (relativePath === "") {
      isFolder = true;
    } else {
      const entries = await listOnce(parentUri(uri));
      const entry = entries.find(([name]) => name === uriBasename(uri));
      if (!entry) {
        refusals.push({ name: item.name, reason: "not-found" });
        continue;
      }
      const type = entry[1] & ~FILE_TYPE_SYMLINK;
      if (type !== FILE_TYPE_FILE && type !== FILE_TYPE_DIRECTORY) {
        refusals.push({ name: item.name, reason: "unknown-type" });
        continue;
      }
      isFolder = type === FILE_TYPE_DIRECTORY;
    }
    if (isFolder && !providers.folder) {
      refusals.push({ name: item.name, reason: "no-folder-provider" });
      continue;
    }
    if (!isFolder && !providers.file) {
      refusals.push({ name: item.name, reason: "no-file-provider" });
      continue;
    }
    mentions.push({
      kind: isFolder ? "folder" : "file",
      uri,
      name: relativePath === "" ? uriBasename(uri) : item.name,
      relativePath,
    });
  }
  return { mentions, refusals };
}

export interface ImageResult<F extends FileLike> {
  accepted: F[];
  refusals: Refusal[];
}

/** Applies the vision gate and the count and size caps to dropped images. */
export function checkImages<F extends FileLike>(
  items: DropItem<F>[],
  options: { visionSupported: boolean; imagesAlreadyInMessage: number },
): ImageResult<F> {
  const accepted: F[] = [];
  const refusals: Refusal[] = [];
  let count = options.imagesAlreadyInMessage;
  for (const item of items) {
    if (item.kind !== "image" || !item.file) continue;
    if (!options.visionSupported) {
      refusals.push({ name: item.name, reason: "no-vision" });
    } else if ((item.size ?? item.file.size) > MAX_IMAGE_BYTES) {
      refusals.push({ name: item.name, reason: "image-too-large" });
    } else if (count >= MAX_IMAGES_PER_MESSAGE) {
      refusals.push({ name: item.name, reason: "too-many-images" });
    } else {
      accepted.push(item.file);
      count++;
    }
  }
  return { accepted, refusals };
}

const JOINERS = /([‌‍])/;

/**
 * Removes hidden characters from dropped text with the existing
 * `stripInvisible` (tag characters, bidi controls, zero-width spaces, BOM, C0
 * controls), but keeps the zero-width joiner and non-joiner, which emoji
 * sequences and Persian and Indic text need. Returns the count removed.
 */
export function sanitizeDroppedText(text: string): {
  text: string;
  removed: number;
} {
  let removed = 0;
  const out = text
    .split(JOINERS)
    .map((part) => {
      if (part === "‌" || part === "‍") return part;
      const clean = stripInvisible(part);
      removed += Array.from(part).length - Array.from(clean).length;
      return clean;
    })
    .join("");
  return { text: out, removed };
}

export interface DropOutcome {
  files: number;
  folders: string[];
  images: number;
  text: boolean;
  links: number;
  hiddenRemoved: number;
  refusals: Refusal[];
}

const REASON_TEXT: Record<RefusalReason, (name: string) => string> = {
  secret: (n) => `${n} looks like it holds secrets or keys`,
  "outside-workspace": (n) => `${n} is outside the workspace`,
  "not-found": (n) => `${n} was not found in the workspace`,
  "no-location": (n) =>
    `${n} came from outside the editor, so it has no location (add workspace files with @)`,
  "svg-image": (n) =>
    `${n} is an SVG, which is added as text, not as an image (add it from the workspace)`,
  untitled: (n) => `${n} is not saved yet`,
  "unknown-type": (n) => `${n} is not a file or a folder`,
  "no-vision": (n) => `${n}: the selected model does not read images`,
  "too-many-images": (n) =>
    `${n}: a message can hold at most ${MAX_IMAGES_PER_MESSAGE} images`,
  "image-too-large": (n) => `${n} is larger than 5 MB`,
  "unreadable-image": (n) => `${n} could not be read as an image`,
  "no-file-provider": (n) =>
    `${n}: file context is not available in this configuration`,
  "no-folder-provider": (n) =>
    `${n}: folder context is not available in this configuration`,
};

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** One sentence (or two) for the screen reader and the visible note. */
export function describeDropOutcome(o: DropOutcome): string {
  const added: string[] = [];
  if (o.files) added.push(plural(o.files, "file", "files"));
  if (o.folders.length === 1) {
    added.push(`folder ${o.folders[0]} as a search scope`);
  } else if (o.folders.length > 1) {
    added.push(`${o.folders.length} folders as search scopes`);
  }
  if (o.images) added.push(plural(o.images, "image", "images"));
  if (o.links) added.push(plural(o.links, "link", "links"));
  if (o.text) added.push("the dropped text");

  const parts: string[] = [];
  if (added.length) parts.push(`Added ${added.join(", ")}.`);
  if (o.hiddenRemoved) {
    parts.push(
      `Removed ${plural(o.hiddenRemoved, "hidden character", "hidden characters")}.`,
    );
  }
  if (o.refusals.length) {
    parts.push(
      `Not added: ${o.refusals.map((r) => REASON_TEXT[r.reason](r.name)).join("; ")}.`,
    );
  }
  return parts.join(" ");
}

/** Whether the outcome needs a visible note (beyond the chips themselves). */
export function outcomeNeedsNote(o: DropOutcome): boolean {
  return o.refusals.length > 0 || o.folders.length > 0 || o.hiddenRemoved > 0;
}
