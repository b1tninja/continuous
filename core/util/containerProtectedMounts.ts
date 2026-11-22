import { readdirSync, type Dirent } from "node:fs";
import * as path from "node:path";
import { containerWorkdir, type ReadOnlyMount } from "./containerArgs";
import { protectedConfigRels } from "./sandboxPolicyData";

/**
 * More than the whole list can produce on a file system that ignores case
 * (about 50). It bounds the command line on one that does not, where `.vscode`
 * and `.VSCode` are two folders. Past it the list's own order decides what is
 * kept: the directories first, then the single files.
 */
export const MAX_READ_ONLY_MOUNTS = 64;

/**
 * The parts of the workspace a command in the container must not change,
 * because the host runs or trusts them later: the `protect-config` list
 * (`protectedConfigRels`, the same one the OS sandbox denies writes to), so
 * `.git/hooks`, `.git/config`, `.vscode`, `.idea`, `.devcontainer`,
 * `.github/workflows`, `.envrc`, `.mcp.json` and the rest. The permission
 * engine asks before a tool writes them, but it cannot see what a command
 * does inside the container, where the workspace is mounted read-write.
 *
 * The rule: each entry of the list is looked up at its one place under the
 * workspace root (`<root>/.vscode`, `<root>/.git/hooks`), by reading the
 * folders on the way to it. The tree is not walked. Names are matched without
 * regard to case, as the engine does, and mounted in the spelling on disk.
 *
 * Only what exists is mounted. A path that is not there is not created: that
 * would put a `.vscode` in every workspace, and the runtime would have to
 * create the mount point through the read-write mount. So this leaves open:
 * - a path on the list that does not exist yet: a command can create it;
 * - the same names deeper in the tree (`packages/a/.vscode`, a submodule's
 *   hooks under `.git/modules`): not looked for;
 * - a symbolic link at one of these places: skipped, because the runtime
 *   would mount what it points at, which may be outside the workspace;
 * - a workspace that sits inside a protected folder (`.claude/worktrees/x`):
 *   it stays writable, as it does for the OS sandbox, and the entries of the
 *   list inside it are still mounted read-only.
 *
 * Two shapes are covered beyond the plain lookup. A file where the list
 * expects a folder is itself mounted read-only: `.git` in a git worktree is
 * a file naming the real git folder, and rewriting it changes which hooks
 * run. And when the workspace is the first part of an entry (the workspace is
 * a `.git` or a `.github` folder), the rest of the entry is looked up in it.
 *
 * Reads the file system and changes nothing.
 */
export function protectedMounts(
  cwd: string,
  opts: { platform?: NodeJS.Platform; max?: number } = {},
): ReadOnlyMount[] {
  const platform = opts.platform ?? process.platform;
  const max = opts.max ?? MAX_READ_ONLY_MOUNTS;
  const sep = platform === "win32" ? "\\" : "/";
  const root = cwd.replace(/[\\/]+$/, "") || cwd;
  const workdir = containerWorkdir(root, platform).replace(/\/+$/, "");
  const cwdSegments = root
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  const listings = new Map<string, Dirent[]>();
  const list = (dir: string): Dirent[] => {
    let entries = listings.get(dir);
    if (!entries) {
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // Not readable: nothing to protect that a mount could name
        entries = [];
      }
      listings.set(dir, entries);
    }
    return entries;
  };

  const found = new Map<string, ReadOnlyMount>();
  const add = (names: string[]) => {
    const container = `${workdir}/${names.join("/")}`;
    if (found.size < max && !found.has(container)) {
      found.set(container, {
        host: `${root}${sep}${names.join(sep)}`,
        container,
      });
    }
  };
  const lookUp = (names: string[], rest: string[]) => {
    const [next, ...after] = rest;
    for (const entry of list(path.join(root, ...names))) {
      if (entry.name.toLowerCase() !== next.toLowerCase()) continue;
      if (entry.isSymbolicLink()) continue;
      const here = [...names, entry.name];
      if (entry.isDirectory() && after.length > 0) lookUp(here, after);
      else if (entry.isDirectory() || entry.isFile()) add(here);
    }
  };

  for (const rel of protectedConfigRels().rels) {
    const segments = rel.split("/");
    lookUp([], segments);
    // The workspace is itself the start of the entry (`<repo>/.git`)
    for (let k = 1; k < segments.length; k++) {
      const head = segments.slice(0, k).map((s) => s.toLowerCase());
      if (head.every((s, i) => cwdSegments[cwdSegments.length - k + i] === s)) {
        lookUp([], segments.slice(k));
      }
    }
  }
  return [...found.values()];
}
