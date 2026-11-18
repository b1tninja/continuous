import fs from "node:fs";
import path from "node:path";

import type { ConfigYaml } from "@continuedev/config-yaml";
import * as YAML from "yaml";

import type { IDE } from "../..";
import { editConfigYamlFile } from "../../util/paths";
import {
  ensureSecretPlaceholder,
  envFileHasValue,
} from "../../util/secretsFile";
import { isValidSecretName } from "../../util/unresolvedSecrets";
import { existingMcpServerNames } from "../importClineMcp";
import { type SecretStorageKind, storeSecret } from "../secretStorage";

import { suggestedSecretName } from "./analyzeLaunch";
import { listMcpServers, projectMcpServerDir } from "./manageMcpServers";
import type { McpDraftValue, McpServerDraft } from "./types";
import { referenceIn } from "./valueHints";

/*
  MCPW4 and MCPW5: add one reviewed server to the person's own config.yaml.
  The file is edited as a YAML document, so comments, key order and line
  endings survive, and written through a temp file and a rename
  (`editConfigYamlFile`, the same path `continuous permissions` and the
  Cline importer use). A file that does not parse is refused with its line
  number and left as it was. A name already in use is refused. Secret
  values go to the secret store (`storeSecret`: the IDE's secure storage or
  ~/.continuous/.env) and the file gets `${{ secrets.NAME }}`; no value
  appears in the result.

  Trust is not written here. The decision record of 2026-11-15 (injection
  13.4-1) puts MCP trust in permissions.yaml, through the rule editor
  (`mcpServers.<name>: trusted`), so the writer only saves the definition.
  The wizard's one trust decision is the consent to run the probe. Pin at
  Add (MCPW16) records the approved tool list through #901's approval API
  once that merges.
*/

export interface PlannedSecret {
  name: string;
  /** Where in the entry it is used, e.g. `env.GITHUB_TOKEN`. */
  usedBy: string;
  /** Never returned to callers outside core. */
  value: string;
}

export interface McpEntryPlan {
  /** The `mcpServers` item, with secrets already replaced by references. */
  entry: Record<string, unknown>;
  secrets: PlannedSecret[];
  /** References with no value yet: the person sets them later. */
  pending: string[];
  errors: string[];
}

const ref = (name: string) => `\${{ secrets.${name} }}`;

/**
 * Turn a draft into the YAML entry and the secrets to store. Pure; `taken`
 * holds secret names that already have a value, so a new one never
 * overwrites another server's key.
 */
