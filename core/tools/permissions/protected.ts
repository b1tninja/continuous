import * as os from "node:os";
import * as posix from "node:path/posix";
import {
  hasWindowsShortName,
  isConfigPath,
  isSecretPath,
  POWERSHELL_PROFILE_VARIABLE,
  stripWindowsPathAliases,
} from "./protectedPaths";

/**
 * Paths a tool call should never touch without the user saying yes, whatever
 * the tool's setting or an allow rule says (plans/tool-auto-approval.md,
 * section 5, step 2). A hit makes the call ask. It does not refuse: a person
 * can still approve it. A deny rule is how to refuse.
 *
 * Two lists, because reading `.git/config` is not like reading `~/.aws`:
 * - SECRET paths guard credentials. They apply to every tool and to commands.
 * - CONFIG paths guard things that change what runs later (git hooks, CI,
 *   editor tasks, shell startup). They apply to writes and to commands, since
 *   a command may write; plain file reads and listings of them are fine.
 *
 * Matching ignores case (Windows and macOS volumes do) and slash direction.
 */
export type ProtectedKind =
  | "secret"
  | "config"
  | "network"
  | "private-url"
  | "fetch-and-run"
  | "mcp-definition-changed"
  | "hidden-command"
  | "env-assignment"
  | "destructive-command"
  | "large-change"
  | "dependency-change"
  | "unknown-host"
  | "file-deputy";

export interface ProtectedHit {
  kind: ProtectedKind;
  /** The path as it was matched, for the message. */
  path: string;
}

