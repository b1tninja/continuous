import * as fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "path";
import untildify from "untildify";
import { IDE } from "..";
import { resolveRelativePathInDir, staysInDir } from "./ideUtils";
import { joinPathsToUri } from "./uri";
import { workspaceFoldersForFiles } from "./workspaceFolders";

export interface ResolvedPath {
  uri: string;
  displayPath: string;
  isAbsolute: boolean;
  isWithinWorkspace: boolean;
}

/**
 * The local file a URI names, following symlinks. Remote URIs are unchanged.
 * A missing file follows its nearest existing parent, so a new file under a
 * symlinked directory is judged by where it would be created.
 */
function followLocalSymlink(uri: string): string {
  if (!uri.startsWith("file:")) return uri;
  let fsPath: string;
  try {
    fsPath = fileURLToPath(uri);
  } catch {
    return uri;
  }
  // fileURLToPath has already resolved "." / ".." and percent-decoding.
  // Rebuild the URI from that path so a later containment check cannot see
  // the raw segments. realpath then follows a symlink when the file exists.
  const real = realpathOrParent(fsPath) ?? fsPath;
  return pathToFileURL(real).href;
}

function realpathOrParent(fsPath: string): string | undefined {
  try {
    return fs.realpathSync.native(fsPath);
  } catch {
    const parent = path.dirname(fsPath);
    if (parent === fsPath) return undefined;
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(fsPath));
    } catch {
      return undefined;
    }
  }
}

/**
 * Checks if a URI is within any of the workspace directories.
 * Both the file and the workspace roots are followed through symlinks first.
 * A file that does not exist yet is still inside the folder it would be
 * created in: existence is not the boundary.
 */
async function isUriWithinWorkspace(ide: IDE, uri: string): Promise<boolean> {
  // Partial IDE stubs used by some tests do not implement this. A path that
  // already resolved against a workspace directory stays inside.
  if (typeof ide.getWorkspaceDirs !== "function") return true;
  // The folders the person added count as the workspace for this question.
  // The chat page bundles this file and has no filesystem, so only Node reads them.
  const workspaceDirs = await workspaceFoldersForFiles(ide);
  const realUri = uri.startsWith("file:") ? followLocalSymlink(uri) : uri;
  const realDirs = workspaceDirs.map((dir) =>
    dir.startsWith("file:") ? followLocalSymlink(dir) : dir,
  );
  return realDirs.some((dir) => staysInDir(realUri, dir));
}

async function asResolved(
  ide: IDE,
  uri: string,
  displayPath: string,
  isAbsolute: boolean,
): Promise<ResolvedPath> {
  const realUri = followLocalSymlink(uri);
  return {
    uri: realUri,
    displayPath,
    isAbsolute,
    isWithinWorkspace: await isUriWithinWorkspace(ide, realUri),
  };
}

export async function resolveInputPath(
  ide: IDE,
  inputPath: string,
): Promise<ResolvedPath | null> {
  const trimmedPath = inputPath.trim();

  // Handle file:// URIs
  if (trimmedPath.startsWith("file://")) {
    return asResolved(ide, trimmedPath, fileURLToPath(trimmedPath), true);
  }

  // Expand tilde paths (handles ~/ and ~username/)
  const expandedPath = untildify(trimmedPath);

  // Check if it's an absolute path (including Windows paths)
  const isAbsolute =
    path.isAbsolute(expandedPath) ||
    // Windows network paths
    expandedPath.startsWith("\\\\") ||
    // Windows drive letters
    /^[a-zA-Z]:/.test(expandedPath);

  if (isAbsolute) {
    return asResolved(
      ide,
      pathToFileURL(expandedPath).href,
      expandedPath,
      true,
    );
  }

  // Handle relative paths. A file that exists inside a workspace directory
  // is inside; one that is only reached by climbing out is not.
  const workspaceUri = await resolveRelativePathInDir(expandedPath, ide);
  if (workspaceUri) {
    return asResolved(ide, workspaceUri, expandedPath, false);
  }

  const dirs = await ide.getWorkspaceDirs();
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, expandedPath);
    if (staysInDir(fullUri, dirUri)) continue;
    if (await ide.fileExists(fullUri)) {
      return asResolved(ide, fullUri, expandedPath, false);
    }
  }

  // A missing file whose parent is a symlink is judged by where that link
  // points, not by the path as written.
  for (const dirUri of dirs) {
    const fullUri = joinPathsToUri(dirUri, expandedPath);
    const realUri = fullUri.startsWith("file:")
      ? followLocalSymlink(fullUri)
      : fullUri;
    if (realUri === fullUri) continue;
    if (dirs.some((dir) => staysInDir(realUri, dir))) continue;
    return {
      uri: realUri,
      displayPath: expandedPath,
      isAbsolute: false,
      isWithinWorkspace: false,
    };
  }

  return null;
}
