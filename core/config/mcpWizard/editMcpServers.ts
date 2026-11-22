import fs from "node:fs";
import path from "node:path";

import type { ConfigYaml } from "@continuedev/config-yaml";
import * as YAML from "yaml";

import { maskCommandForDisplay } from "../../tools/permissions/displayMask";
import { editConfigYamlFile } from "../../util/paths";
import { envFileHasValue } from "../../util/secretsFile";
import { storeSecret } from "../secretStorage";

import {
  type AddMcpServerOptions,
  type AddMcpServerResult,
  freeName,
  parseProblem,
  prepareEntry,
} from "./addMcpServer";
import { suggestedSecretName } from "./analyzeLaunch";
import { freeBlockFileName } from "./fileNames";
import {
  type McpServerListing,
  type McpServerScope,
  projectMcpServerDir,
  removeListedMcpServer,
  secretNamesIn,
} from "./manageMcpServers";
import type { McpDraftValue, McpServerDraft } from "./types";
import { looksLikeSecretValue, referenceIn } from "./valueHints";

/*
  Edit, move and copy servers that are already saved, for the MCP servers tab.
  The files are the ones `listMcpServers` reads: the person's config.yaml, the
  block files of their own `~/.continuous/mcpServers`, and a folder's
  `.continuous/mcpServers`. Every path here comes from a listing or from the
  locations core computed; none comes from the webview.

  Nothing in this file starts a process or opens a connection.
*/

/** The keys of an entry the dialog's form reads and writes. */
const FORM_KEYS = new Set([
  "name",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "type",
  "connectionTimeout",
]);
const STDIO_KEYS = ["command", "args", "env", "cwd"];
const REMOTE_KEYS = ["url", "type", "apiKey", "oauth", "requestOptions"];

const SECRET_FLAG =
  /^--?(?:[a-z-]*(?:token|key|secret|password|auth)[a-z-]*)$/i;
const SCHEME = /^(Bearer|Basic|Token)\s+(\S.*)$/i;

const isOwnSecret = (text: string) => referenceIn(text)?.kind === "secret";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Indexes of arguments that are literal credentials. */
export function secretLookingArgs(args: string[]): number[] {
  const out: number[] = [];
  args.forEach((a, i) => {
    if (referenceIn(a)) return;
    const flagged = SECRET_FLAG.test(args[i - 1] ?? "");
    const shaped = maskCommandForDisplay(a) !== a;
    if (shaped || (flagged && looksLikeSecretValue("token", a))) out.push(i);
  });
  return out;
}

export interface McpEditDraft {
  /**
   * The entry as a draft. Values are the file's own text: a
   * `${{ secrets.NAME }}` reference stays one, and a credential written
   * directly in the file is marked `secret` (or listed in `secretArgs`).
   * Keep it in core: it may hold such a credential.
   */
  draft: McpServerDraft;
  /** Settings the form does not show; a save keeps them as they are. */
  keptKeys: string[];
  /** Why the form cannot edit this entry; the file can still be opened. */
  notEditable?: string;
}

function editValues(map: unknown): McpDraftValue[] {
  if (!isRecord(map)) return [];
  return Object.entries(map).map(([name, raw]) => {
    const value = typeof raw === "string" ? raw : String(raw ?? "");
    return {
      name,
      value,
      secret: isOwnSecret(value) || looksLikeSecretValue(name, value),
    };
  });
}

/** A saved entry as the draft the dialog edits. Pure. */
export function entryToEditDraft(entry: Record<string, unknown>): McpEditDraft {
  const requestOptions = isRecord(entry.requestOptions)
    ? entry.requestOptions
    : undefined;
  const keptKeys = [
    ...Object.keys(entry).filter(
      (k) => !FORM_KEYS.has(k) && k !== "requestOptions",
    ),
    ...Object.keys(requestOptions ?? {})
      .filter((k) => k !== "headers")
      .map((k) => `requestOptions.${k}`),
  ];
  const timeout =
    typeof entry.connectionTimeout === "number"
      ? { connectionTimeoutMs: entry.connectionTimeout }
      : {};
  const name = String(entry.name ?? "");
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const secretArgs = secretLookingArgs(args);
    return {
      draft: {
        name,
        transport: "stdio",
        command: entry.command,
        args,
        ...(typeof entry.cwd === "string" && entry.cwd
          ? { cwd: entry.cwd }
          : {}),
        env: editValues(entry.env),
        ...(secretArgs.length ? { secretArgs } : {}),
        ...timeout,
      },
      keptKeys,
    };
  }
  const draft: McpServerDraft = {
    name,
    transport: entry.type === "sse" ? "sse" : "http",
    url: typeof entry.url === "string" ? entry.url : "",
    headers: editValues(requestOptions?.headers),
    // No `type` in the file: the connection tries both, and a save keeps it so
    ...(entry.type === undefined ? { autoTransport: true } : {}),
    ...timeout,
  };
  if (
    entry.type !== undefined &&
    !["sse", "streamable-http"].includes(String(entry.type))
  ) {
    return {
      draft,
      keptKeys,
      notEditable: `This server uses the ${String(entry.type)} transport, which this form does not edit.`,
    };
  }
  return { draft, keptKeys };
}

