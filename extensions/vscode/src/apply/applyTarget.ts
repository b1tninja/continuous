import * as URI from "uri-js";

/** The document an apply started on, and its version at that moment. */
export interface DocumentStamp {
  uri: string;
  version: number;
}

/**
 * True when the document is gone, a different file, or has been edited since
 * the stamp. A tab switch is a different uri; keystrokes bump the version.
 */
export function documentChanged(
  captured: DocumentStamp,
  current: DocumentStamp | undefined,
): boolean {
  if (!current || current.version !== captured.version) {
    return true;
  }
  if (current.uri === captured.uri) {
    return false;
  }
  try {
    return !URI.equal(current.uri, captured.uri);
  } catch {
    return true;
  }
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** True for a path like `C:\dir\file` or `C:/dir/file` (not a URI). */
export function isWindowsDrivePath(filepath: string): boolean {
  return WINDOWS_DRIVE_PATH.test(filepath);
}

/**
 * Compares two Windows paths the way the file system does: slash direction
 * and drive-letter case do not matter. VS Code reports `c:\dir`; callers may
 * send `C:\dir` or `C:/dir`.
 */
export function windowsPathsEqual(a: string, b: string): boolean {
  if (!isWindowsDrivePath(a) || !isWindowsDrivePath(b)) {
    return false;
  }
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/** Whether an open editor is the file `filepath` names (a URI or a filesystem path). */
export function editorMatchesFilepath(
  editor: { uri: string; fsPath: string },
  filepath: string,
): boolean {
  if (editor.uri === filepath || editor.fsPath === filepath) {
    return true;
  }
  if (windowsPathsEqual(editor.fsPath, filepath)) {
    return true;
  }
  try {
    return URI.equal(editor.uri, filepath);
  } catch {
    return false;
  }
}
