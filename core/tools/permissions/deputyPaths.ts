import * as os from "node:os";
import type { ProtectedHit } from "./protected";
import { normalizeProtectedPath } from "./protected";
import { hasWindowsShortName } from "./protectedPaths";

/**
 * The confused-deputy rule for the host file tools (ROADMAP piece 14). A file
 * tool acts with the IDE's or the CLI's own authority, so text that came from
 * a repository, a web page or an MCP result can steer it to a file the person
 * never meant. The protected-path lists name files that are dangerous
 * wherever they are; this module names the places a file tool should not
 * reach on a model's say-so, whatever the file is called:
 *
 * - a UNC, long-path or device path (`\\host\share`, `\\?\C:\x`, `\\.\pipe`)
 *   and a Windows device name (`CON`, `NUL`, `COM1`)
 * - an alternate data stream (`notes.txt:hidden`), a trailing dot or space,
 *   and an 8.3 short name (`PROGRA~1`): other spellings of a file
 * - `/dev`, `/proc` and `/sys`
 * - another account's home (`~root/x`)
 * - the global configuration folder, even to read: it holds keys
 * - a real path outside the workspace: a symlink or junction that leaves it,
 *   or a path written to climb out with `..`, or any absolute path elsewhere
 *
 * Pure and deterministic: the platform is a parameter, never read from the
 * host here, so a Windows spelling is judged the same on a Linux CI machine
 * and a POSIX one on Windows. A hit makes the call ask. It never refuses and
 * never loosens: the caller applies it after the tool's own check, and only
 * IDGAF or the person's own `builtin` switch reaches past it.
 */
export type PathFlavor = "win32" | "posix";

export type DeputyKind =
  | "device"
  | "network"
  | "alias"
  | "other-account"
  | "own-config"
  | "outside-workspace";

export interface DeputyHit extends ProtectedHit {
  kind: "file-deputy";
  /** Which sub-rule fired, so the caller can tell a switchable rule from a floor. */
  why: DeputyKind;
}

export interface DeputyInput {
  /** The path as the model wrote it. */
  raw: string | undefined;
  /** The real path the tool resolved (symlinks followed), when it did. */
  resolved?: string;
  flavor: PathFlavor;
  home?: string;
  /** The workspace folder; relative paths are resolved against it. */
  cwd?: string;
  /**
   * Every workspace folder, for a window with several roots: a path inside
   * any of them is inside the workspace. `cwd` (the first) still resolves
   * relative paths.
   */
  roots?: readonly string[];
  /** The tool's own answer: is the real path inside a workspace folder? */
  withinWorkspace?: boolean;
  /** Normalised global product folders (selfProtect.globalDirsFor). */
  globalDirs?: readonly string[];
}

/** The host's flavor, for the one place that must pick one. */
export const hostFlavor = (): PathFlavor =>
  process.platform === "win32" ? "win32" : "posix";

/** Reserved DOS device names, with or without an extension (`NUL.txt` is NUL). */
const DEVICE_NAME =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

function isDeviceSegment(seg: string): boolean {
  const base = seg.split(/[.:]/, 1)[0].replace(/[ ]+$/, "");
  return DEVICE_NAME.test(base);
}

const fwd = (p: string) => p.replace(/\\/g, "/");

/** True for `\\host\share`, `//host/share`, `\\?\...` and `\\.\...` (Windows only). */
function isUncOrNamespace(p: string): boolean {
  return /^[\\/]{2}/.test(p) && !/^[\\/]{3}/.test(p);
}

function fileUriHost(p: string): string | undefined {
  const m = /^file:\/\/([^/]*)/i.exec(p);
  if (!m) return undefined;
  return m[1] === "" || /^localhost$/i.test(m[1]) ? undefined : m[1];
}

/** A local file URI's path (`file:///C:/x` is `C:/x`); anything else as written. */
function localPathOf(p: string): string {
  if (!/^file:\/\//i.test(p)) return p;
  let rest = p.replace(/^file:\/\/(localhost)?/i, "");
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Not valid percent-encoding: judge it as written.
  }
  return rest.replace(/^\/([a-zA-Z]:)/, "$1");
}