/** Home directory as a forward-slash path, for turning absolute paths into `~/...`. */
export function homeAsPosix(home: string = os.homedir()): string {
  return home.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** `~user` is that account's home, next to this one (`/home/user` or `C:/Users/user`). */
function expandTilde(p: string, home: string): string {
  const h = homeAsPosix(home);
  if (p === "~" || p.startsWith("~/")) {
    return h ? h + p.slice(1) : p;
  }
  if (/^~[^/]/.test(p)) {
    const slash = p.indexOf("/");
    const user = slash === -1 ? p.slice(1) : p.slice(1, slash);
    const rest = slash === -1 ? "" : p.slice(slash);
    const parent = h ? posix.dirname(h) : "/home";
    return `${parent}/${user}${rest}`;
  }
  return p;
}

/**
 * `/proc/<pid>/root` is the process's own filesystem root, so a path written
 * that way is the same file as the path without the prefix.
 */
function stripProcRoot(p: string): string {
  const stripped = p.replace(/^\/proc\/(?:self|\d+)\/root(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

function isAbsolutePosix(p: string): boolean {
  return p.startsWith("~") || p.startsWith("/") || /^[a-zA-Z]:\//.test(p);
}

/** A relative path is joined to the directory the command or tool runs in. */
function resolveAgainstCwd(p: string, cwd: string | undefined): string {
  if (!cwd || isAbsolutePosix(p)) return p;
  let base = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  base = base.replace(/^\/([a-zA-Z]:\/)/, "$1");
  if (!base || base.startsWith("file:")) return p;
  return posix.join(base, p);
}

function rewriteHome(p: string, home: string): string {
  const h = homeAsPosix(home);
  if (!h || p.startsWith("~")) return p;
  if (p.toLowerCase() === h.toLowerCase()) return "~";
  if (p.toLowerCase().startsWith(h.toLowerCase() + "/")) {
    return "~" + p.slice(h.length);
  }
  return p;
}

/**
 * Spellings of one file that Windows treats alike: a file URI, the long-path
 * and device prefixes (`//?/` and `//./`, and `//?/UNC/host/share` for
 * `//host/share`), and the admin share `//localhost/C$/x`, which is `C:/x`.
 * Slashes are already forward.
 */
function stripNamespacePrefixes(path: string): string {
  let p = path;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(localhost)?/i, "");
    try {
      p = decodeURIComponent(p);
    } catch {
      // Not valid percent-encoding: judge it as written.
    }
  }
  p = p.replace(/^\/\/[?.]\/UNC\//i, "//").replace(/^\/\/[?.]\//, "");
  return p.replace(
    /^\/\/(?:localhost|127\.0\.0\.1)\/([a-zA-Z])\$(?=\/|$)/i,
    (_, drive: string) => `${drive}:`,
  );
}

/**
 * Make a path comparable: forward slashes, `~` for the home dir, `.` and `..`
 * folded. Relative paths are resolved against `cwd` (the workspace, for a
 * tool call) before that, so a path that climbs out is still recognisable.
 */
export function normalizeProtectedPath(
  raw: string,
  home: string,
  cwd?: string,
): string {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return "";
  p = stripNamespacePrefixes(p);
  // A file URI's path is `/C:/Users/...`; drop the slash so it compares as a drive path.
  p = p.replace(/^\/([a-zA-Z]:\/)/, "$1");
  p = p.replace(
    /^(\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=\/|$)/i,
    "~",
  );
  p = stripWindowsPathAliases(p);
  p = expandTilde(p, home);
  p = stripProcRoot(p);
  p = resolveAgainstCwd(p, cwd);
  // Fold `.` and `..` before the home-prefix test. Doing it afterwards leaves
  // a path that climbed back into the home directory looking unrelated.
  if (!p.startsWith("~")) p = posix.normalize(p);
  // A WSL path `/mnt/c/...` is the Windows drive `c:/...`.
  p = p.replace(
    /^\/mnt\/([a-zA-Z])(?=\/|$)/,
    (_, drive: string) => `${drive}:`,
  );
  return rewriteHome(p, home);
}

/** Check one path. `kinds` says which lists apply to this kind of access. */
export function protectedPathHit(
  raw: string | undefined,
  kinds: ProtectedKind[],
  home: string = os.homedir(),
  cwd?: string,
): ProtectedHit | undefined {
  if (!raw) return undefined;
  // `$PROFILE` is a PowerShell profile (D-012), whatever it expands to
  if (
    kinds.includes("config") &&
    POWERSHELL_PROFILE_VARIABLE.test(raw.trim())
  ) {
    return { kind: "config", path: raw.trim() };
  }
  const path = normalizeProtectedPath(raw, home, cwd);
  if (!path) return undefined;
  if (kinds.includes("secret") && isSecretPath(path)) {
    return { kind: "secret", path };
  }
  if (kinds.includes("config") && isConfigPath(path)) {
    return { kind: "config", path };
  }
  // An 8.3 name can be another spelling of a protected file. Judge the path as
  // written: joining a bare revision such as HEAD~1 to the working directory
  // would make it look like a short name.
  const written = stripWindowsPathAliases(raw.trim().replace(/\\/g, "/"));
  if (hasWindowsShortName(written)) {
    if (kinds.includes("secret")) return { kind: "secret", path: written };
    if (kinds.includes("config")) return { kind: "config", path: written };
  }
  return undefined;
}

/** One line for the prompt. */
export function protectedReason(hit: ProtectedHit): string {
  if (hit.kind === "fetch-and-run") {
    return `This downloads something and runs it (${hit.path}), so it always asks first. At Automatic it is refused.`;
  }
  if (hit.kind === "hidden-command") {
    return `This runs ${hit.path}, so no rule can tell which program it is, and it always asks first.`;
  }
  if (hit.kind === "env-assignment") {
    return `This sets ${hit.path}, which changes what the command runs or where it connects, so it always asks first.`;
  }
  if (hit.kind === "destructive-command") {
    return `This is a destructive command (${hit.path}): it throws away work or rewrites history, so it always asks first.`;
  }
  if (hit.kind === "large-change") {
    return `This one edit changes a lot (${hit.path}), so it always asks first.`;
  }
  if (hit.kind === "dependency-change") {
    return `This changes what the project depends on (${hit.path}), so it always asks first.`;
  }
  if (hit.kind === "unknown-host") {
    return `This contacts ${hit.path}, which is not in your trusted domains, so it always asks first.`;
  }
  if (hit.kind === "mcp-definition-changed") {
    return hit.path.startsWith("launch definition changed")
      ? `This MCP server is started differently than when you approved it (${hit.path}), so every one of its tools asks again. Approving this call accepts the new definition.`
      : `This MCP tool's definition changed since you approved it (${hit.path}), so it asks again. Approving this call accepts the new definition.`;
  }
  if (hit.kind === "private-url") {
    return `This URL reaches a private or local address (${hit.path}), so it always asks first.`;
  }
  if (hit.kind === "network") {
    return `This touches the network path ${hit.path}. Looking it up contacts that computer, and on Windows can send your login to it, so it always asks first.`;
  }
  if (hit.kind === "file-deputy") {
    return `This reaches ${hit.path}, a place you did not point the agent at, so it always asks first.`;
  }
  return hit.kind === "secret"
    ? `This touches ${hit.path}, which can hold credentials, so it always asks first.`
    : `This touches ${hit.path}, which can change what runs later, so it always asks first.`;
}
