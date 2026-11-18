import * as path from "node:path";
import { IDE } from "..";

import {
  findUriInDirs,
  joinEncodedUriPathSegmentToUri,
  joinPathsToUri,
  pathToUriPathSegment,
} from "./uri";

/** True for `file://`, `vscode-remote://`, and any other scheme. */
function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/** A filesystem path is `parent` or inside it. Used when a caller has no URI. */
function plainInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !rel.startsWith("../") &&
      !path.isAbsolute(rel))
  );
}

/**
 * Whether `fullUri` stays inside `dirUri`. URI pairs go through the normalized
 * comparison. Plain paths (some tests and stubs) are compared as filesystem
 * paths so a missing scheme does not throw.
 */
export function staysInDir(fullUri: string, dirUri: string): boolean {
  if (hasScheme(fullUri) && hasScheme(dirUri)) {
    return findUriInDirs(fullUri, [dirUri]).foundInDir !== null;
  }
  return plainInside(dirUri, fullUri);
}

/** Options for the path helpers below. */
export interface ResolveOptions {
  /**
   * Resolve a path that leaves the workspace to the file it names. Set only
   * where the person's File edits level is IDGAF, which has said
   * nothing asks: without it a path outside every workspace folder is not
   * a target, as before.
   */
  allowOutside?: boolean;
}

/**
 * A local absolute path (POSIX, a Windows drive path, a UNC path) or a file
 * URI as a file URI; undefined for a relative path or another scheme.
 */
export function absoluteLocalUri(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^file:/i.test(text)) return text;
  const drive = /^[a-zA-Z]:[\\/]/.test(text);
  if (!drive && /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(text)) return undefined;
  const unc = /^(\\\\|\/\/)[^\\/]/.test(text);
  if (!drive && !unc && !path.isAbsolute(text)) return undefined;
  const encoded = encodeURI(text.replace(/\\/g, "/")).replace(/#/g, "%23");
  if (drive) return `file:///${encoded}`;
  return unc ? `file:${encoded}` : `file://${encoded}`;
}

/** True when the URI is not inside any of the workspace folders. */
export function isOutsideDirs(uri: string, dirs: readonly string[]): boolean {
  return !dirs.some((dir) => staysInDir(uri, dir));
}

/*
  This function takes a relative (to workspace) filepath
  And checks each workspace for if it exists or not
  Only returns fully resolved URI if it exists
*/
export async function resolveRelativePathInDir(
  path: string,
  ide: IDE,
  dirUriCandidates?: string[],
  options?: ResolveOptions,
): Promise<string | undefined> {
  const dirs = dirUriCandidates ?? (await ide.getWorkspaceDirs());
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, path);
    // A path that climbs out of this directory is not inside it, even when
    // the file exists. Callers treat a returned URI as contained.
    if (!staysInDir(fullUri, dirUri)) continue;
    if (await ide.fileExists(fullUri)) {
      return fullUri;
    }
  }

  if (options?.allowOutside) {
    // An absolute path, or a climb out of the folder, names the file itself.
    const candidates = [
      absoluteLocalUri(path),
      ...dirs.slice(0, 1).map((dir) => joinPathsToUri(dir, path)),
    ];
    for (const uri of candidates) {
      if (uri && (await ide.fileExists(uri))) return uri;
    }
  }

  return undefined;
}

/** Decoded path of a URI, or the string itself when it is not one. */
function pathOfUri(uri: string): string {
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) {
      return decodeURIComponent(new URL(uri).pathname).replace(/\\/g, "/");
    }
  } catch {
    // Not a URI.
  }
  return uri.replace(/\\/g, "/");
}

/**
 * True when `filepath` is the whole path or a separator-bounded suffix.
 * `a.ts` matches `/src/a.ts` and does not match `/src/data.ts`.
 */
export function uriHasPathSuffix(uri: string, filepath: string): boolean {
  const want = filepath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (
    !want ||
    want.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    return false;
  }
  const got = pathOfUri(uri).replace(/\/+$/, "");
  return got === want || got.endsWith("/" + want);
}

/**
 * The single open file that ends with `filepath` and sits inside a workspace
 * directory. A file outside the workspace, or two matches, is not a target.
 */
export async function uniqueOpenFileInWorkspace(
  filepath: string,
  ide: IDE,
): Promise<string | undefined> {
  const dirs = await ide.getWorkspaceDirs();
  const hits = (await ide.getOpenFiles()).filter(
    (uri) =>
      uriHasPathSuffix(uri, filepath) &&
      dirs.some((dir) => staysInDir(uri, dir)),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/*
  Same as above but in this case the relative path does not need to exist (e.g. file to be created, etc)
  Checks closes match with the dirs, path segment by segment
  and based on which workspace has the closest matching path, returns resolved URI
  If no meaninful path match just concatenates to first dir's uri
*/
export async function inferResolvedUriFromRelativePath(
  _relativePath: string,
  ide: IDE,
  dirCandidates?: string[],
  options?: ResolveOptions,
): Promise<string> {
  const relativePath = _relativePath.trim().replaceAll("\\", "/");
  const dirs = dirCandidates ?? (await ide.getWorkspaceDirs());

  if (dirs.length === 0) {
    throw new Error("inferResolvedUriFromRelativePath: no dirs provided");
  }

  // An absolute path names that file, not a place under the first folder.
  // Inside a workspace folder it always did; outside one, only when the
  // caller says the level allows it.
  const absolute = absoluteLocalUri(relativePath);
  if (absolute && (options?.allowOutside || !isOutsideDirs(absolute, dirs))) {
    return absolute;
  }

  const segments = pathToUriPathSegment(relativePath).split("/");
  // Generate all possible suffixes from shortest to longest
  const suffixes: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    suffixes.push(segments.slice(i).join("/"));
  }

  // For each suffix, try to find a unique matching dir/file
  for (const suffix of suffixes) {
    const uris = dirs.map((dir) => ({
      dir,
      partialUri: joinEncodedUriPathSegmentToUri(dir, suffix),
    }));
    const promises = uris.map(async ({ partialUri, dir }) => {
      const exists = await ide.fileExists(partialUri);
      return {
        dir,
        partialUri,
        exists,
      };
    });
    const existenceChecks = await Promise.all(promises);

    const existingUris = existenceChecks.filter(({ exists }) => exists);

    // If exactly one directory matches, use it
    if (existingUris.length === 1) {
      return joinEncodedUriPathSegmentToUri(
        existingUris[0].dir,
        segments.join("/"),
      );
    }
  }

  // Sometimes the model will decide to only output the base name or small number of path parts
  // in which case we shouldn't create a new file if it matches the current file
  const activeFile = await ide.getCurrentFile();
  if (
    activeFile &&
    uriHasPathSuffix(activeFile.path, relativePath) &&
    dirs.some((dir) => staysInDir(activeFile.path, dir))
  ) {
    return activeFile.path;
  }

  // If no unique match found, use the first directory
  return joinPathsToUri(dirs[0], relativePath);
}
