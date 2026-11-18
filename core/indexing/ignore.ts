import fs from "fs";
import ignore from "ignore";

import path from "path";
import { fileURLToPath } from "url";
import { ContinueError, ContinueErrorReason } from "../util/errors";
import {
  DEFAULT_SECURITY_IGNORE_DIRS,
  DEFAULT_SECURITY_IGNORE_FILETYPES,
} from "./securityPatterns";

// The security patterns live in a pure module (no fs or path) so the webview
// can check a dropped file against the same list as the indexer.
export { DEFAULT_SECURITY_IGNORE_DIRS, DEFAULT_SECURITY_IGNORE_FILETYPES };

// Additional non-security patterns for general indexing exclusion
export const ADDITIONAL_INDEXING_IGNORE_FILETYPES = [
  "*.DS_Store",
  "*-lock.json",
  "*.lock",
  "*.log",
  "*.ttf",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.mp4",
  "*.svg",
  "*.ico",
  "*.pdf",
  "*.zip",
  "*.gz",
  "*.tar",
  "*.dmg",
  "*.tgz",
  "*.rar",
  "*.7z",
  "*.exe",
  "*.dll",
  "*.obj",
  "*.o",
  "*.o.d",
  "*.a",
  "*.lib",
  "*.so",
  "*.dylib",
  "*.ncb",
  "*.sdf",
  "*.woff",
  "*.woff2",
  "*.eot",
  "*.cur",
  "*.avi",
  "*.mpg",
  "*.mpeg",
  "*.mov",
  "*.mp3",
  "*.mkv",
  "*.webm",
  "*.jar",
  "*.onnx",
  "*.parquet",
  "*.pqt",
  "*.wav",
  "*.webp",
  "*.wasm",
  "*.plist",
  "*.profraw",
  "*.gcda",
  "*.gcno",
  "go.sum",
  "*.gitignore",
  "*.gitkeep",
  "*.continuousignore",
  "*.continueignore",
  "*.csv",
  "*.uasset",
  "*.pdb",
  "*.bin",
  "*.pag",
  "*.swp",
  "*.jsonl",
  // "*.prompt", // can be incredibly confusing for the LLM to have another set of instructions injected into the prompt
  // Application specific
  ".continuous/",
  ".continue/",
];

export const ADDITIONAL_INDEXING_IGNORE_DIRS = [
  ".git/",
  ".svn/",
  "node_modules/",
  "dist/",
  "build/",
  "Build/",
  "target/",
  "out/",
  "bin/",
  ".pytest_cache/",
  ".vscode-test/",
  "__pycache__/",
  "site-packages/",
  ".gradle/",
  ".mvn/",
  ".cache/",
  "gems/",
  "vendor/",

  ".venv/",
  "venv/",

  ".vscode/",
  ".idea/",
  ".vs/",
];

// Combined patterns: security + additional
export const DEFAULT_IGNORE_FILETYPES = [
  ...DEFAULT_SECURITY_IGNORE_FILETYPES,
  ...ADDITIONAL_INDEXING_IGNORE_FILETYPES,
];

export const DEFAULT_IGNORE_DIRS = [
  ...DEFAULT_SECURITY_IGNORE_DIRS,
  ...ADDITIONAL_INDEXING_IGNORE_DIRS,
];

export const DEFAULT_IGNORES = [
  ...DEFAULT_IGNORE_FILETYPES,
  ...DEFAULT_IGNORE_DIRS,
];

export const defaultIgnoresGlob = `!{${DEFAULT_IGNORES.join(",")}}`;

// Create ignore instances
export const defaultSecurityIgnoreFile = ignore().add(
  DEFAULT_SECURITY_IGNORE_FILETYPES,
);
export const defaultSecurityIgnoreDir = ignore().add(
  DEFAULT_SECURITY_IGNORE_DIRS,
);
export const defaultIgnoreFile = ignore().add(DEFAULT_IGNORE_FILETYPES);
export const defaultIgnoreDir = ignore().add(DEFAULT_IGNORE_DIRS);

// String representations
export const DEFAULT_SECURITY_IGNORE =
  DEFAULT_SECURITY_IGNORE_FILETYPES.join("\n") +
  "\n" +
  DEFAULT_SECURITY_IGNORE_DIRS.join("\n");

export const DEFAULT_IGNORE =
  DEFAULT_IGNORE_FILETYPES.join("\n") + "\n" + DEFAULT_IGNORE_DIRS.join("\n");

// Combined ignore instances
export const defaultFileAndFolderSecurityIgnores = ignore()
  .add(defaultSecurityIgnoreFile)
  .add(defaultSecurityIgnoreDir);

export const defaultIgnoreFileAndDir = ignore()
  .add(defaultIgnoreFile)
  .add(defaultIgnoreDir);

function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || p.startsWith("\\\\");
}

/** True when `target` is `root` or a file inside it. */
function isInsideDir(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return (
    rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../")
  );
}

function patternHit(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.split("/").includes("..") ||
    isAbsolutePath(normalized)
  ) {
    return false;
  }
  try {
    return defaultFileAndFolderSecurityIgnores.ignores(normalized);
  } catch {
    // The ignore library rejects some paths. Those are treated as a concern.
    return true;
  }
}

/**
 * A secret file, or a relative path that leaves `workspaceRoot` (the working
 * directory when omitted). The path is resolved, and a symlink is followed,
 * before either check.
 */
export function isSecurityConcern(
  filePathOrUri: string,
  workspaceRoot?: string,
): boolean {
  if (!filePathOrUri) {
    return false;
  }
  let filepath = filePathOrUri;
  const wasFileUri = filePathOrUri.startsWith("file:");
  if (wasFileUri) {
    try {
      filepath = fileURLToPath(filePathOrUri);
    } catch {
      // Not a file URI this platform accepts.
    }
  }

  const root = path.resolve(workspaceRoot ?? process.cwd());
  const relativeInput = !wasFileUri && !isAbsolutePath(filepath);
  let resolved = relativeInput
    ? path.resolve(root, filepath)
    : path.resolve(filepath);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The file is not there; the normalized path is enough.
  }

  if (relativeInput && !isInsideDir(root, resolved)) return true;

  if (relativeInput && patternHit(filepath)) return true;
  const dir = path.dirname(resolved).split(/[/\\]/).at(-1) ?? "";
  const basename = path.basename(resolved);
  const tail = `${dir ? dir + "/" : ""}${basename}`;
  return patternHit(tail);
}

export function throwIfFileIsSecurityConcern(filepath: string) {
  if (isSecurityConcern(filepath)) {
    throw new ContinueError(
      ContinueErrorReason.FileIsSecurityConcern,
      `Reading or Editing ${filepath} is not allowed because it is a security concern. Do not attempt to read or edit this file in any way.`,
    );
  }
}

export function gitIgArrayFromFile(file: string) {
  return file
    .split(/\r?\n/) // Split on new line
    .map((l) => l.trim()) // Remove whitespace
    .filter((l) => !/^#|^$/.test(l)); // Remove empty lines
}
