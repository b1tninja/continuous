/**
 * The security patterns the indexer and the `@` file picker exclude, kept free
 * of `fs` and `path` so the webview can use them too (a dropped file is checked
 * against the same list before anything reads it). `ignore.ts` re-exports both
 * arrays, so existing imports keep working.
 */
import ignore from "ignore";

// Security-focused ignore patterns - these should always be excluded for security reasons
export const DEFAULT_SECURITY_IGNORE_FILETYPES = [
  // Environment and configuration files with secrets
  "*.env",
  "*.env.*",
  ".env*",
  "config.json",
  "config.yaml",
  "config.yml",
  "settings.json",
  "appsettings.json",
  "appsettings.*.json",

  // Certificate and key files
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  "*.jks",
  "*.keystore",
  "*.truststore",

  // Database files that may contain sensitive data
  "*.db",
  "*.sqlite",
  "*.sqlite3",
  "*.mdb",
  "*.accdb",

  // Credential and secret files
  "*.secret",
  "*.secrets",
  "auth.json",
  "*.token",

  // Backup files that might contain sensitive data
  "*.bak",
  "*.backup",
  "*.old",
  "*.orig",

  // Docker secrets
  "docker-compose.override.yml",
  "docker-compose.override.yaml",

  // SSH and GPG
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.ppk",
  "*.gpg",
];

export const DEFAULT_SECURITY_IGNORE_DIRS = [
  // Environment and configuration directories
  ".env/",
  "env/",

  // Cloud provider credential directories
  ".aws/",
  ".gcp/",
  ".azure/",
  ".kube/",
  ".docker/",

  // Secret directories
  "secrets/",
  ".secrets/",
  "private/",
  ".private/",
  "certs/",
  "certificates/",
  "keys/",
  ".ssh/",
  ".gnupg/",
  ".gpg/",

  // Temporary directories that might contain sensitive data
  "tmp/secrets/",
  "temp/secrets/",
  ".tmp/",
];

const securityIgnores = ignore()
  .add(DEFAULT_SECURITY_IGNORE_FILETYPES)
  .add(DEFAULT_SECURITY_IGNORE_DIRS);

/**
 * True when a relative, forward-slash path matches a security pattern. Pure:
 * it never touches the file system. A path that is empty, absolute or climbs
 * with `..` is not something the patterns can judge and returns false; the
 * caller decides what that means (the drop guard treats it as outside the
 * workspace). A path the `ignore` library rejects counts as a hit.
 */
export function securityPatternHit(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return false;
  }
  try {
    return securityIgnores.ignores(normalized);
  } catch {
    return true;
  }
}