/** Spellings that are not the file they appear to name, judged on the text alone. */
function spellingHit(
  raw: string,
  flavor: PathFlavor,
): { why: DeputyKind; text: string } | undefined {
  const host = fileUriHost(raw);
  if (host) return { why: "network", text: `a file URI on ${host}` };
  if (/^~[^/\\]/.test(raw)) {
    return { why: "other-account", text: `another account's home (${raw})` };
  }
  const p = fwd(localPathOf(raw.trimStart()));
  if (/^\/(dev|proc|sys)(\/|$)/.test(p)) {
    return { why: "device", text: `${p}, a device or process file` };
  }
  if (flavor === "posix") return undefined;
  if (isUncOrNamespace(raw.trim())) {
    return { why: "network", text: `${p}, a network or device path` };
  }
  const segs = p.replace(/^[a-zA-Z]:/, "").split("/");
  if (segs.some(isDeviceSegment)) {
    return { why: "device", text: `${p}, a Windows device name` };
  }
  if (/^[a-zA-Z]:/.test(p) ? p.slice(2).includes(":") : p.includes(":")) {
    return { why: "alias", text: `${p}, an alternate data stream` };
  }
  if (segs.some((s) => s !== "." && s !== ".." && /[. ]+$/.test(s))) {
    return {
      why: "alias",
      text: `${p}, a name Windows reads without its trailing dot or space`,
    };
  }
  if (hasWindowsShortName(p)) {
    return { why: "alias", text: `${p}, an 8.3 short name` };
  }
  return undefined;
}

const segmentsOf = (p: string): string[] =>
  p.split("/").filter((s) => s !== "" && s !== ".");

/** Is `p` the folder `root` or inside it? Case is folded only where the platform folds it. */
function insideFolder(p: string, root: string, flavor: PathFlavor): boolean {
  const fold = (s: string) => (flavor === "win32" ? s.toLowerCase() : s);
  const a = segmentsOf(p).map(fold);
  const b = segmentsOf(root).map(fold);
  return b.length > 0 && b.every((s, i) => a[i] === s);
}

/** A normalised path that can be compared: absolute, or `~`-relative. */
const comparable = (p: string) =>
  p.startsWith("~") || p.startsWith("/") || /^[a-zA-Z]:\//.test(p);

function outsideLexically(
  raw: string,
  home: string,
  cwd: string,
  flavor: PathFlavor,
  others: readonly string[] = [],
): boolean {
  const target = normalizeProtectedPath(raw, home, cwd);
  const roots = [cwd, ...others].map((r) => normalizeProtectedPath(r, home));
  if (!comparable(target) || !comparable(roots[0])) return false;
  return !roots.some((r) => comparable(r) && insideFolder(target, r, flavor));
}

/**
 * The first place this path reaches that a file tool should not reach unasked,
 * or undefined. `access` does not change the answer: a read of a place is as
 * much a leak as a write is a change.
 */
export function deputyPathHit(input: DeputyInput): DeputyHit | undefined {
  const { raw, flavor } = input;
  if (!raw?.trim()) return undefined;
  const home = input.home ?? os.homedir();
  const spelled = spellingHit(raw, flavor);
  if (spelled) {
    return { kind: "file-deputy", why: spelled.why, path: spelled.text };
  }
  const normalized = normalizeProtectedPath(
    input.resolved ?? raw,
    home,
    input.cwd,
  );
  // The written path too: a tool may resolve `~` as a folder of the workspace.
  const written = normalizeProtectedPath(raw, home, input.cwd);
  const root = input.cwd ? normalizeProtectedPath(input.cwd, home) : undefined;
  for (const dir of input.globalDirs ?? []) {
    // A workspace that is itself inside the folder (this product's own
    // checkout) is the person's choice of where to work.
    if (root && insideFolder(root, dir, flavor)) continue;
    const inDir = [written, normalized].find((p) =>
      insideFolder(p, dir, flavor),
    );
    if (inDir) {
      return {
        kind: "file-deputy",
        why: "own-config",
        path: `${inDir}, your global configuration folder`,
      };
    }
  }
  const outside =
    input.withinWorkspace === false ||
    (input.withinWorkspace === undefined &&
      input.cwd !== undefined &&
      outsideLexically(raw, home, input.cwd, flavor, input.roots));
  return outside
    ? {
        kind: "file-deputy",
        why: "outside-workspace",
        path: `${normalized}, outside the workspace`,
      }
    : undefined;
}
