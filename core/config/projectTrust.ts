/**
 * Trust for configuration that arrives with a repository.
 *
 * Files under `.continuous/` and `.continue/`, and a repo-root rc file, can
 * start programs, point accounts at another server, or read the user's
 * secrets. None of that applies until this project is trusted for that part
 * of the config, with a fingerprint of the files. Editing them asks again.
 *
 * The record lives in the user global folder, never in the project. Nothing
 * in the environment grants it. A global folder inside the project is
 * ignored, the same rule project hooks use, so a repository cannot store the
 * "trusted" record in itself.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ConfigValidationError } from "@continuedev/config-yaml";
import * as YAML from "yaml";

import { findUriInDirs, joinPathsToUri } from "../util/uri";
import { getGlobalDirPath } from "../util/paths";
import {
  isInWorkspaceConfigSubdir,
  isRcFile,
  WORKSPACE_DIRS,
} from "../util/workspaceDirs";

import type { IDE } from "..";

const TRUST_FILE = "trusted-project.json";
const FILE = 1;
const DIRECTORY = 2;
const SYMLINK = 64;

export const PROJECT_CONFIG_SCOPES = [
  "mcp",
  "models",
  "providers",
  "catalog",
  "data",
  "rc",
  "worktree",
  "environment",
] as const;

export type ProjectConfigScope = (typeof PROJECT_CONFIG_SCOPES)[number];

/** Block types whose workspace files are held until that scope is trusted. */
export const TRUST_GATED_BLOCK_SCOPES: ProjectConfigScope[] = [
  "mcp",
  "models",
  "data",
];

export interface ScopeFile {
  path: string;
  content: string;
}

export interface PendingTrust {
  projectDir: string;
  scope: ProjectConfigScope;
  fingerprint: string;
  /** Paths relative to the project, for the trust prompt. */
  files: string[];
}

/**
 * Set from --trust-project-config. Lasts for this process only.
 * Stored on globalThis so duplicated copies of this module (the package and
 * the built output) still see the same decision.
 */
const RUN_FLAG = Symbol.for("continuous.trustProjectConfigForRun");

export function setProjectConfigTrustedForRun(value: boolean): void {
  (globalThis as Record<symbol, boolean>)[RUN_FLAG] = value;
}

export function isProjectConfigTrustedForRun(): boolean {
  return (globalThis as Record<symbol, boolean>)[RUN_FLAG] === true;
}

const pending: PendingTrust[] = [];
const notedNotices = new Set<string>();
const scopeCache = new Map<string, Map<string, ScopeFile[]>>();

/** Drop notices from the previous config load. */
export function beginTrustCheck(): void {
  pending.length = 0;
  notedNotices.clear();
  scopeCache.clear();
}

export function pendingProjectTrust(): PendingTrust[] {
  return pending.slice();
}

/**
 * The real path of `p`, resolving symlinks. A path that does not exist yet is
 * resolved through its nearest existing ancestor, so two spellings compare
 * equal. Same idea as the project-hooks record.
 */
