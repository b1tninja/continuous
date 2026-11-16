/**
 * The lists behind protected paths (see protected.ts). Pure data and predicates,
 * all on paths already normalised by `normalizeProtectedPath` (forward slashes,
 * `~` for the home directory, `..` resolved). Sources: Claude Code's published
 * protected-directory list (code.claude.com/docs/en/permission-modes), the
 * advisories that bypassed it, and the credential files the common CLIs create.
 */

/** `~/<dir>` holds credentials: the directory and everything under it. */
export const HOME_SECRET_DIRS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".azure",
  ".docker",
  ".terraform.d",
  ".oci",
  ".config/gh",
  ".config/gcloud",
  ".config/doctl",
  ".config/hub",
]);

/** Home files that are themselves credentials. */
export const HOME_SECRET_FILES = new Set([
  ".git-credentials",
  ".pgpass",
  ".my.cnf",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".s3cfg",
  ".boto",
  ".dockercfg",
  ".vault-token",
  ".yarnrc.yml",
  ".gem/credentials",
]);

/** File names that are credentials wherever they sit. */
export const SECRET_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
  "terraform.tfstate",
  "terraform.tfstate.backup",
  "terraform.tfvars",
  "secrets.yaml",
  "secrets.yml",
  "secrets.json",
  "secret.yaml",
  "secret.yml",
]);

export const SECRET_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".jks",
  ".keystore",
  ".ppk",
  ".kdbx",
  ".tfvars",
  ".tfstate",
]);

/** Absolute system locations that hold credentials or secrets. */
const SYSTEM_SECRET = [
  /^\/etc\/(shadow|gshadow|sudoers|ssh\/ssh_host_[a-z0-9_]+_key)$/,
  /^\/etc\/sudoers\.d(\/|$)/,
  /^\/proc\/(self|thread-self|\d+)\/(mem|maps)$/,
  // Any /proc/<pid-or-thread>/environ, including task subdirectories.
  /^\/proc\/(?:[^/]+\/)+environ$/,
  /^\/(var\/)?root\/\.(ssh|aws|gnupg)(\/|$)/,
  /^\/home\/[^/]+\/\.(ssh|aws|gnupg|kube|azure|docker)(\/|$)/,
  /^\/users\/[^/]+\/\.(ssh|aws|gnupg|kube|azure|docker)(\/|$)/i,
  /^[a-z]:\/users\/[^/]+\/\.(ssh|aws|gnupg|kube|azure|docker)(\/|$)/i,
];

const ENV_TEMPLATE = /\.(example|sample|template|dist|defaults)$/i;

/**
 * Win32 ignores trailing dots and spaces on each segment, and `name:stream`
 * (an alternate data stream) is the same file as `name`. `.` and `..` are kept
 * so a relative path can still be resolved afterwards.
 */
export function stripWindowsPathAliases(p: string): string {
  const drive = /^[a-zA-Z]:/.test(p) ? p.slice(0, 2) : "";
  let rest = drive ? p.slice(2) : p;
  const colon = rest.indexOf(":");
  if (colon >= 0) rest = rest.slice(0, colon);
  return (drive + rest)
    .split("/")
    .map((seg) =>
      seg === "." || seg === ".." ? seg : seg.replace(/[. ]+$/g, ""),
    )
    .join("/");
}

/**
 * An 8.3 short name (`GITHUB~1`) inside a path. A bare `HEAD~1` has no slash.
 * A short name keeps a `-` and the other punctuation 8.3 allows
 * (`.git-credentials` is `GIT-CR~1`, `.vault-token` is `VAULT-~1`), and the
 * number grows past one digit when many names share a prefix (`GIT-C~10`).
 */
