import {
  CONFIG_BASENAMES,
  CONFIG_DIRS,
  CONFIG_DIR_PAIRS,
} from "../tools/permissions/protectedPaths";
import type {
  NotEnforcedItem,
  SandboxPlatform,
  SandboxReadPolicy,
} from "./sandboxPolicyTypes";

/**
 * Lists and fixed text for the sandbox policy compiler. Data only. The path
 * lists that decide what is a secret or what runs later live in
 * `core/tools/permissions/protectedPaths.ts` and are imported, not copied: a
 * drift test pins that every entry there is covered here.
 */

/**
 * Directories the permission engine treats as "what runs later" as a whole,
 * but where denying all writes would break the tool. Only the parts that run
 * code are write-protected at the OS layer.
 */
export const NARROWED_CONFIG_DIRS: Readonly<Record<string, readonly string[]>> =
  {
    // `git commit` writes the index and objects under .git
    ".git": [".git/hooks", ".git/config", ".git/config.worktree"],
    // yarn install writes the cache; the release and plugins are what runs
    ".yarn": [".yarn/releases", ".yarn/plugins"],
  };

/** The on-disk spelling where the protected list is lower case. */
export const CANONICAL_CASE: Readonly<Record<string, string>> = {
  jenkinsfile: "Jenkinsfile",
  "library/launchagents": "Library/LaunchAgents",
  "library/launchdaemons": "Library/LaunchDaemons",
};

/**
 * The `protect-config` list as paths relative to a writable root, in the
 * spelling on disk: every CONFIG_DIRS entry (narrowed where the whole
 * directory cannot be locked), the `.github` pairs, and every
 * CONFIG_BASENAMES entry (also returned alone as `bases`). The OS sandbox
 * and the container executor both read it, so the two protect the same list.
 */
export function protectedConfigRels(): { rels: string[]; bases: string[] } {
  const rels: string[] = [];
  const bases: string[] = [];
  for (const dir of CONFIG_DIRS) {
    for (const r of NARROWED_CONFIG_DIRS[dir] ?? [dir]) rels.push(r);
  }
  for (const [a, b] of CONFIG_DIR_PAIRS) {
    // The other pairs live in the home directory, which is never writable here
    if (a === ".github") {
      const joined = `${a}/${b}`;
      rels.push(CANONICAL_CASE[joined] ?? joined);
    }
  }
  for (const base of CONFIG_BASENAMES) {
    const r = CANONICAL_CASE[base] ?? base;
    rels.push(r);
    bases.push(r);
  }
  return { rels, bases };
}

/**
 * `.env` names a glob can cover without also hiding `.env.example`, which the
 * protected-path rule deliberately leaves readable. Other `.env.<name>` files
 * are listed as not enforced.
 */
export const ENV_GLOBS: readonly string[] = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.staging",
  ".env.test",
  "*.env",
];

/** Absolute system secrets (protectedPaths.ts SYSTEM_SECRET, as paths). */
export const SYSTEM_SECRET_PATHS: readonly string[] = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/ssh/ssh_host_*_key",
];

/** Our own configuration directories in the home directory: keys and rules. */
export const OWN_HOME_DIRS: readonly string[] = [".continuous", ".continue"];

/** macOS only: where credentials live outside the dotfile convention. */
export const MACOS_HOME_SECRETS: readonly string[] = [
  "Library/Keychains",
  // Browser profiles: saved logins, cookies and session tokens
  "Library/Cookies",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
];

/**
 * Linux and WSL2: the desktop credential stores in the home directory (GNOME
 * Keyring and libsecret, KWallet, `pass`). S9-X3: denied with the sandbox on.
 */
export const LINUX_HOME_SECRETS: readonly string[] = [
  ".local/share/keyrings",
  ".local/share/kwalletd",
  ".password-store",
  // Browser profiles: saved logins, cookies and session tokens
  ".mozilla/firefox",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".config/microsoft-edge",
  ".config/1Password",
];