export function realPath(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** A filesystem path for a file URI or an absolute path. Remote URIs have none. */
export function uriToFsPath(uriOrPath: string): string | undefined {
  if (!uriOrPath) return undefined;
  if (uriOrPath.startsWith("file:")) {
    try {
      return fileURLToPath(uriOrPath);
    } catch {
      return undefined;
    }
  }
  if (uriOrPath.includes("://")) return undefined;
  return uriOrPath;
}

function asFileUri(value: string): string | undefined {
  if (!value) return undefined;
  if (value.includes("://")) return value;
  try {
    return pathToFileURL(value).href;
  } catch {
    return undefined;
  }
}

/** True when `file` is inside `dir`. A shared prefix (`/ws` vs `/ws-other`) does not count. */
export function fileIsInsideDir(file: string, dir: string): boolean {
  const fileUri = asFileUri(file);
  const dirUri = asFileUri(dir);
  if (!fileUri || !dirUri) return false;
  try {
    return findUriInDirs(fileUri, [dirUri]).foundInDir !== null;
  } catch {
    return false;
  }
}

/** The key a project is recorded under: its real path, folded on Windows. */
export function projectKeyFor(projectDir: string): string {
  const fsPath = uriToFsPath(projectDir);
  const real = realPath(fsPath ?? projectDir);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

export function relativeProjectPath(projectDir: string, file: string): string {
  const projectFs = uriToFsPath(projectDir);
  const fileFs = uriToFsPath(file);
  if (projectFs && fileFs) {
    const rel = path.relative(projectFs, fileFs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
  }
  const projectUri = asFileUri(projectDir);
  const fileUri = asFileUri(file);
  if (projectUri && fileUri) {
    try {
      const found = findUriInDirs(fileUri, [projectUri]);
      if (found.foundInDir && found.relativePathOrBasename) {
        return found.relativePathOrBasename;
      }
    } catch {
      // fall through
    }
  }
  return file.split(path.sep).join("/");
}

function globalDirFor(
  projectDir: string,
  explicit?: string,
): string | undefined {
  const projectFs = uriToFsPath(projectDir) ?? path.resolve(projectDir);
  let dir: string;
  if (explicit) {
    dir = explicit;
  } else {
    const fromEnv =
      process.env.CONTINUOUS_GLOBAL_DIR || process.env.CONTINUE_GLOBAL_DIR;
    dir = fromEnv ? path.resolve(projectFs, fromEnv) : getGlobalDirPath();
  }
  try {
    if (isInside(realPath(dir), realPath(projectFs))) return undefined;
  } catch {
    return undefined;
  }
  return dir;
}

interface TrustRecord {
  version: 1;
  projects: Record<
    string,
    {
      scopes: Partial<
        Record<ProjectConfigScope, { fingerprint: string; trustedAt: string }>
      >;
    }
  >;
}

function emptyRecord(): TrustRecord {
  return { version: 1, projects: {} };
}

function readTrust(file: string): TrustRecord {
  try {
    if (!fs.existsSync(file)) return emptyRecord();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version !== 1 || typeof parsed.projects !== "object") {
      return emptyRecord();
    }
    return parsed as TrustRecord;
  } catch {
    // An unreadable record means nothing is trusted.
    return emptyRecord();
  }
}

function writeTrust(file: string, record: TrustRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function trustPath(projectDir: string, explicit?: string): string | undefined {
  const dir = globalDirFor(projectDir, explicit);
  return dir ? path.join(dir, TRUST_FILE) : undefined;
}

export function isScopeTrusted(
  projectDir: string,
  scope: ProjectConfigScope,
  fingerprint: string,
  globalDir?: string,
): boolean {
  if (!fingerprint) return false;
  const file = trustPath(projectDir, globalDir);
  if (!file) return false;
  const entry = readTrust(file).projects[projectKeyFor(projectDir)];
  return entry?.scopes?.[scope]?.fingerprint === fingerprint;
}

/**
 * Whether the person has trusted any part of this folder's configuration
 * (a record for any scope in their global folder), or this run trusts
 * project configuration (--trust-project-config). The tainted-session rule
 * reads it to label a read from a folder nobody vouched for
 * (`untrusted-workspace`). A global folder inside the project counts as no
 * record, as everywhere else here.
 */
export function folderHasTrustRecord(
  projectDir: string,
  globalDir?: string,
): boolean {
  if (isProjectConfigTrustedForRun()) return true;
  try {
    const file = trustPath(projectDir, globalDir);
    if (!file) return false;
    const scopes = readTrust(file).projects[projectKeyFor(projectDir)]?.scopes;
    return !!scopes && Object.keys(scopes).length > 0;
  } catch {
    return false;
  }
}

export function trustProjectScopes(
  projectDir: string,
  fingerprints: Partial<Record<ProjectConfigScope, string>>,
  globalDir?: string,
): void {
  const file = trustPath(projectDir, globalDir);
  if (!file) {
    throw new Error(
      "The Continuous directory is inside this project, so trust cannot be saved. Unset CONTINUOUS_GLOBAL_DIR or point it outside the project.",
    );
  }
  const record = readTrust(file);
  const key = projectKeyFor(projectDir);
  const current = record.projects[key]?.scopes ?? {};
  const trustedAt = new Date().toISOString();
  for (const [scope, fingerprint] of Object.entries(fingerprints)) {
    if (!fingerprint) continue;
    current[scope as ProjectConfigScope] = { fingerprint, trustedAt };
  }
  record.projects[key] = { scopes: current };
  writeTrust(file, record);
}

export function revokeProjectConfig(
  projectDir: string,
  globalDir?: string,
): boolean {
  const file = trustPath(projectDir, globalDir);
  if (!file) return false;
  const record = readTrust(file);
  const key = projectKeyFor(projectDir);
  if (!(key in record.projects)) return false;
  delete record.projects[key];
  writeTrust(file, record);
  return true;
}

function fingerprintProjectFiles(
  projectDir: string,
  files: ScopeFile[],
): string {
  const hash = crypto.createHash("sha256");
  const rows = files
    .map((file) => ({
      relative: relativeProjectPath(projectDir, file.path),
      content: file.content,
    }))
    .sort((a, b) =>
      a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0,
    );
  for (const row of rows) {
    hash.update(`${row.relative}\0${row.content}\0`);
  }
  return hash.digest("hex");
}

export function decideFromFiles(
  projectDir: string,
  scope: ProjectConfigScope,
  files: ScopeFile[],
  globalDir?: string,
): { trusted: boolean; fingerprint: string } {
  if (files.length === 0) return { trusted: true, fingerprint: "" };
  const fingerprint = fingerprintProjectFiles(projectDir, files);
  const trusted =
    isProjectConfigTrustedForRun() ||
    isScopeTrusted(projectDir, scope, fingerprint, globalDir);
  if (!trusted) {
    const key = projectKeyFor(projectDir) + "\0" + scope;
    const entry: PendingTrust = {
      projectDir,
      scope,
      fingerprint,
      files: files.map((file) => relativeProjectPath(projectDir, file.path)),
    };
    const index = pending.findIndex(
      (item) => projectKeyFor(item.projectDir) + "\0" + item.scope === key,
    );
    if (index >= 0) pending[index] = entry;
    else pending.push(entry);
  }
  return { trusted, fingerprint };
}

const SCOPE_NOUN: Record<ProjectConfigScope, string> = {
  mcp: "MCP server file",
  models: "model file",
  providers: "provider file",
  catalog: "model catalog file",
  data: "data destination file",
  rc: "config override",
  worktree: "worktree setup file",
  environment: "environment install file",
};

export function untrustedScopeMessage(
  scope: ProjectConfigScope,
  folder: string,
  count: number,
): string {
  const noun = SCOPE_NOUN[scope];
  const what = count === 1 ? noun : `${noun}s`;
  return `${count} ${what} from ${folder} ${count === 1 ? "was" : "were"} not applied. This folder is not trusted, so its Continuous configuration cannot start programs, send data out, or change your accounts. Trust the folder to use ${count === 1 ? "it" : "them"}. Your own configuration is kept.`;
}

/** One config notice per folder and scope for this load. */
export function untrustedConfigError(
  projectDir: string,
  scope: ProjectConfigScope,
  count: number,
): ConfigValidationError | undefined {
  const key = projectKeyFor(projectDir) + "\0" + scope;
  if (notedNotices.has(key)) return undefined;
  notedNotices.add(key);
  const folder = uriToFsPath(projectDir) ?? projectDir;
  return {
    fatal: false,
    message: untrustedScopeMessage(scope, folder, count),
  };
}

interface ScopeLayout {
  dirs?: string[];
  files?: string[];
  extensions?: string[];
  rootRc?: boolean;
}

const LAYOUT: Record<ProjectConfigScope, ScopeLayout> = {
  mcp: { dirs: ["mcpServers"], extensions: [".json", ".yaml", ".yml"] },
  models: { dirs: ["models"], extensions: [".yaml", ".yml"] },
  providers: { files: ["providers.yaml"] },
  catalog: { files: ["models.yaml"] },
  data: { dirs: ["data"], extensions: [".yaml", ".yml"] },
  rc: { rootRc: true },
  worktree: { files: ["worktrees.json"] },
  environment: { files: ["environment.json"] },
};

function hasExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function readFileIfRegular(file: string): ScopeFile | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return { path: file, content: fs.readFileSync(file, "utf8") };
  } catch {
    return undefined;
  }
}

function walkRegularFiles(dir: string, extensions: string[], out: ScopeFile[]) {
  try {
    // readdir follows a symlink, so a linked directory would be hashed as if
    // it were in the project. Skip the link itself.
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  } catch {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkRegularFiles(full, extensions, out);
    } else if (entry.isFile() && hasExtension(entry.name, extensions)) {
      const read = readFileIfRegular(full);
      if (read) out.push(read);
    }
  }
}

