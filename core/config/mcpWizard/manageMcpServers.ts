import fs from "node:fs";
import path from "node:path";

import type { ConfigYaml } from "@continuedev/config-yaml";
import * as YAML from "yaml";

import { editConfigYamlFile } from "../../util/paths";
import { WORKSPACE_DIR } from "../../util/workspaceDirs";
import { maskCommandForDisplay } from "../../tools/permissions/displayMask";

import type { McpDraftValue, McpServerDraft } from "./types";

/*
  MCPW7: list, find, remove and re-test servers that are already saved, for
  `continuous mcp list`, `test` and `remove`. Two places are read: the
  person's own config.yaml ("user") and the project's
  `.continuous/mcpServers/*.yaml` block files ("project"). JSON files in that
  folder (Claude Desktop and Cursor layout) are loaded by the IDE but are not
  edited here.

  Nothing in this file starts a process or opens a connection. Listings carry
  secret references (`${{ secrets.NAME }}`), never values.
*/

export type McpServerScope = "user" | "project";

export interface McpServerLocations {
  /** The person's own config.yaml. */
  configPath: string;
  /** The project folder; its `.continuous/mcpServers` is read. */
  projectDir?: string;
}

export interface McpServerListing {
  name: string;
  scope: McpServerScope;
  file: string;
  transport: "stdio" | "sse" | "streamable-http";
  /** The command line (display-masked) or the URL. */
  target: string;
  /** Secret names the entry refers to. */
  secrets: string[];
  entry: Record<string, unknown>;
}

export interface McpServerList {
  servers: McpServerListing[];
  /** Files that could not be read, with the reason. */
  problems: string[];
}

const SECRET_REF = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g;

export function projectMcpServerDir(projectDir: string): string {
  return path.join(projectDir, WORKSPACE_DIR, "mcpServers");
}

function readYaml(file: string): { config?: ConfigYaml; error?: string } {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) {
      const line = doc.errors[0].linePos?.[0]?.line;
      return { error: `does not parse${line ? ` (line ${line})` : ""}` };
    }
    const js = doc.toJS();
    if (js === null || js === undefined) return { config: {} as ConfigYaml };
    if (typeof js !== "object" || Array.isArray(js)) {
      return { error: "is not a mapping of settings" };
    }
    return { config: js as ConfigYaml };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function secretNamesIn(entry: unknown): string[] {
  const names = new Set<string>();
  for (const m of JSON.stringify(entry ?? {}).matchAll(SECRET_REF)) {
    names.add(m[1]);
  }
  return [...names];
}

export function entryTransport(
  entry: Record<string, unknown>,
): McpServerListing["transport"] {
  if (typeof entry.command === "string") return "stdio";
  return entry.type === "sse" ? "sse" : "streamable-http";
}

function entryTarget(entry: Record<string, unknown>): string {
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    return maskCommandForDisplay([entry.command, ...args].join(" "));
  }
  return typeof entry.url === "string" ? entry.url : "";
}

