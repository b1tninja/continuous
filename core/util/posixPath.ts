/**
 * POSIX path operations with no Node.
 *
 * The chat webview is a browser build, where Node's `path/posix` and `os` are
 * empty modules. `protectedPathHit` called `posix.normalize`, `posix.join`,
 * `posix.dirname` and `os.homedir()`, and threw there. `snapshotFile` (which
 * takes a checkpoint before an edit) caught the throw and recorded every file as
 * "unreadable", so "Restore to here" had nothing to restore for any file the
 * agent edited. The same operations are written here with strings only, and a
 * test compares them with Node's on thousands of generated paths.
 *
 * These match `node:path/posix` for the inputs that code passes: a forward-slash
 * path. They do not touch the file system.
 */

/**
 * Resolve `.` and `..` and collapse repeated slashes, like `posix.normalize`.
 * A trailing slash is kept. A relative path that climbs above its start keeps
 * its leading `..`; an absolute one cannot climb above the root. The empty
 * string is `.`.
 */
export function posixNormalize(p: string): string {
  if (p.length === 0) return ".";
  const absolute = p.startsWith("/");
  const trailing = p.endsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  let joined = out.join("/");
  if (joined.length === 0 && !absolute) joined = ".";
  if (joined.length > 0 && trailing) joined += "/";
  return (absolute ? "/" : "") + joined;
}

/** Join the parts with `/` and normalize the result, like `posix.join`. */
export function posixJoin(...parts: string[]): string {
  const nonEmpty = parts.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return ".";
  return posixNormalize(nonEmpty.join("/"));
}

/**
 * The directory part of a path, like `posix.dirname`: everything before the
 * last segment, `/` for a top-level absolute path, `.` for a bare name or an
 * empty string. Trailing slashes are ignored. Repeated slashes before the last
 * segment are kept as they are (`dirname("a//b")` is `"a/"`), because that is
 * what Node does and the test compares them.
 */
export function posixDirname(p: string): string {
  if (p.length === 0) return ".";
  const hasRoot = p.charCodeAt(0) === 47;
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; --i) {
    if (p.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // the last segment's characters have been seen
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return p.slice(0, end);
}