/** Regular files for one scope. Symlinks are skipped so the target can change unseen. */
export function readScopeFilesFromDisk(
  projectDir: string,
  scope: ProjectConfigScope,
): ScopeFile[] {
  const root = uriToFsPath(projectDir) ?? projectDir;
  const layout = LAYOUT[scope];
  const files: ScopeFile[] = [];
  if (layout.rootRc) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!isRcFile(entry.name)) continue;
      const read = readFileIfRegular(path.join(root, entry.name));
      if (read) files.push(read);
    }
    return files;
  }
  for (const folder of WORKSPACE_DIRS) {
    for (const name of layout.files ?? []) {
      const read = readFileIfRegular(path.join(root, folder, name));
      if (read) files.push(read);
    }
    for (const sub of layout.dirs ?? []) {
      walkRegularFiles(
        path.join(root, folder, sub),
        layout.extensions ?? [],
        files,
      );
    }
  }
  return files;
}

async function readExactViaIde(
  ide: IDE,
  dir: string,
  folder: string,
  name: string,
): Promise<ScopeFile | undefined> {
  const parent = joinPathsToUri(dir, folder);
  let entries: [string, number][];
  try {
    if (!(await ide.fileExists(parent))) return undefined;
    entries = (await ide.listDir(parent)) as [string, number][];
  } catch {
    return undefined;
  }
  const found = entries.find(([entryName]) => entryName === name);
  if (!found || found[1] !== FILE) return undefined;
  const uri = joinPathsToUri(parent, name);
  try {
    return { path: uri, content: await ide.readFile(uri) };
  } catch {
    return undefined;
  }
}