/**
 * A project's policy folders: rules, permissions, hooks and keys the product
 * loads. S9-X3: a sandboxed command neither reads nor writes them (writes are
 * also locked by `protect-config` and the locked paths). Their `plans/`
 * folder is allowed back for reads.
 */
export const PROJECT_POLICY_DIRS: readonly string[] = [
  ".continuous",
  ".continue",
];

/**
 * S9-X3's short allow list: home files a sandboxed command may read although
 * the protected lists name them (`.npmrc` is a credential file there). They
 * stay write-protected. Reading `~/.npmrc` through a tool, or with a command
 * that reads it, still marks the session as having read a secret, so the
 * secret-read plus network pair (B92) applies to what follows.
 */
export const HOME_READ_ALLOWED: readonly string[] = [".gitconfig", ".npmrc"];

/**
 * Roots denied under `workspace-only`, with the workspace and the temp dir
 * allowed back. `/mnt` is also denied under `open` on WSL2.
 */
export const BROAD_DENY_READ: Readonly<
  Record<SandboxPlatform, readonly string[]>
> = {
  linux: ["/home", "/root", "/run", "/var/run"],
  wsl2: ["/home", "/root", "/run", "/var/run", "/mnt"],
  macos: ["/Users", "/Volumes", "/private/var/root"],
};

/** System temp roots: writable through them reaches every program's files. */
export const SYSTEM_TEMP_ROOTS: readonly string[] = [
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  "/private/tmp",
  "/private/var/tmp",
];

/** System directories that must never be writable. */
export const SYSTEM_DIRS: readonly string[] = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/var/lib",
  "/var/log",
  "/var/run",
  "/var/spool",
  "/proc",
  "/sys",
  "/dev",
  "/System",
  "/Library",
  "/Applications",
];

/**
 * Files a placeholder can stand in for without changing what a tool does:
 * an empty file is valid for each. An empty `.mcp.json` or
 * `.pre-commit-config.yaml` is not, so they are never pre-created.
 */
export const PRECREATE_SAFE: readonly string[] = [
  ".envrc",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".inputrc",
  ".gitconfig",
];

/** macOS: `/tmp`, `/var` and `/etc` are symlinks into `/private`. */
export const MACOS_PRIVATE_ALIASED: readonly string[] = [
  "/tmp",
  "/var",
  "/etc",
];

const ITEM = (id: string, item: string, why: string, mitigation: string) =>
  ({ id, item, why, mitigation }) satisfies NotEnforcedItem;

