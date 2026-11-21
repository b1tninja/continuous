import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as URI from "uri-js";

/** Converts any OS path to cleaned up URI path segment format with no leading/trailing slashes
   e.g. \path\to\folder\ -> path/to/folder
        \this\is\afile.ts -> this/is/afile.ts
        is/already/clean -> is/already/clean
  **/
export function pathToUriPathSegment(path: string) {
  let clean = path.replace(/[\\]/g, "/"); // backslashes -> forward slashes
  clean = clean.replace(/^\//, ""); // remove start slash
  clean = clean.replace(/\/$/, ""); // remove end slash
  return clean
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function getCleanUriPath(uri: string) {
  const uriPath = URI.parse(uri).path ?? "";
  let clean = uriPath.replace(/^\//, ""); // remove start slash
  clean = clean.replace(/\/$/, ""); // remove end slash
  return clean;
}

/**
 * Path segments of a URI after percent-decoding and resolving `.` and `..`.
 * Workspace checks use this so `file:///proj/../other/x` is not treated as a
 * file inside `proj`.
 */
/** A Windows drive letter is case-insensitive: `C:` and `c:` name the same drive. */
function withLowerDrive(parts: string[]): string[] {
  if (parts.length > 0 && /^[a-zA-Z]:$/.test(parts[0])) {
    return [parts[0].toLowerCase(), ...parts.slice(1)];
  }
  return parts;
}

export function normalizedUriPathParts(uri: string): string[] {
  const comps = URI.parse(uri);
  if (comps.scheme === "file") {
    try {
      // fileURLToPath percent-decodes and resolves dot segments.
      return withLowerDrive(
        path
          .normalize(fileURLToPath(uri))
          .split(/[/\\]/)
          .filter((part) => part !== ""),
      );
    } catch {
      // Not a file URL this platform accepts; fall through.
    }
  }
  const raw = (comps.path ?? "").replace(/\\/g, "/");
  const stack: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // Keep a segment that is not valid percent-encoding.
    }
    if (decoded === "" || decoded === ".") continue;
    if (decoded === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      continue;
    }
    stack.push(decoded);
  }
  return withLowerDrive(stack);
}

export function findUriInDirs(
  uri: string,
  dirUriCandidates: string[],
  options: {
    /**
     * Compare folder and file names without regard to case. Default: on
     * Windows, whose filesystems are case-insensitive, so `My-Project`
     * and `my-project` are one folder there and not elsewhere.
     */
    caseInsensitive?: boolean;
  } = {},
): {
  uri: string;
  relativePathOrBasename: string;
  foundInDir: string | null;
} {
  // This file is bundled into the webview, which has no `process`.
  // Node still defaults to case-insensitive names on Windows.
  const caseInsensitive =
    options.caseInsensitive ??
    (typeof process !== "undefined" && process.platform === "win32");
  const same = (a: string, b: string) =>
    caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
  const uriComps = URI.parse(uri);
  if (!uriComps.scheme) {
    throw new Error(`Invalid uri: ${uri}`);
  }
  const uriPathParts = normalizedUriPathParts(uri);

  for (const dir of dirUriCandidates) {
    const dirComps = URI.parse(dir);

    if (!dirComps.scheme) {
      throw new Error(`Invalid uri: ${dir}`);
    }

    if (uriComps.scheme !== dirComps.scheme) {
      continue;
    }
    // Can't just use startsWith because e.g.
    // file:///folder/file is not within file:///fold

    // Compare resolved segments, not the raw URI text, so ".." and
    // percent-encoded dot segments cannot pretend to stay inside a directory.
    const dirPathParts = normalizedUriPathParts(dir);

    if (uriPathParts.length < dirPathParts.length) {
      continue;
    }
    let allDirPartsMatch = true;
    for (let i = 0; i < dirPathParts.length; i++) {
      if (!same(dirPathParts[i], uriPathParts[i])) {
        allDirPartsMatch = false;
      }
    }
    if (allDirPartsMatch) {
      const relativePath = uriPathParts.slice(dirPathParts.length).join("/");
      return {
        uri,
        relativePathOrBasename: relativePath,
        foundInDir: dir,
      };
    }
  }
  // Not found
  return {
    uri,
    relativePathOrBasename: getUriPathBasename(uri),
    foundInDir: null,
  };
}

/*
  Returns just the file or folder name of a URI
*/
export function getUriPathBasename(uri: string): string {
  const path = getCleanUriPath(uri);
  const basename = path.split("/").pop() || "";
  return decodeURIComponent(basename);
}

export function getFileExtensionFromBasename(basename: string) {
  const parts = basename.split(".");
  if (parts.length < 2) {
    return "";
  }
  return (parts.slice(-1)[0] ?? "").toLowerCase();
}

/*
  Returns the file extension of a URI
*/
export function getUriFileExtension(uri: string) {
  const baseName = getUriPathBasename(uri);
  return getFileExtensionFromBasename(baseName);
}

export function getLastNUriRelativePathParts(
  dirUriCandidates: string[],
  uri: string,
  n: number,
): string {
  const { relativePathOrBasename } = findUriInDirs(uri, dirUriCandidates);
  return getLastNPathParts(relativePathOrBasename, n);
}

export function joinPathsToUri(uri: string, ...pathSegments: string[]) {
  let baseUri = uri;
  if (baseUri.at(-1) !== "/") {
    baseUri += "/";
  }
  const segments = pathSegments.map((segment) => pathToUriPathSegment(segment));
  return URI.resolve(baseUri, segments.join("/"));
}

export function joinEncodedUriPathSegmentToUri(
  uri: string,
  pathSegment: string,
) {
  let baseUri = uri;
  if (baseUri.at(-1) !== "/") {
    baseUri += "/";
  }
  return URI.resolve(baseUri, pathSegment);
}

export function getShortestUniqueRelativeUriPaths(
  uris: string[],
  dirUriCandidates: string[],
): {
  uri: string;
  uniquePath: string;
}[] {
  // Split all URIs into segments and count occurrences of each suffix combination
  const segmentCombinationsMap = new Map<string, number>();
  const segmentsInfo = uris.map((uri) => {
    const { relativePathOrBasename } = findUriInDirs(uri, dirUriCandidates);
    const segments = relativePathOrBasename.split("/");
    const suffixes: string[] = [];

    // Generate all possible suffix combinations, starting from the shortest (basename)
    for (let i = segments.length - 1; i >= 0; i--) {
      const suffix = segments.slice(i).join("/");
      suffixes.push(suffix); // Now pushing in order from shortest to longest
      // Count occurrences of each suffix
      segmentCombinationsMap.set(
        suffix,
        (segmentCombinationsMap.get(suffix) || 0) + 1,
      );
    }

    return { uri, segments, suffixes, relativePathOrBasename };
  });
  // Find shortest unique path for each URI
  return segmentsInfo.map(({ uri, suffixes, relativePathOrBasename }) => {
    // Since suffixes are now ordered from shortest to longest,
    // the first unique one we find will be the shortest
    const uniquePath =
      suffixes.find((suffix) => segmentCombinationsMap.get(suffix) === 1) ??
      relativePathOrBasename; // fallback to full path if no unique suffix found
    return { uri, uniquePath };
  });
}

// Only used when working with system paths and relative paths
// Since doesn't account for URI segements before workspace
export function getLastNPathParts(filepath: string, n: number): string {
  if (n <= 0) {
    return "";
  }
  return filepath.split(/[\\/]/).slice(-n).join("/");
}

export function getUriDescription(uri: string, dirUriCandidates: string[]) {
  const { relativePathOrBasename, foundInDir } = findUriInDirs(
    uri,
    dirUriCandidates,
  );
  const baseName = getUriPathBasename(uri);
  const extension = getFileExtensionFromBasename(baseName);
  const last2Parts = getLastNUriRelativePathParts(dirUriCandidates, uri, 2);
  return {
    uri,
    relativePathOrBasename,
    foundInDir,
    last2Parts,
    baseName,
    extension,
  };
}