async function walkViaIde(
  ide: IDE,
  uri: string,
  extensions: string[],
  out: ScopeFile[],
): Promise<void> {
  let entries: [string, number][];
  try {
    entries = (await ide.listDir(uri)) as [string, number][];
  } catch {
    return;
  }
  for (const [name, type] of entries) {
    if (!name || name === "." || name === "..") continue;
    if (type === SYMLINK) continue;
    const child = joinPathsToUri(uri, name);
    if (type === DIRECTORY) {
      if (name === "node_modules" || name === ".git") continue;
      await walkViaIde(ide, child, extensions, out);
    } else if (type === FILE && hasExtension(name, extensions)) {
      try {
        out.push({ path: child, content: await ide.readFile(child) });
      } catch {
        // unreadable file is not trusted and not applied
      }
    }
  }
}

async function readScopeFilesViaIde(
  ide: IDE,
  dir: string,
  scope: ProjectConfigScope,
): Promise<ScopeFile[]> {
  const layout = LAYOUT[scope];
  const files: ScopeFile[] = [];
  if (layout.rootRc) {
    let entries: [string, number][];
    try {
      entries = (await ide.listDir(dir)) as [string, number][];
    } catch {
      return [];
    }
    for (const [name, type] of entries) {
      if (type !== FILE || !isRcFile(name)) continue;
      const uri = joinPathsToUri(dir, name);
      try {
        files.push({ path: uri, content: await ide.readFile(uri) });
      } catch {
        // skip
      }
    }
    return files;
  }
  for (const folder of WORKSPACE_DIRS) {
    for (const name of layout.files ?? []) {
      const read = await readExactViaIde(ide, dir, folder, name);
      if (read) files.push(read);
    }
    for (const sub of layout.dirs ?? []) {
      const uri = joinPathsToUri(dir, folder, sub);
      try {
        if (!(await ide.fileExists(uri))) continue;
      } catch {
        continue;
      }
      await walkViaIde(ide, uri, layout.extensions ?? [], files);
    }
  }
  return files;
}

