import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import * as YAML from "yaml";
import { getContinueGlobalPath } from "../../util/paths";

/**
 * Folders the person added to the workspace for the "outside the workspace"
 * check, read from their own config.yaml:
 *
 *   toolPermissions:
 *     auto:
 *       environment:
 *         additionalFolders: ["~/src/shared-lib", "D:/work/docs"]
 *
 * In the usage data 35% of file-tool calls (340 of 979) were flagged as outside
 * the workspace because the person works across sibling repositories, so every
 * read in the next repository looked like a visitor's.
 *
 * Read from that file and no other, like largeChangeLines (userLimits.ts): a
 * folder a repository could add would let a checked-in file widen its own
 * reach. The key is in UNTRUSTED_LOOSENING_KEYS (trust.ts). A folder counts as
 * workspace for the "outside" question only. It lifts none of the protections
 * that do not depend on it: secret files, files that change what runs later,
 * and the locked policy files are judged by name, wherever they sit.
 */
export interface RejectedFolder {
  value: string;
  reason: string;
}

export interface ParsedFolders {
  folders: string[];
  rejected: RejectedFolder[];
}

/** More than this is a sign of a mistake, not a project. */
export const MAX_ADDITIONAL_FOLDERS = 20;

export interface FolderFacts {
  home: string;
  /** Follows links; throws when the path does not exist. */
  realpath?: (p: string) => string;
  isDirectory?: (p: string) => boolean;
  path?: Pick<
    typeof nodePath,
    "resolve" | "relative" | "isAbsolute" | "sep" | "parse" | "normalize"
  >;
  /** The folders the product keeps its own files in; never a workspace. */
  protectedRoots?: readonly string[];
}

const defaultRealpath = (p: string) => fs.realpathSync.native(p);
const defaultIsDirectory = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function expandHome(
  value: string,
  home: string,
  path: Pick<typeof nodePath, "resolve">,
): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    // Either slash after ~; the rest is joined with the path rules in use
    return path.resolve(home, value.slice(2).replace(/[\\/]+/g, "/"));
  }
  return value;
}

/** True when `child` is `root` or below it. */
function inside(
  root: string,
  child: string,
  path: Pick<typeof nodePath, "relative" | "isAbsolute" | "sep">,
): boolean {
  const rel = path.relative(root, child);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * The valid folders in a config value, with the reason each other entry was
 * left out. An entry is left out when it is not an absolute path (or `~/...`),
 * does not exist, is not a folder, is a drive root or the filesystem root, or
 * is the home folder or a folder that contains it: those would make "outside
 * the workspace" mean nothing. The product's own folders are left out too.
 */
export function parseAdditionalFolders(
  value: unknown,
  facts: FolderFacts,
): ParsedFolders {
  const path = facts.path ?? nodePath;
  const realpath = facts.realpath ?? defaultRealpath;
  const isDirectory = facts.isDirectory ?? defaultIsDirectory;
  const folders: string[] = [];
  const rejected: RejectedFolder[] = [];
  if (value === undefined || value === null) return { folders, rejected };
  if (!Array.isArray(value)) {
    return {
      folders,
      rejected: [{ value: String(value), reason: "it is not a list" }],
    };
  }
  const home = (() => {
    try {
      return realpath(facts.home);
    } catch {
      return facts.home;
    }
  })();
  const own = (facts.protectedRoots ?? []).map((r) => {
    try {
      return realpath(r);
    } catch {
      return r;
    }
  });
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string" || raw.trim() === "") {
      rejected.push({ value: String(raw), reason: "it is not a path" });
      continue;
    }
    const text = raw.trim();
    const expanded = expandHome(text, facts.home, path);
    if (!path.isAbsolute(expanded)) {
      rejected.push({ value: text, reason: "it is not an absolute path" });
      continue;
    }
    let real: string;
    try {
      real = realpath(path.resolve(expanded));
    } catch {
      rejected.push({ value: text, reason: "it does not exist" });
      continue;
    }
    if (!isDirectory(real)) {
      rejected.push({ value: text, reason: "it is not a folder" });
      continue;
    }
    const root = path.parse(real).root;
    if (real === root) {
      rejected.push({
        value: text,
        reason: "it is a drive or filesystem root",
      });
      continue;
    }
    if (inside(real, home, path)) {
      rejected.push({
        value: text,
        reason: "it is the home folder or a folder that contains it",
      });
      continue;
    }
    if (own.some((r) => inside(r, real, path) || inside(real, r, path))) {
      rejected.push({
        value: text,
        reason: "it holds the product's own files",
      });
      continue;
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    if (folders.length >= MAX_ADDITIONAL_FOLDERS) {
      rejected.push({
        value: text,
        reason: `only ${MAX_ADDITIONAL_FOLDERS} folders are used`,
      });
      continue;
    }
    folders.push(real);
  }
  return { folders, rejected };
}

/**
 * `dirs` with the additional folders appended, in the form `dirs` uses: file
 * URIs when the first entry is one (the IDE), plain paths otherwise (the CLI).
 * Nothing is added twice. The first entry stays first, so the folder commands
 * run in does not change.
 */
export function withAdditionalFolders(
  dirs: readonly string[],
  folders: readonly string[],
): string[] {
  if (folders.length === 0) return [...dirs];
  const asUris = dirs.length > 0 && dirs[0].includes("://");
  const fold = typeof process !== "undefined" && process.platform === "win32";
  const key = (s: string) => (fold ? s.toLowerCase() : s);
  const present = new Set(dirs.map(key));
  const out = [...dirs];
  for (const folder of folders) {
    const form = asUris ? pathToFileURL(folder).href : folder;
    if (present.has(key(form)) || present.has(key(folder))) continue;
    present.add(key(form));
    out.push(form);
  }
  return out;
}

/** Where the CLI started, plus the folders the person added to the workspace. */
export function dirsWithAddedFolders(startedIn?: string): string[] {
  return withAdditionalFolders(
    [startedIn ?? process.cwd()],
    readUserAdditionalFolders(),
  );
}

// ---------------------------------------------------------------------------
// The person's config.yaml

interface Cached {
  mtimeMs: number;
  size: number;
  value: string[];
}
const cache = new Map<string, Cached>();

export function readUserAdditionalFolders(
  file = nodePath.join(getContinueGlobalPath(), "config.yaml"),
): string[] {
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const root = YAML.parse(
      fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
    );
    const { folders } = parseAdditionalFolders(
      root?.toolPermissions?.auto?.environment?.additionalFolders,
      { home: os.homedir(), protectedRoots: [getContinueGlobalPath()] },
    );
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value: folders });
    return folders;
  } catch {
    cache.delete(file);
    return [];
  }
}

export function clearAdditionalFoldersCacheForTests(): void {
  cache.clear();
}