export function planMcpServerEntry(
  draft: McpServerDraft,
  taken: (name: string) => boolean = () => false,
): McpEntryPlan {
  const errors: string[] = [];
  const secrets: PlannedSecret[] = [];
  const pending: string[] = [];
  const name = draft.name?.trim() ?? "";
  if (!name) errors.push("The server needs a name.");
  const used = new Set<string>();
  const uniqueName = (key: string) => {
    const base = suggestedSecretName(name, key);
    let n = base;
    for (let i = 2; used.has(n) || taken(n); i++) n = `${base}_${i}`;
    used.add(n);
    return n;
  };

  const convert = (v: McpDraftValue, usedBy: string): string | undefined => {
    const own = referenceIn(v.value);
    if (own?.kind === "secret") return v.value;
    if (own) {
      errors.push(
        `${v.name} still refers to another tool's variable (${own.name}). Enter the value instead.`,
      );
      return undefined;
    }
    if (!v.secret) return v.value;
    // Keep the scheme (Bearer, Basic) in the file; only the token is secret
    const scheme = /^(Bearer|Basic|Token)\s+(\S.*)$/i.exec(v.value);
    const secretValue = scheme ? scheme[2] : v.value;
    const secretName = uniqueName(v.name);
    if (secretValue.trim() === "") pending.push(secretName);
    else secrets.push({ name: secretName, usedBy, value: secretValue });
    return scheme ? `${scheme[1]} ${ref(secretName)}` : ref(secretName);
  };

  const entry: Record<string, unknown> = { name };
  if (draft.transport === "stdio") {
    if (!draft.command?.trim())
      errors.push("A command-line server needs a command.");
    entry.command = draft.command;
    if (draft.args?.length) {
      const secretArgs = new Set(draft.secretArgs ?? []);
      entry.args = draft.args.map((a, i) => {
        if (!secretArgs.has(i)) return a;
        // Named after its flag (`--api-key`), else after its position
        const prev = draft.args![i - 1] ?? "";
        const key = /^--?[A-Za-z]/.test(prev)
          ? prev.replace(/^-+/, "")
          : `arg${i + 1}`;
        return (
          convert({ name: key, value: a, secret: true }, `args.${i}`) ?? ""
        );
      });
    }
    if (draft.env?.length) {
      entry.env = Object.fromEntries(
        draft.env.map((v) => [v.name, convert(v, `env.${v.name}`) ?? ""]),
      );
    }
    if (draft.cwd) entry.cwd = draft.cwd;
  } else {
    let url = draft.url?.trim() ?? "";
    if (!/^https?:\/\//i.test(url)) {
      errors.push("A remote server needs an http:// or https:// URL.");
    }
    // A credential in the query string, such as ?api_key=..., as the importer does
    url = url.replace(
      /([?&])([^=&#]*(?:key|token|secret|auth|passw)[^=&#]*)=([^&#]+)/gi,
      (m, sep: string, key: string, value: string) => {
        if (referenceIn(value)) return m;
        const secretName = uniqueName(key);
        secrets.push({
          name: secretName,
          usedBy: `url.${key}`,
          value: decodeURIComponent(value),
        });
        return `${sep}${key}=${ref(secretName)}`;
      },
    );
    entry.url = url;
    entry.type = draft.transport === "sse" ? "sse" : "streamable-http";
    if (draft.headers?.length) {
      entry.requestOptions = {
        headers: Object.fromEntries(
          draft.headers.map((h) => [
            h.name,
            convert(h, `headers.${h.name}`) ?? "",
          ]),
        ),
      };
    }
  }
  if (draft.connectionTimeoutMs && draft.connectionTimeoutMs > 0) {
    entry.connectionTimeout = Math.round(draft.connectionTimeoutMs);
  }
  for (const s of [...secrets.map((x) => x.name), ...pending]) {
    if (!isValidSecretName(s))
      errors.push(`"${s}" is not a valid secret name.`);
  }
  return { entry, secrets, pending, errors };
}

/** The entry as it would appear under `mcpServers:`, for a review or a dry run. */
export function renderEntryYaml(entry: Record<string, unknown>): string {
  return YAML.stringify({ mcpServers: [entry] });
}

export interface AddMcpServerOptions {
  /** The person's own config.yaml (`~/.continuous/config.yaml`). */
  configPath: string;
  /** Required when the draft has secret values. */
  secrets?: {
    ide: Pick<IDE, "readSecrets" | "writeSecrets">;
    storage: SecretStorageKind;
    /** ~/.continuous */
    continueDir: string;
  };
}

export type AddMcpServerResult =
  | {
      ok: true;
      file: string;
      name: string;
      /** The written entry; secrets appear as references only. */
      entry: Record<string, unknown>;
      secretsStored: { name: string; location: SecretStorageKind }[];
      /** Referenced, without a value: an empty NAME= line was added to ~/.continuous/.env. */
      secretsPending: string[];
      warnings: string[];
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "no-file"
        | "unparseable"
        | "duplicate"
        | "secret"
        | "write";
      error: string;
      /** For "duplicate": a free name to offer. */
      suggestion?: string;
      /** Secrets already stored before the failure (names only). */
      secretsStored?: string[];
    };

/** The document's first parse error, with its line. */
function parseProblem(text: string): string | undefined {
  // prettyErrors (the default) fills in linePos
  const doc = YAML.parseDocument(text.replace(/^\uFEFF/, ""));
  const e = doc.errors[0];
  if (!e) {
    const js = doc.toJS();
    if (
      js !== null &&
      js !== undefined &&
      (typeof js !== "object" || Array.isArray(js))
    ) {
      return "config.yaml is not a mapping of settings.";
    }
    return undefined;
  }
  const line = e.linePos?.[0]?.line;
  return line
    ? `line ${line}: ${e.message.split("\n")[0]}`
    : e.message.split("\n")[0];
}

function freeName(name: string, taken: Set<string>): string {
  for (let i = 2; ; i++) {
    const candidate = `${name}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

type AddFailure = Extract<AddMcpServerResult, { ok: false }>;

interface PreparedEntry {
  ok: true;
  plan: McpEntryPlan;
  stored: { name: string; location: SecretStorageKind }[];
  warnings: string[];
}

/**
 * Plan the entry and store its secrets, before any config file is touched,
 * so a file never points at a value that failed to store.
 */
async function prepareEntry(
  draft: McpServerDraft,
  secretsOpt: AddMcpServerOptions["secrets"],
): Promise<PreparedEntry | AddFailure> {
  const continueDir = secretsOpt?.continueDir;
  const existing = new Map<string, boolean>();
  const plan = planMcpServerEntry(draft, (n) => {
    // Presence in ~/.continuous/.env is checked here; secure storage below
    if (!existing.has(n))
      existing.set(n, !!continueDir && envFileHasValue(continueDir, n));
    return existing.get(n)!;
  });
  if (plan.errors.length) {
    return { ok: false, reason: "invalid", error: plan.errors.join(" ") };
  }
  if ((plan.secrets.length || plan.pending.length) && !secretsOpt) {
    return {
      ok: false,
      reason: "secret",
      error:
        "This server has secret values and there is no secret store to put them in, so nothing was written.",
    };
  }

  // A name already in secure storage belongs to something else: plan again
  // with it taken, so no other key is overwritten
  if (secretsOpt && plan.secrets.length) {
    let inSecure: Record<string, string | undefined> = {};
    try {
      inSecure =
        (await secretsOpt.ide.readSecrets(plan.secrets.map((s) => s.name))) ??
        {};
    } catch {
      inSecure = {};
    }
    if (plan.secrets.some((s) => inSecure[s.name])) {
      const again = planMcpServerEntry(
        draft,
        (n) =>
          !!inSecure[n] || (!!continueDir && envFileHasValue(continueDir, n)),
      );
      plan.entry = again.entry;
      plan.secrets = again.secrets;
      plan.pending = again.pending;
    }
  }

  // Secrets first, so the file never points at a value that failed to store
  const stored: { name: string; location: SecretStorageKind }[] = [];
  const warnings: string[] = [];
  for (const s of plan.secrets) {
    const r = await storeSecret({
      ide: secretsOpt!.ide,
      name: s.name,
      value: s.value,
      storage: secretsOpt!.storage,
      continueDir: secretsOpt!.continueDir,
    });
    if (!r.stored) {
      return {
        ok: false,
        reason: "secret",
        error: `${s.name} could not be stored (${r.error}), so the server was not added.`,
        secretsStored: stored.map((x) => x.name),
      };
    }
    stored.push({
      name: s.name,
      location: r.location ?? secretsOpt!.storage,
    });
    if (r.envShadowed) {
      warnings.push(
        `${s.name} is in secure storage; ~/.continuous/.env still has an unused copy you can remove.`,
      );
    }
  }
  for (const p of plan.pending) {
    try {
      ensureSecretPlaceholder(secretsOpt!.continueDir, p);
    } catch {
      warnings.push(`Set ${p} in ~/.continuous/.env before the server starts.`);
    }
  }

  return { ok: true, plan, stored, warnings };
}

export async function addMcpServerToUserConfig(
  draft: McpServerDraft,
  opts: AddMcpServerOptions,
): Promise<AddMcpServerResult> {
  const file = opts.configPath;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {
      ok: false,
      reason: "no-file",
      error: `There is no ${path.basename(file)} at ${file}.`,
    };
  }
  const problem = parseProblem(text);
  if (problem) {
    return {
      ok: false,
      reason: "unparseable",
      error: `${path.basename(file)} does not parse (${problem}). It was not changed.`,
    };
  }
  const config = (YAML.parse(text.replace(/^\uFEFF/, "")) ?? {}) as ConfigYaml;
  const names = new Set(
    existingMcpServerNames(config).map((n) => n.trim().toLowerCase()),
  );
  const name = draft.name?.trim() ?? "";
  if (names.has(name.toLowerCase())) {
    return {
      ok: false,
      reason: "duplicate",
      error: `A server called ${name} already exists.`,
      suggestion: freeName(name, names),
    };
  }

  const prepared = await prepareEntry(draft, opts.secrets);
  if (!prepared.ok) return prepared;
  const { plan, stored, warnings } = prepared;

  let duplicateOnWrite = false;
  let edit;
  try {
    edit = editConfigYamlFile(file, (c) => {
      const have = new Set(
        existingMcpServerNames(c).map((n) => n.trim().toLowerCase()),
      );
      if (have.has(name.toLowerCase())) {
        duplicateOnWrite = true;
        return c;
      }
      return {
        ...c,
        mcpServers: [...(c.mcpServers ?? []), plan.entry as never],
      };
    });
  } catch (e) {
    edit = {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (duplicateOnWrite) {
    return {
      ok: false,
      reason: "duplicate",
      error: `A server called ${name} was added to ${path.basename(file)} meanwhile.`,
      suggestion: freeName(name, names),
      secretsStored: stored.map((x) => x.name),
    };
  }
  if (!edit.ok) {
    return {
      ok: false,
      reason: "write",
      error: edit.error,
      secretsStored: stored.map((x) => x.name),
    };
  }
  return {
    ok: true,
    file,
    name,
    entry: plan.entry,
    secretsStored: stored,
    secretsPending: plan.pending,
    warnings,
  };
}

export interface AddProjectMcpServerOptions {
  /** The project folder; the file goes in its `.continuous/mcpServers`. */
  projectDir: string;
  /** The person's own config.yaml, so a name in use there is refused too. */
  configPath?: string;
  secrets?: AddMcpServerOptions["secrets"];
}

/** `GitHub Tools` -> `github-tools.yaml`. */
export function projectBlockFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  return `${slug || "mcp-server"}.yaml`;
}

/**
 * The "This project" choice: write one block file,
 * `.continuous/mcpServers/<name>.yaml`, holding only this server. The file
 * follows folder trust like any other project server, and its secrets are
 * references that each person fills in on their own computer.
 */
export async function addMcpServerToProjectFile(
  draft: McpServerDraft,
  opts: AddProjectMcpServerOptions,
): Promise<AddMcpServerResult> {
  const name = draft.name?.trim() ?? "";
  const names = new Set(
    listMcpServers({
      configPath: opts.configPath ?? "",
      projectDir: opts.projectDir,
    }).servers.map((s) => s.name.trim().toLowerCase()),
  );
  if (name && names.has(name.toLowerCase())) {
    return {
      ok: false,
      reason: "duplicate",
      error: `A server called ${name} already exists.`,
      suggestion: freeName(name, names),
    };
  }
  const dir = projectMcpServerDir(opts.projectDir);
  const file = path.join(dir, projectBlockFileName(name));
  if (fs.existsSync(file)) {
    return {
      ok: false,
      reason: "duplicate",
      error: `${file} already exists.`,
      suggestion: freeName(name, names),
    };
  }
  const prepared = await prepareEntry(draft, opts.secrets);
  if (!prepared.ok) return prepared;
  const { plan, stored, warnings } = prepared;
  const block = {
    name,
    version: "0.0.1",
    schema: "v1",
    mcpServers: [plan.entry],
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, YAML.stringify(block), { flag: "wx" });
  } catch (e) {
    return {
      ok: false,
      reason: "write",
      error: `Could not write ${file}: ${e instanceof Error ? e.message : String(e)}`,
      secretsStored: stored.map((x) => x.name),
    };
  }
  return {
    ok: true,
    file,
    name,
    entry: plan.entry,
    secretsStored: stored,
    secretsPending: plan.pending,
    warnings,
  };
}