async function collectScopeFiles(
  ide: IDE,
  dir: string,
  scope: ProjectConfigScope,
): Promise<ScopeFile[]> {
  const fsPath = uriToFsPath(dir);
  if (fsPath) {
    try {
      if (fs.existsSync(fsPath) && fs.statSync(fsPath).isDirectory()) {
        return readScopeFilesFromDisk(fsPath, scope);
      }
    } catch {
      // fall through to the IDE
    }
  }
  return readScopeFilesViaIde(ide, dir, scope);
}

/** Files for one scope, once per config load. A local folder is read from disk so it matches `cn project`. */
export async function filesForScope(
  ide: IDE,
  scope: ProjectConfigScope,
): Promise<Map<string, ScopeFile[]>> {
  const cached = scopeCache.get(scope);
  if (cached) return cached;
  let dirs: string[] = [];
  try {
    dirs = await ide.getWorkspaceDirs();
  } catch {
    dirs = [];
  }
  const map = new Map<string, ScopeFile[]>();
  for (const dir of dirs) {
    map.set(dir, await collectScopeFiles(ide, dir, scope));
  }
  scopeCache.set(scope, map);
  return map;
}

/**
 * Workspace files for one scope, kept only when that folder is trusted for
 * those files. Files that are not inside a workspace are returned as-is.
 */
export async function trustedWorkspaceFiles(
  ide: IDE,
  scope: ProjectConfigScope,
  files: ScopeFile[],
): Promise<{ files: ScopeFile[]; notices: ConfigValidationError[] }> {
  let dirs: string[] = [];
  try {
    dirs = await ide.getWorkspaceDirs();
  } catch {
    dirs = [];
  }
  const notices: ConfigValidationError[] = [];
  const kept: ScopeFile[] = [];
  const groups = new Map<string, ScopeFile[]>();
  for (const file of files) {
    const dir = dirs.find((candidate) => fileIsInsideDir(file.path, candidate));
    if (!dir) {
      kept.push(file);
      continue;
    }
    const group = groups.get(dir) ?? [];
    group.push(file);
    groups.set(dir, group);
  }
  for (const [dir, group] of groups) {
    const trusted = await scopeIsTrusted(ide, dir, scope, group);
    if (trusted) {
      kept.push(...group);
      continue;
    }
    const notice = untrustedConfigError(dir, scope, group.length);
    if (notice) notices.push(notice);
  }
  return { files: kept, notices };
}

export async function scopeIsTrusted(
  ide: IDE,
  projectDir: string,
  scope: ProjectConfigScope,
  fallback: ScopeFile[] = [],
): Promise<boolean> {
  const map = await filesForScope(ide, scope);
  let files = map.get(projectDir) ?? [];
  // The IDE already read these blocks (a remote folder has no disk copy).
  // Remember them so a later check in the same load uses the same fingerprint.
  if (files.length === 0 && fallback.length > 0) {
    files = fallback;
    map.set(projectDir, files);
  }
  return decideFromFiles(projectDir, scope, files).trusted;
}

/**
 * Which trust scope a workspace block file belongs to, if it is one of the
 * kinds a repository must not apply on its own.
 */
export function blockScope(
  blockType: string,
  filePath: string,
  workspaceDirs: string[],
): { dir: string; scope: ProjectConfigScope } | undefined {
  const dir = workspaceDirs.find((candidate) =>
    fileIsInsideDir(filePath, candidate),
  );
  if (!dir) return undefined;
  if (
    blockType === "mcpServers" &&
    isInWorkspaceConfigSubdir(filePath, "mcpServers")
  ) {
    return { dir, scope: "mcp" };
  }
  if (blockType === "models" && isInWorkspaceConfigSubdir(filePath, "models")) {
    return { dir, scope: "models" };
  }
  if (blockType === "data" && isInWorkspaceConfigSubdir(filePath, "data")) {
    return { dir, scope: "data" };
  }
  return undefined;
}