/**
 * The entry to write for an edit: what the form produced, plus every setting
 * of the old entry the form does not show. A setting the form shows and the
 * person left empty is removed, so it stays unset in the file.
 */
export function mergeEditedEntry(
  old: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const nextIsStdio = typeof next.command === "string";
  const drop = new Set(nextIsStdio ? REMOTE_KEYS : STDIO_KEYS);
  const out: Record<string, unknown> = {};
  // The old key order first, so an edit moves no line that did not change
  for (const [k, v] of Object.entries(old)) {
    if (drop.has(k)) continue;
    if (k === "requestOptions") continue;
    if (FORM_KEYS.has(k)) {
      if (k in next) out[k] = next[k];
      continue;
    }
    out[k] = v;
  }
  for (const [k, v] of Object.entries(next)) {
    if (k !== "requestOptions" && !(k in out)) out[k] = v;
  }
  if (!nextIsStdio) {
    const oldOptions = isRecord(old.requestOptions) ? old.requestOptions : {};
    const { headers: _old, ...rest } = oldOptions;
    const headers = isRecord(next.requestOptions)
      ? next.requestOptions.headers
      : undefined;
    const merged = { ...rest, ...(headers ? { headers } : {}) };
    if (Object.keys(merged).length) out.requestOptions = merged;
  }
  return out;
}

const sameName = (a: unknown, b: string) =>
  typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

export interface UpdateMcpServerOptions {
  secrets?: AddMcpServerOptions["secrets"];
  /** Names of the other servers a new name must not collide with. */
  otherNames: string[];
}

/**
 * Change one saved server in its own file. The file is edited as a YAML
 * document, so comments and the other servers survive. New secret values are
 * stored first; a value for a secret this server already uses replaces it.
 */