const WINDOWS_SHORT_NAME =
  /^[A-Za-z0-9_$!#%&'()@^`{}-]{1,6}~[0-9]{1,6}(?:\.[A-Za-z0-9_$!#%&'()@^`{}-]{1,3})?$/;

export function hasWindowsShortName(p: string): boolean {
  if (!p.includes("/")) return false;
  return p.split("/").some((seg) => WINDOWS_SHORT_NAME.test(seg));
}

/**
 * Path under a home directory: `~`, `/home/<user>`, `/Users/<user>`, or
 * `<drive>:/Users/<user>` (including a WSL `/mnt/<drive>` path after it is
 * rewritten to a drive path). The lists then apply to that relative path.
 */
function homeRelative(segs: string[]): string[] | undefined {
  const low = segs.map((s) => s.toLowerCase());
  if (low[0] === "~" && low.length >= 2) return low.slice(1);
  if ((low[0] === "home" || low[0] === "users") && low.length >= 3) {
    return low.slice(2);
  }
  if (/^[a-z]:$/.test(low[0] ?? "") && low[1] === "users" && low.length >= 4) {
    return low.slice(3);
  }
  return undefined;
}

/** True for `.env`, `.env.local`, `prod.env`; false for `.env.example` and `.environment`. */
function isEnvFile(base: string): boolean {
  if (ENV_TEMPLATE.test(base)) return false;
  return /^\.env(\..+)?$/.test(base) || /^[^/]+\.env$/.test(base);
}

export function isSecretPath(p: string): boolean {
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1].toLowerCase();
  if (isEnvFile(base)) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && SECRET_EXTENSIONS.has(base.slice(dot))) return true;
  if (SYSTEM_SECRET.some((re) => re.test(p))) return true;
  const rest = homeRelative(segs);
  if (!rest) return false;
  if (HOME_SECRET_FILES.has(rest.join("/"))) return true;
  for (const dir of HOME_SECRET_DIRS) {
    const d = dir.split("/");
    if (d.every((part, i) => rest[i] === part)) return true;
  }
  return false;
}

/** Directories whose contents change what runs later, or configure a tool. */
export const CONFIG_DIRS = new Set([
  ".git",
  ".continuous",
  ".continue",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
  ".claude",
  ".cursor",
  ".windsurf",
  ".cline",
  ".aider",
  ".gemini",
  ".codex",
  ".roo",
]);

/** Directory pairs, for locations that sit under a shared parent. */
export const CONFIG_DIR_PAIRS: [string, string][] = [
  [".github", "workflows"],
  [".github", "actions"],
  [".config", "git"],
  [".config", "fish"],
  [".config", "systemd"],
  ["library", "launchagents"],
  ["library", "launchdaemons"],
  [".local", "share/applications"],
];

/**
 * Files that make something run, or configure a tool that runs things, wherever they
 * sit. Deliberately NOT here: agent instruction files (AGENTS.md, CLAUDE.md,
 * .clinerules, copilot-instructions.md), which people edit constantly, and
 * .gitattributes / .gitmodules, which cannot run code on their own. A rule can
 * add any of them: writeFile(AGENTS.md) in toolPermissions.ask.
 */
export const CONFIG_BASENAMES = new Set([
  ".continuousrc.json",
  ".continuousrc.yaml",
  ".continuousrc.yml",
  ".continuerc.json",
  ".continuerc.yaml",
  ".continuerc.yml",
  ".mcp.json",
  ".envrc",
  ".pre-commit-config.yaml",
  ".gitlab-ci.yml",
  "jenkinsfile",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".gitconfig",
  ".inputrc",
  "config.fish",
]);

export function isConfigPath(p: string): boolean {
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  const low = segs.map((s) => s.toLowerCase());
  if (low.some((s) => CONFIG_DIRS.has(s))) return true;
  for (let i = 0; i + 1 < low.length; i++) {
    for (const [a, b] of CONFIG_DIR_PAIRS) {
      if (
        low[i] === a &&
        (low[i + 1] === b ||
          low
            .slice(i + 1)
            .join("/")
            .startsWith(b))
      ) {
        return true;
      }
    }
  }
  const base = low[low.length - 1];
  return base !== undefined && CONFIG_BASENAMES.has(base);
}