function parseLoose(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // YAML below
    }
  }
  try {
    return YAML.parse(trimmed);
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function mcpDefs(
  raw: unknown,
): { name: string; def: Record<string, unknown> }[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.mcpServers)) {
    return obj.mcpServers.map((def, index) => ({
      name: String((def as { name?: string })?.name ?? `server-${index + 1}`),
      def: (def ?? {}) as Record<string, unknown>,
    }));
  }
  if (obj.mcpServers && typeof obj.mcpServers === "object") {
    return Object.entries(obj.mcpServers as Record<string, unknown>).map(
      ([name, def]) => ({
        name,
        def: (def ?? {}) as Record<string, unknown>,
      }),
    );
  }
  if (typeof obj.command === "string" || typeof obj.url === "string") {
    return [{ name: String(obj.name ?? "server"), def: obj }];
  }
  return [];
}

function describeMcp(name: string, def: Record<string, unknown>): string {
  const env =
    def.env && typeof def.env === "object"
      ? Object.keys(def.env as object)
      : [];
  const envText = env.length > 0 ? ` (env names: ${env.join(", ")})` : "";
  if (typeof def.command === "string") {
    const args = Array.isArray(def.args) ? def.args.map(String).join(" ") : "";
    return clip(`${name}: ${def.command}${args ? ` ${args}` : ""}${envText}`);
  }
  if (typeof def.url === "string") {
    return clip(`${name}: ${def.url}${envText}`);
  }
  return name;
}

function summarizeMcp(content: string): string[] {
  const defs = mcpDefs(parseLoose(content));
  if (defs.length === 0) return ["MCP file (could not be read)"];
  return defs.map((entry) => describeMcp(entry.name, entry.def));
}

function summarizeProviders(content: string): string[] {
  const raw = parseLoose(content) as { providers?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.providers)) {
    return ["provider file (could not be read)"];
  }
  return raw.providers.map((item) => {
    const provider = item as {
      name?: string;
      provider?: string;
      apiBase?: string;
    };
    const base =
      typeof provider.apiBase === "string" ? ` at ${provider.apiBase}` : "";
    return clip(
      `${provider.name ?? "unnamed"} (${provider.provider ?? "unknown provider"})${base}`,
    );
  });
}

function summarizeCatalog(content: string): string[] {
  const raw = parseLoose(content) as { models?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.models)) {
    return ["model catalog (could not be read)"];
  }
  return raw.models.map((item) => {
    const model = item as {
      name?: string;
      provider?: string;
      model?: string;
      connection?: string;
      apiBase?: string;
    };
    const via = model.connection
      ? `connection ${model.connection}`
      : (model.provider ?? "no provider");
    const base =
      typeof model.apiBase === "string" ? ` at ${model.apiBase}` : "";
    return clip(
      `${model.name ?? "unnamed"}: ${model.model ?? ""} (${via})${base}`,
    );
  });
}

function summarizeModelBlock(content: string): string[] {
  const raw = parseLoose(content) as { models?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.models)) {
    return ["model file (could not be read)"];
  }
  return raw.models.map((item) => {
    const model = item as {
      name?: string;
      provider?: string;
      model?: string;
      apiBase?: string;
      connection?: string;
    };
    const base =
      typeof model.apiBase === "string" ? ` at ${model.apiBase}` : "";
    return clip(
      `${model.name ?? "unnamed"} (${model.provider ?? model.connection ?? "unknown"} ${model.model ?? ""})${base}`.trim(),
    );
  });
}

function summarizeData(content: string): string[] {
  const raw = parseLoose(content) as { data?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.data)) {
    return ["data file (could not be read)"];
  }
  return raw.data.map((item) => {
    const dest = item as { name?: string; destination?: string };
    return clip(
      `${dest.name ?? "unnamed"} -> ${dest.destination ?? "no destination"}`,
    );
  });
}