export async function updateMcpServer(
  target: McpServerListing,
  draft: McpServerDraft,
  opts: UpdateMcpServerOptions,
): Promise<AddMcpServerResult> {
  const name = draft.name?.trim() ?? "";
  const others = new Set(opts.otherNames.map((n) => n.trim().toLowerCase()));
  if (name && !sameName(target.name, name) && others.has(name.toLowerCase())) {
    return {
      ok: false,
      reason: "duplicate",
      error: `A server called ${name} already exists.`,
      suggestion: freeName(name, others),
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(target.file, "utf8");
  } catch {
    return {
      ok: false,
      reason: "no-file",
      error: `There is no ${path.basename(target.file)} at ${target.file}.`,
    };
  }
  const problem = parseProblem(text);
  if (problem) {
    return {
      ok: false,
      reason: "unparseable",
      error: `${path.basename(target.file)} does not parse (${problem}). It was not changed.`,
    };
  }
  const prepared = await prepareEntry(
    draft,
    opts.secrets,
    new Set(secretNamesIn(target.entry)),
  );
  if (!prepared.ok) return prepared;
  const { plan, stored, warnings } = prepared;
  const entry = mergeEditedEntry(target.entry, plan.entry);

  let found = false;
  let edit;
  try {
    edit = editConfigYamlFile(target.file, (c) => ({
      ...c,
      mcpServers: (c.mcpServers ?? []).map((s) => {
        if (
          !found &&
          isRecord(s) &&
          sameName((s as { name?: unknown }).name, target.name)
        ) {
          found = true;
          return entry as never;
        }
        return s;
      }),
    }));
  } catch (e) {
    edit = {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!edit.ok || !found) {
    return {
      ok: false,
      reason: "write",
      error: edit.ok
        ? `${target.name} is no longer in ${path.basename(target.file)}. It was not changed.`
        : edit.error,
      secretsStored: stored.map((x) => x.name),
    };
  }
  return {
    ok: true,
    file: target.file,
    name,
    entry,
    secretsStored: stored,
    secretsPending: plan.pending,
    warnings,
  };
}

// ---- move and copy ----

export interface McpDestination {
  scope: McpServerScope;
  /** The person's own config.yaml. */
  configPath: string;
  /** For "project": the folder whose `.continuous/mcpServers` gets the file. */
  projectDir?: string;
}

export interface MoveMcpServerOptions {
  /** Leave the source in place ("Duplicate to", "Copy to"). */
  copy?: boolean;
  /** The name in the destination; the source's name when left out. */
  newName?: string;
  /** Names the destination must not repeat, with the file each is in. */
  taken: { name: string; file: string }[];
  secrets?: AddMcpServerOptions["secrets"];
}

export type MoveMcpServerResult =
  | {
      ok: true;
      name: string;
      from: string;
      to: string;
      /** False for a copy, or when the source could not be changed. */
      removedFromSource: boolean;
      sourceFileDeleted: boolean;
      /** Credentials that were written in the source and are now secrets. */
      secretsStored: string[];
      warnings: string[];
    }
  | {
      ok: false;
      reason: "duplicate" | "no-file" | "unparseable" | "secret" | "write";
      error: string;
    };

/**
 * A copy of `entry` with each credential written in it stored as a secret
 * and replaced by a reference. Used before an entry goes to a folder's file,
 * which can be committed and shared.
 */
async function literalSecretsToReferences(
  entry: Record<string, unknown>,
  secrets: AddMcpServerOptions["secrets"],
): Promise<
  | { ok: true; entry: Record<string, unknown>; stored: string[] }
  | { ok: false; error: string }
> {
  const serverName = String(entry.name ?? "");
  const found: { key: string; value: string; set: (ref: string) => void }[] =
    [];
  const out = structuredClone(entry);
  const collect = (map: unknown) => {
    if (!isRecord(map)) return;
    for (const [k, raw] of Object.entries(map)) {
      if (typeof raw !== "string" || !looksLikeSecretValue(k, raw)) continue;
      const scheme = SCHEME.exec(raw);
      found.push({
        key: k,
        value: scheme ? scheme[2] : raw,
        set: (ref) => {
          map[k] = scheme ? `${scheme[1]} ${ref}` : ref;
        },
      });
    }
  };
  collect(out.env);
  if (isRecord(out.requestOptions)) collect(out.requestOptions.headers);
  if (Array.isArray(out.args)) {
    const args = out.args.map(String);
    for (const i of secretLookingArgs(args)) {
      const prev = args[i - 1] ?? "";
      found.push({
        key: /^--?[A-Za-z]/.test(prev)
          ? prev.replace(/^-+/, "")
          : `arg${i + 1}`,
        value: args[i],
        set: (ref) => {
          (out.args as unknown[])[i] = ref;
        },
      });
    }
  }
  // Keys the form does not show can hold a credential too
  if (
    typeof out.apiKey === "string" &&
    out.apiKey &&
    !referenceIn(out.apiKey)
  ) {
    found.push({
      key: "API_KEY",
      value: out.apiKey,
      set: (ref) => {
        out.apiKey = ref;
      },
    });
  }
  const oauth = out.oauth;
  if (
    isRecord(oauth) &&
    typeof oauth.clientSecret === "string" &&
    !referenceIn(oauth.clientSecret)
  ) {
    const value = oauth.clientSecret;
    found.push({
      key: "CLIENT_SECRET",
      value,
      set: (ref) => {
        oauth.clientSecret = ref;
      },
    });
  }
  if (!found.length) return { ok: true, entry: out, stored: [] };
  if (!secrets) {
    return {
      ok: false,
      error:
        "This server has credentials written in its file and there is no secret store to move them to, so nothing was written.",
    };
  }
  const names = found.map((f) => suggestedSecretName(serverName, f.key));
  let inSecure: Record<string, string | undefined> = {};
  try {
    inSecure = (await secrets.ide.readSecrets(names)) ?? {};
  } catch {
    inSecure = {};
  }
  const used = new Set<string>();
  const stored: string[] = [];
  for (const f of found) {
    const base = suggestedSecretName(serverName, f.key);
    let n = base;
    // Never overwrite a secret that is already there: it may be another server's
    for (
      let i = 2;
      used.has(n) || inSecure[n] || envFileHasValue(secrets.continueDir, n);
      i++
    ) {
      n = `${base}_${i}`;
    }
    used.add(n);
    const r = await storeSecret({
      ide: secrets.ide,
      name: n,
      value: f.value,
      storage: secrets.storage,
      continueDir: secrets.continueDir,
    });
    if (!r.stored) {
      return {
        ok: false,
        error: `${n} could not be stored (${r.error}), so nothing was written.`,
      };
    }
    stored.push(n);
    f.set(`\${{ secrets.${n} }}`);
  }
  return { ok: true, entry: out, stored };
}

/**
 * Write a saved server to the other place and then remove it from the first,
 * in that order, so a failure never loses it. Secret references are copied
 * as references. A credential written in the source becomes a secret before
 * the entry goes to a folder's file.
 */
export async function moveMcpServer(
  source: McpServerListing,
  dest: McpDestination,
  opts: MoveMcpServerOptions,
): Promise<MoveMcpServerResult> {
  const name = (opts.newName ?? source.name).trim();
  const clash = opts.taken.find((t) => sameName(t.name, name));
  if (clash) {
    return {
      ok: false,
      reason: "duplicate",
      error: `A server called ${name} already exists in ${clash.file}. Rename one of them first.`,
    };
  }
  let entry: Record<string, unknown> = { ...source.entry, name };
  let stored: string[] = [];
  if (dest.scope === "project") {
    const converted = await literalSecretsToReferences(entry, opts.secrets);
    if (!converted.ok) {
      return { ok: false, reason: "secret", error: converted.error };
    }
    entry = converted.entry;
    stored = converted.stored;
  }

  let to: string;
  if (dest.scope === "project") {
    if (!dest.projectDir) {
      return {
        ok: false,
        reason: "no-file",
        error: "Open a folder to save a server for this workspace.",
      };
    }
    const dir = projectMcpServerDir(dest.projectDir);
    to = path.join(
      dir,
      freeBlockFileName(dir, name, (f) => fs.existsSync(f)),
    );
    const block = { name, version: "0.0.1", schema: "v1", mcpServers: [entry] };
    try {
      fs.mkdirSync(dir, { recursive: true });
      // "wx": never over another file
      fs.writeFileSync(to, YAML.stringify(block), { flag: "wx" });
    } catch (e) {
      return {
        ok: false,
        reason: "write",
        error: `Could not write ${to}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    to = dest.configPath;
    let text: string;
    try {
      text = fs.readFileSync(to, "utf8");
    } catch {
      return {
        ok: false,
        reason: "no-file",
        error: `There is no ${path.basename(to)} at ${to}.`,
      };
    }
    const problem = parseProblem(text);
    if (problem) {
      return {
        ok: false,
        reason: "unparseable",
        error: `${path.basename(to)} does not parse (${problem}). It was not changed.`,
      };
    }
    let duplicate = false;
    const edit = editConfigYamlFile(to, (c: ConfigYaml) => {
      if (
        (c.mcpServers ?? []).some(
          (s) => isRecord(s) && sameName((s as { name?: unknown }).name, name),
        )
      ) {
        duplicate = true;
        return c;
      }
      return { ...c, mcpServers: [...(c.mcpServers ?? []), entry as never] };
    });
    if (duplicate) {
      return {
        ok: false,
        reason: "duplicate",
        error: `A server called ${name} already exists in ${to}. Rename one of them first.`,
      };
    }
    if (!edit.ok) return { ok: false, reason: "write", error: edit.error };
  }

  const done = {
    ok: true as const,
    name,
    from: source.file,
    to,
    secretsStored: stored,
  };
  if (opts.copy) {
    return {
      ...done,
      removedFromSource: false,
      sourceFileDeleted: false,
      warnings: [],
    };
  }
  const removed = removeListedMcpServer(source, dest.configPath);
  if (!removed.ok) {
    return {
      ...done,
      removedFromSource: false,
      sourceFileDeleted: false,
      warnings: [
        `${name} was written to ${to}, but it is still in ${source.file} too: ${removed.error}`,
      ],
    };
  }
  return {
    ...done,
    removedFromSource: true,
    sourceFileDeleted: removed.fileDeleted,
    warnings: [],
  };
}