export function notEnforcedItems(
  platform: SandboxPlatform,
  readPolicy: SandboxReadPolicy,
): NotEnforcedItem[] {
  const out: NotEnforcedItem[] = [
    ITEM(
      "created-later",
      "Files and directories created after the sandbox starts",
      "srt builds its write protection once, when it wraps a command, from paths that exist then (globs are expanded by a scan, to a depth). A protected name created later, or in a place no entry names, is writable: measured `sub/.vscode/tasks.json` and `a/b/c/d/e/.bashrc` written inside the jail.",
      "absolute entries for the expected locations, glob entries for the nested ones, and an optional pre-create step for harmless placeholder files; host tools treat files a command created as untrusted (W8b)",
    ),
    ITEM(
      "variable-built-paths",
      "Paths built at run time (a variable, a substitution, a computed name)",
      "The OS layer judges the path the command finally opens, so a path inside the write scope is writable whatever it was built from, and a path outside it is not. A path the rules name only by pattern is protected only where an entry above reaches it.",
      "the write scope and the read policy bound what a built path can reach; the analyser treats such a command as unsure",
    ),
    ITEM(
      "host-environment",
      "Environment variables of the host",
      "srt does not scrub the environment (measured: a host variable, HOME and WSL_INTEROP were visible inside).",
      "terminalEnvironment() must build the environment before srt wraps the command (`continuous terminal-env show`)",
    ),
    ITEM(
      "network-tunnelling",
      "Exfiltration through an allowed host",
      "The filter is by domain name only: no traffic inspection, domain fronting may pass, and an allowed host that accepts uploads from anyone (a code host, a bucket) lets data leave.",
      "keep the list short; the egress proxy (W6f) resolves and pins addresses but does not read requests",
    ),
    ITEM(
      "dns-exfiltration",
      "Data carried in DNS names",
      "Names are resolved by the proxy on the host; a name under an allowed domain can carry data to its name server.",
      "none",
    ),
    ITEM(
      "allowed-ports",
      "Ports of an allowed host",
      "A domain entry without a port allows every port of that host; our rule without a port means 443 and 80. A `deniedDomains` entry without a port denies every port.",
      "none in this config",
    ),
    ITEM(
      "resource-limits",
      "CPU, memory, process count and disk quota",
      "srt documents no cgroup, pids or memory limit.",
      "none here; the container executor sets them",
    ),
    ITEM(
      "symlinks-and-hardlinks",
      "Links made inside the jail and followed outside it",
      "Writes inside the jail are judged where they land (measured), but an unjailed host tool that later follows a symlink or opens a hard-linked file made by a command is a confused deputy; a file outside the write scope that already has a hard link inside it stays writable through it.",
      "host file tools refuse a realpath that leaves the workspace (W8b)",
    ),
    ITEM(
      "host-executed",
      "File tools, MCP servers and hooks",
      "They run on the host, outside the sandbox, and are subject to policy only.",
      "the permission engine, not this config",
    ),
    ITEM(
      "other-env-files",
      "`.env.<name>` files other than the listed names",
      "A glob for every `.env.*` would also hide `.env.example`, which the protected-path rule leaves readable.",
      "the listed names are denied; add a deny rule for any other name",
    ),
    ITEM(
      "shared-kernel",
      "A kernel or namespace bug, and a host binary that runs a file later",
      "The jail shares the host kernel and runs the host's own bash, git and node.",
      "none; this is why the claim waits for our probes",
    ),
  ];
  out.push(
    ITEM(
      "allowed-home-reads",
      "`~/.gitconfig` and `~/.npmrc` are readable",
      "The decided allow list (S9-X3): git and npm read them on every run. `~/.npmrc` can hold a registry token, so a command in the jail can read that token.",
      "a read of `~/.npmrc` by a tool, or by a command that reads or sends it (`cat`, `curl -d @`), marks the session as having read a secret, and a network call after it asks at every level and is refused at IDGAF (B92); a read npm makes on its own is not seen",
    ),
  );
  if (readPolicy === "open") {
    out.push(
      ITEM(
        "open-reads",
        "Files outside the write scope that are not listed",
        "With reads open, every file the user can read is readable inside the jail, including a `.env` in a parent of the workspace and system files.",
        "use `workspace-only` reads, which deny the home and system roots",
      ),
    );
  }
  if (platform === "wsl2") {
    out.push(
      ITEM(
        "wsl-mnt-drives",
        "The Windows drives under /mnt",
        "/mnt is denied for reads, but the deny is built when a command is wrapped, and the drives are 9p mounts (measured: /mnt/c/Users was readable with no deny).",
        "a dedicated distribution with automount and interop off (W9) makes it moot",
      ),
      ITEM(
        "wsl-interop",
        "WSL interop and the Windows PATH",
        "`cmd.exe` failed inside the jail only because the AF_VSOCK seccomp rule blocks it, which is not a designed WSL control; WSL_INTEROP stays in the environment and all distributions share one VM.",
        "scrub the environment; the dedicated distribution form with interop off",
      ),
    );
  }
  if (platform === "macos") {
    out.push(
      ITEM(
        "macos-seatbelt",
        "Seatbelt profile gaps",
        "Case-insensitive volumes (`.ENV` is `.env`) are not folded by these entries; srt open issues name a literal `[...]` path compiling to a non-matching rule (#576), an intra-workspace symlink write-deny omission (#790) and location-independent globs anchored to the cwd (#432); sandbox-exec is deprecated. Not tested here (no macOS machine).",
        "paths with glob characters are refused; re-run the probes on macOS before relying on it",
      ),
    );
  }
  return out;
}