function listingsOf(
  config: ConfigYaml | undefined,
  scope: McpServerScope,
  file: string,
): McpServerListing[] {
  const out: McpServerListing[] = [];
  for (const raw of config?.mcpServers ?? []) {
    if (!raw || typeof raw !== "object" || !("name" in raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name) continue;
    out.push({
      name: entry.name,
      scope,
      file,
      transport: entryTransport(entry),
      target: entryTarget(entry),
      secrets: secretNamesIn(entry),
      entry,
    });
  }
  return out;
}

function projectFiles(projectDir: string): string[] {
  const dir = projectMcpServerDir(projectDir);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.ya?ml$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Every saved server in the user config and the project's block files. */
export function listMcpServers(loc: McpServerLocations): McpServerList {
  const servers: McpServerListing[] = [];
  const problems: string[] = [];
  if (fs.existsSync(loc.configPath)) {
    const user = readYaml(loc.configPath);
    if (user.error) problems.push(`${loc.configPath} ${user.error}`);
    servers.push(...listingsOf(user.config, "user", loc.configPath));
  }
  if (loc.projectDir) {
    for (const file of projectFiles(loc.projectDir)) {
      const project = readYaml(file);
      if (project.error) problems.push(`${file} ${project.error}`);
      servers.push(...listingsOf(project.config, "project", file));
    }
  }
  return { servers, problems };
}

/** Saved servers with this name (any case), optionally in one scope. */
export function findMcpServers(
  name: string,
  loc: McpServerLocations,
  scope?: McpServerScope,
): McpServerListing[] {
  const want = name.trim().toLowerCase();
  return listMcpServers(loc).servers.filter(
    (s) =>
      s.name.trim().toLowerCase() === want && (!scope || s.scope === scope),
  );
}

export type RemoveMcpServerResult =
  | {
      ok: true;
      file: string;
      scope: McpServerScope;
      /** The block file held only this server and was deleted. */
      fileDeleted: boolean;
      /** Secrets the entry referred to; they are left in place. */
      secrets: string[];
    }
  | {
      ok: false;
      reason: "not-found" | "ambiguous" | "write";
      error: string;
      matches?: McpServerListing[];
    };

function withoutServer(config: ConfigYaml, name: string): ConfigYaml {
  const want = name.trim().toLowerCase();
  return {
    ...config,
    mcpServers: (config.mcpServers ?? []).filter(
      (s) =>
        !(
          s &&
          typeof s === "object" &&
          "name" in s &&
          typeof s.name === "string" &&
          s.name.trim().toLowerCase() === want
        ),
    ),
  };
}

/**
 * Remove one saved server. The user config is edited in place (comments
 * kept); a project block file that held only this server is deleted.
 * Secrets the entry used are not deleted: another server may use them.
 */
export function removeMcpServer(
  name: string,
  loc: McpServerLocations,
  scope?: McpServerScope,
): RemoveMcpServerResult {
  const matches = findMcpServers(name, loc, scope);
  if (matches.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      error: `There is no saved server called ${name}.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      error: `${matches.length} saved servers are called ${name}. Pass --scope user or --scope project.`,
      matches,
    };
  }
  const target = matches[0];
  if (target.scope === "project") {
    const { config } = readYaml(target.file);
    if ((config?.mcpServers ?? []).length <= 1) {
      try {
        fs.unlinkSync(target.file);
      } catch (e) {
        return {
          ok: false,
          reason: "write",
          error: `Could not delete ${target.file}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
      return {
        ok: true,
        file: target.file,
        scope: "project",
        fileDeleted: true,
        secrets: target.secrets,
      };
    }
  }
  const edit = editConfigYamlFile(target.file, (c) => withoutServer(c, name));
  if (!edit.ok) return { ok: false, reason: "write", error: edit.error };
  return {
    ok: true,
    file: target.file,
    scope: target.scope,
    fileDeleted: false,
    secrets: target.secrets,
  };
}

function resolveValue(
  name: string,
  raw: unknown,
  resolve: (secret: string) => string | undefined,
  missing: Set<string>,
): McpDraftValue {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  let secret = false;
  const value = text.replace(SECRET_REF, (_m, ref: string) => {
    secret = true;
    const v = resolve(ref);
    if (v === undefined || v === "") missing.add(ref);
    return v ?? "";
  });
  return { name, value, secret };
}

function valuesOf(
  map: unknown,
  resolve: (secret: string) => string | undefined,
  missing: Set<string>,
): McpDraftValue[] {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map as Record<string, unknown>).map(([k, v]) =>
    resolveValue(k, v, resolve, missing),
  );
}

/**
 * A saved entry as a probe draft, with `${{ secrets.NAME }}` replaced by the
 * values `resolve` returns. `missing` names the references with no value.
 * The draft holds secret values: keep it in memory and never print it.
 */
export function entryToDraft(
  entry: Record<string, unknown>,
  resolve: (secret: string) => string | undefined,
): { draft: McpServerDraft; missing: string[] } {
  const missing = new Set<string>();
  const transport = entryTransport(entry);
  const draft: McpServerDraft = {
    name: String(entry.name ?? ""),
    transport: transport === "streamable-http" ? "http" : transport,
  };
  if (typeof entry.connectionTimeout === "number") {
    draft.connectionTimeoutMs = entry.connectionTimeout;
  }
  if (transport === "stdio") {
    draft.command = String(entry.command);
    draft.args = Array.isArray(entry.args)
      ? entry.args.map((a) => resolveValue("arg", a, resolve, missing).value)
      : [];
    if (typeof entry.cwd === "string") draft.cwd = entry.cwd;
    draft.env = valuesOf(entry.env, resolve, missing);
  } else {
    const url = resolveValue("url", entry.url, resolve, missing);
    draft.url = url.value;
    const headers = valuesOf(
      (entry.requestOptions as { headers?: unknown } | undefined)?.headers,
      resolve,
      missing,
    );
    if (entry.apiKey !== undefined) {
      const key = resolveValue("Authorization", entry.apiKey, resolve, missing);
      headers.push({ ...key, value: `Bearer ${key.value}`, secret: true });
    }
    draft.headers = headers;
  }
  return { draft, missing: [...missing] };
}
