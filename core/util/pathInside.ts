/**
 * Path checks that need no Node.
 *
 * The chat webview is a browser build, where Node's `path` is an empty module:
 * `path.win32` is undefined, so `path.win32.relative(...)` threw "Cannot read
 * properties of undefined (reading 'relative')" and every `multi_edit` on
 * Windows failed (plans/research/usage-review-2026-11-21.md follows this).
 * Tests run in Node, where `path` is real, and never saw it. These functions
 * are the part of `path` that `ideUtils.ts` used, written with strings only.
 */

/** A POSIX absolute path: starts with a slash. */
export function isPosixAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/** A Windows absolute path: a drive (`C:\`, `C:/`, `C:`), or UNC / rooted (`\x`, `//x`). */
export function isWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || /^[\\/]/.test(p);
}

/** Absolute in either style. */
export function isAbsoluteAnyStyle(p: string): boolean {
  return isPosixAbsolute(p) || isWindowsAbsolute(p);
}

/**
 * The segments of a Windows path with `.` and `..` resolved, the root kept
 * apart. Drive letters compare without case, as Windows does.
 */
function windowsParts(p: string): { root: string; segments: string[] } {
  const text = p.replace(/\//g, "\\");
  let root = "";
  let rest = text;
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(text);
  if (unc) {
    root = `\\\\${unc[1].toLowerCase()}\\${unc[2].toLowerCase()}`;
    rest = text.slice(unc[0].length);
  } else if (/^[a-zA-Z]:/.test(text)) {
    root = text.slice(0, 2).toLowerCase();
    rest = text.slice(2);
  } else if (text.startsWith("\\")) {
    root = "\\";
  }
  const out: string[] = [];
  for (const seg of rest.split("\\")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg.toLowerCase());
  }
  return { root, segments: out };
}

/**
 * `child` is `parent` or inside it, by Windows rules: slash direction, drive
 * letter case, name case, a trailing separator and `.` / `..` make no
 * difference, and a sibling that only shares a prefix (`Lister Evil` against
 * `Lister`) is outside. Different drives or UNC shares are never inside.
 */
export function windowsPathInside(parent: string, child: string): boolean {
  const p = windowsParts(parent);
  const c = windowsParts(child);
  if (p.root !== c.root) return false;
  if (c.segments.length < p.segments.length) return false;
  return p.segments.every((seg, i) => c.segments[i] === seg);
}

/**
 * The same question for POSIX paths: `.` / `..` resolved, a trailing slash
 * ignored, names compared exactly. An absolute path is never inside a relative
 * one, or the other way round.
 */
export function posixPathInside(parent: string, child: string): boolean {
  const absolute = isPosixAbsolute(parent);
  if (absolute !== isPosixAbsolute(child)) return false;
  const parts = (p: string) => {
    const out: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        // Above the root there is nothing; above a relative start there is
        // somewhere, and it is kept so "../x" is not "x"
        if (out.length && out[out.length - 1] !== "..") out.pop();
        else if (!absolute) out.push("..");
        continue;
      }
      out.push(seg);
    }
    return out;
  };
  const a = parts(parent);
  const b = parts(child);
  if (b.length < a.length) return false;
  return a.every((seg, i) => b[i] === seg);
}