function summarizeRc(file: string, content: string): string[] {
  const base = path.basename(uriToFsPath(file) ?? file);
  const raw = parseLoose(content);
  if (!raw || typeof raw !== "object") return [`${base} (could not be read)`];
  const record = raw as Record<string, unknown>;
  const keys = [
    "requestOptions",
    "models",
    "contextProviders",
    "slashCommands",
    "experimental",
    "mergeBehavior",
  ].filter((key) => record[key] !== undefined);
  return [
    keys.length > 0
      ? `${base}: sets ${keys.join(", ")}`
      : `${base}: merges into your config`,
  ];
}

function summarizeWorktree(file: string, content: string): string[] {
  const base = path.basename(uriToFsPath(file) ?? file);
  const raw = parseLoose(content);
  if (!raw || typeof raw !== "object") return [`${base} (could not be read)`];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith("setup-worktree")) continue;
    for (const command of Array.isArray(value) ? value : [value]) {
      if (typeof command === "string" && command.trim()) {
        lines.push(clip(`${key}: ${command}`));
      }
    }
  }
  return lines.length > 0 ? lines : [`${base}: no setup commands`];
}

function summarizeEnvironment(file: string, content: string): string[] {
  const base = path.basename(uriToFsPath(file) ?? file);
  const raw = parseLoose(content);
  if (!raw || typeof raw !== "object") return [`${base} (could not be read)`];
  const install = (raw as Record<string, unknown>).install;
  return typeof install === "string" && install.trim()
    ? [clip(`${base}: install: ${install}`)]
    : [`${base}: no install command`];
}

/** What a file would do, without secret values. */
export function summarizeScopeFile(
  scope: ProjectConfigScope,
  file: ScopeFile,
): string[] {
  try {
    switch (scope) {
      case "mcp":
        return summarizeMcp(file.content);
      case "providers":
        return summarizeProviders(file.content);
      case "catalog":
        return summarizeCatalog(file.content);
      case "models":
        return summarizeModelBlock(file.content);
      case "data":
        return summarizeData(file.content);
      case "rc":
        return summarizeRc(file.path, file.content);
      case "worktree":
        return summarizeWorktree(file.path, file.content);
      case "environment":
        return summarizeEnvironment(file.path, file.content);
      default:
        return [];
    }
  } catch {
    return ["could not be read"];
  }
}

export function summarizeScopeFiles(
  scope: ProjectConfigScope,
  files: ScopeFile[],
): string[] {
  return files.flatMap((file) => summarizeScopeFile(scope, file));
}

export interface ProjectScopeStatus {
  scope: ProjectConfigScope;
  files: ScopeFile[];
  fingerprint: string;
  trusted: boolean;
  lines: string[];
}

/** What this project asks to apply, and whether it is trusted. For `cn project`. */
export function inspectProjectConfig(
  projectDir: string,
  globalDir?: string,
): ProjectScopeStatus[] {
  const statuses: ProjectScopeStatus[] = [];
  for (const scope of PROJECT_CONFIG_SCOPES) {
    const files = readScopeFilesFromDisk(projectDir, scope);
    if (files.length === 0) continue;
    const fingerprint = fingerprintProjectFiles(projectDir, files);
    const trusted =
      isProjectConfigTrustedForRun() ||
      isScopeTrusted(projectDir, scope, fingerprint, globalDir);
    statuses.push({
      scope,
      files,
      fingerprint,
      trusted,
      lines: summarizeScopeFiles(scope, files),
    });
  }
  return statuses;
}

/**
 * True when an MCP server file came from a workspace folder rather than the
 * user global folder. The global folder's path also contains `.continuous/mcpServers`.
 */
export function isWorkspaceMcpSource(
  sourceFile: string | undefined,
  workspaceDirs: string[],
): boolean {
  if (!sourceFile) return false;
  if (!isInWorkspaceConfigSubdir(sourceFile, "mcpServers")) return false;
  return workspaceDirs.some((dir) => fileIsInsideDir(sourceFile, dir));
}
