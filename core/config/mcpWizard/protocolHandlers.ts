import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { IDE } from "../..";
import { maskCommandForDisplay } from "../../tools/permissions/displayMask";
import { readSecretFromEnvFile } from "../../util/secretsFile";
import {
  COMMONS_ENV_VARS,
  DEFAULT_MCP_TIMEOUT,
} from "../../context/mcp/MCPConnection";
import { DEFAULT_MCP_TOOL_TIMEOUT } from "../../context/mcp/mcpTimeouts";
import { inspectProjectConfig } from "../projectTrust";
import type { SecretStorageKind } from "../secretStorage";

import {
  addMcpServerToProjectFile,
  addMcpServerToUserConfig,
  type AddMcpServerResult,
  planMcpServerEntry,
} from "./addMcpServer";
import { analyzeLaunch, type LaunchAnalysis } from "./analyzeLaunch";
import {
  entryToEditDraft,
  moveMcpServer,
  type MoveMcpServerResult,
  updateMcpServer,
} from "./editMcpServers";
import {
  listMcpServers,
  type McpServerListing,
  type McpServerScope,
  projectMcpServerDir,
  removeListedMcpServer,
} from "./manageMcpServers";
import { parseMcpPaste } from "./parseMcpPaste";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  type McpProbeResult,
  probeMcpServer,
  type ProbeOptions,
} from "./probeMcpServer";
import { checkRuntime, type McpRuntimeCheck } from "./runtimeCheck";
import {
  findTemplate,
  type McpTemplateSummary,
  type McpWizardField,
  templateSummaries,
  templateToDraft,
} from "./templates";
import type {
  McpCandidate,
  McpDraftValue,
  McpNamedValue,
  McpPasteFormat,
  McpServerDraft,
} from "./types";
import { looksLikeSecretValue, referenceIn } from "./valueHints";

/*
  MCPW4a: the messages the add dialog uses (plans/research/mcp-server-wizard.md
  section 12.7). These are protocol messages, not tools: nothing the model
  can call reaches them.

  Secrets: a value goes from the webview to core only inside a draft on
  `mcp/probe` and `mcp/save`, and no secret value ever comes back. A
  credential found in a paste is kept here, in memory, and the webview gets
  a held marker (`${{ held.<id> }}`) in its place; `mcp/probe` and
  `mcp/save` swap the marker for the value. Every answer is also scrubbed of
  each secret value of its request before it leaves.

  The probe runs only when its request carries `consent: true`: there is no
  implicit start, and a launch the analysis blocks is refused even then.
*/

export type McpWizardSource = McpPasteFormat | "template";

export interface McpWizardCandidate {
  /**
   * Ready to review. Secret values are empty (to fill in), a
   * `${{ secrets.NAME }}` reference, or a held marker for a value from the
   * paste. Never a secret value.
   */
  draft: McpServerDraft;
  nameGuessed: boolean;
  transportGuessed: boolean;
  source: McpWizardSource;
  templateId?: string;
  /** What the Simple screen asks for (required) and Advanced offers (optional). */
  fields: McpWizardField[];
  /** Plain text, safe to show. */
  warnings: string[];
}

export type McpWizardParseRequest = { text: string } | { templateId: string };

export interface McpWizardParseResponse {
  candidates: McpWizardCandidate[];
  warnings: string[];
}

export interface McpWizardAnalyzeResponse {
  analysis: LaunchAnalysis;
  /** stdio only: the MCPW10 line under the command. */
  runtime?: McpRuntimeCheck;
  /** Held markers that are no longer known (the paste is too old). */
  expired: boolean;
}

export interface McpWizardProbeRequest {
  draft: McpServerDraft;
  /** Must be exactly `true`: the person pressed "Run this command and test". */
  consent: boolean;
  timeoutMs?: number;
  /**
   * Where the server is, or will be, saved. A server of a folder whose MCP
   * files are not trusted is not started, as the loader would not start it.
   */
  scope?: McpServerScope;
  /** For "project": which open folder. The first one when left out. */
  folder?: string;
}

export type McpWizardRefusal =
  | "no-consent"
  | "blocked"
  | "invalid"
  | "missing-values"
  | "expired"
  | "untrusted";

export type McpWizardProbeResponse =
  | { ran: true; result: McpProbeResult }
  | { ran: false; reason: McpWizardRefusal; error: string; missing?: string[] };

export interface McpWizardSaveRequest {
  draft: McpServerDraft;
  /** "user" (the default) is the person's own config.yaml. */
  scope?: McpServerScope;
  /**
   * For "project": which open folder. Must be one of the folders core
   * lists; the first one when left out. Never a path to write to.
   */
  folder?: string;
}

/** One saved server, named by where it is. */
export interface McpWizardTarget {
  name: string;
  scope: McpServerScope;
  /** For "project": the open folder it belongs to. */
  folder?: string;
}

/**
 * "none": the folder has no MCP files yet, so there is nothing to trust.
 * "untrusted": it has some, and the person has not trusted them as they are.
 */
export type McpFolderTrust = "trusted" | "untrusted" | "none";

export interface McpWizardScopesResponse {
  /** "For all my projects": the person's own config.yaml. */
  user: { file: string; exists: boolean };
  /** "For this workspace only": one per open folder. */
  folders: {
    dir: string;
    name: string;
    /** `<dir>/.continuous/mcpServers`, where the one-server files go. */
    mcpDir: string;
    trust: McpFolderTrust;
  }[];
  secretStore: { kind: SecretStorageKind; envFile: string };
  /** What the code does when a setting is left out, for the form to say. */
  defaults: {
    /** MCPConnection's own limit when `connectionTimeout` is not set. */
    connectionTimeoutMs: number;
    /** The limit of the dialog's Test. */
    probeTimeoutMs: number;
    /**
     * The limit of one tool call when neither `toolTimeout` nor
     * `connectionTimeout` is set. With only `connectionTimeout` set, tool
     * calls follow that (context/mcp/mcpTimeouts.ts).
     */
    toolCallTimeoutMs: number;
    /** A local server's environment besides its own `env`. */
    inheritedEnv: string[];
    /** Where a local server starts when `cwd` is not set; none when no folder is open. */
    cwd?: string;
  };
}

export type McpWizardGetDraftResponse =
  | {
      ok: true;
      listing: McpWizardListing;
      /** Credentials written in the file come as held markers. */
      draft: McpServerDraft;
      /** Settings the form does not show and a save keeps. */
      keptKeys: string[];
      notEditable?: string;
    }
  | { ok: false; error: string };

export interface McpWizardUpdateRequest {
  target: McpWizardTarget;
  draft: McpServerDraft;
}

export interface McpWizardMoveRequest {
  target: McpWizardTarget;
  to: { scope: McpServerScope; folder?: string };
  /** Leave the source where it is. */
  copy?: boolean;
  newName?: string;
  /**
   * Must be exactly `true` when a folder's server goes to "all my
   * projects": from then on its command starts without the folder's trust.
   */
  consent?: boolean;
}

export type McpWizardMoveResponse =
  | (Extract<MoveMcpServerResult, { ok: true }> & { scope: McpServerScope })
  | {
      ok: false;
      reason:
        | Extract<MoveMcpServerResult, { ok: false }>["reason"]
        | "not-found"
        | "no-consent"
        | "blocked"
        | "no-project";
      error: string;
    };

type AddFailure = Extract<AddMcpServerResult, { ok: false }>;

export type McpWizardSaveResponse =
  | {
      ok: true;
      scope: McpServerScope;
      file: string;
      name: string;
      secretsStored: { name: string; location: SecretStorageKind }[];
      secretsPending: string[];
      warnings: string[];
    }
  | {
      ok: false;
      reason: AddFailure["reason"] | "blocked" | "expired" | "no-project";
      error: string;
      suggestion?: string;
      secretsStored?: string[];
    };

/** A saved server as the webview sees it: names and references only. */
export interface McpWizardListing {
  name: string;
  scope: McpServerScope;
  file: string;
  transport: McpServerListing["transport"];
  /** For "project": the open folder the file is in. */
  folder?: string;
  /** The command line or URL, credentials masked. */
  target: string;
  /** Secret names the entry refers to. */
  secrets: string[];
  envNames: string[];
  headerNames: string[];
}

export interface McpWizardListResponse {
  servers: McpWizardListing[];
  problems: string[];
}

export interface McpWizardRemoveRequest {
  name: string;
  scope?: McpServerScope;
  /** For "project": which open folder, when several are open. */
  folder?: string;
}

export type McpWizardRemoveResponse =
  | {
      ok: true;
      file: string;
      scope: McpServerScope;
      fileDeleted: boolean;
      /** Left in place: another server may use them. */
      secrets: string[];
    }
  | {
      ok: false;
      reason: "not-found" | "ambiguous" | "write";
      error: string;
      matches?: McpWizardListing[];
    };

export interface McpWizardHost {
  /** The person's own config.yaml. */
  configPath: () => string;
  /** ~/.continuous */
  continueDir: () => string;
  /** The open folder, as a path; undefined when none is open. */
  projectDir: () => Promise<string | undefined>;
  /** Every open folder. Only `projectDir` is used when left out. */
  projectDirs?: () => Promise<string[]>;
  /** `~/.continuous/mcpServers`; its block files are listed when given. */
  globalMcpDir?: () => string;
  /** For tests: whether a folder's MCP files are trusted. */
  folderTrust?: (dir: string) => McpFolderTrust;
  /**
   * Called after a folder's server was written to "all my projects": from
   * then on it starts without the folder's trust and its tools' read-only
   * claims are believed. The host writes the audit line and forgets the
   * approvals kept under that name, so its tools wait for approval again.
   */
  onLoosened?: (change: {
    name: string;
    from: string;
    to: string;
  }) => Promise<void>;
  ide: Pick<IDE, "readSecrets" | "writeSecrets">;
  /** For the probe's working folder and a stored sign-in, as in a real run. */
  probeIde?: IDE;
  /** Where a new secret goes: secure storage when the IDE has it. */
  secretStorage: () => Promise<SecretStorageKind>;
  reload: (reason: string) => Promise<void>;
  platform?: NodeJS.Platform;
  /** The environment whose PATH the runtime check searches. */
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** For tests: the probe. */
  probe?: (
    draft: McpServerDraft,
    opts: ProbeOptions,
  ) => Promise<McpProbeResult>;
}

// ---- held values ----

const HELD = /\$\{\{\s*held\.([0-9a-f-]{36})\s*\}\}/g;
const HELD_TTL_MS = 60 * 60 * 1000;
const HELD_MAX = 200;
const MASK = "«masked:value»";

/** Credentials from a paste, kept in core while the dialog is open. */
export class HeldValues {
  private values = new Map<string, { value: string; at: number }>();
  constructor(private now: () => number = Date.now) {}

  hold(value: string): string {
    this.expire();
    if (this.values.size >= HELD_MAX) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    const id = randomUUID();
    this.values.set(id, { value, at: this.now() });
    return `\${{ held.${id} }}`;
  }

  get(id: string): string | undefined {
    this.expire();
    return this.values.get(id)?.value;
  }

  private expire() {
    const cutoff = this.now() - HELD_TTL_MS;
    for (const [id, v] of this.values) {
      if (v.at < cutoff) this.values.delete(id);
    }
  }
}

const QUERY_CREDENTIAL =
  /([?&])([^=&#]*(?:key|token|secret|auth|passw)[^=&#]*)=([^&#]+)/gi;
const SECRET_FLAG =
  /^--?(?:[a-z-]*(?:token|key|secret|password|auth)[a-z-]*)$/i;

/** How a pasted value reaches the webview: never with a credential in it. */
function webviewValue(v: McpNamedValue, held: HeldValues): McpDraftValue {
  if (v.reference?.kind === "secret") {
    return {
      name: v.name,
      value: `\${{ secrets.${v.reference.name} }}`,
      secret: true,
    };
  }
  if (v.reference || v.placeholder || v.value === undefined) {
    // Another tool's variable or an example: a secret to fill in
    return { name: v.name, value: "", secret: true };
  }
  if (v.secretLooking) {
    return { name: v.name, value: held.hold(v.value), secret: true };
  }
  return { name: v.name, value: v.value, secret: false };
}

function webviewArgs(args: string[], held: HeldValues): string[] {
  return args.map((a, i) => {
    if (referenceIn(a)) return a;
    const flagged = SECRET_FLAG.test(args[i - 1] ?? "");
    const shaped = maskCommandForDisplay(a) !== a;
    return shaped || (flagged && looksLikeSecretValue("token", a))
      ? held.hold(a)
      : a;
  });
}

function webviewUrl(url: string, held: HeldValues): string {
  return url.replace(
    QUERY_CREDENTIAL,
    (m, sep: string, key: string, value: string) =>
      referenceIn(value)
        ? m
        : `${sep}${key}=${held.hold(decodeURIComponent(value))}`,
  );
}

function fieldsOfValues(
  values: McpDraftValue[] | undefined,
  target: "env" | "header",
): McpWizardField[] {
  return (values ?? [])
    .filter((v) => v.secret)
    .map((v) => ({
      target,
      name: v.name,
      label:
        target === "header" && /^authorization$/i.test(v.name)
          ? "API key"
          : v.name,
      isRequired: true,
      isSecret: true,
      ...(v.value === "" ? {} : { hasValue: true }),
    }));
}

export function candidateForWebview(
  c: McpCandidate,
  held: HeldValues,
): McpWizardCandidate {
  const env = c.env.map((v) => webviewValue(v, held));
  const headers = c.headers.map((v) => webviewValue(v, held));
  const draft: McpServerDraft = {
    name: c.name,
    transport: c.transport,
    ...(c.command === undefined
      ? {}
      : { command: c.command, args: webviewArgs(c.args ?? [], held) }),
    ...(c.cwd ? { cwd: c.cwd } : {}),
    ...(c.url === undefined ? {} : { url: webviewUrl(c.url, held) }),
    env,
    headers,
  };
  return {
    draft,
    nameGuessed: c.nameGuessed,
    transportGuessed: c.transportGuessed,
    source: c.sourceFormat,
    fields: [
      ...fieldsOfValues(env, "env"),
      ...fieldsOfValues(headers, "header"),
    ],
    warnings: [...c.warnings],
  };
}

function parse(
  req: McpWizardParseRequest,
  held: HeldValues,
): McpWizardParseResponse {
  if ("templateId" in req) {
    const t = findTemplate(req.templateId);
    if (!t) {
      return {
        candidates: [],
        warnings: [`There is no template called ${req.templateId}.`],
      };
    }
    const { draft, fields } = templateToDraft(t);
    return {
      candidates: [
        {
          draft,
          nameGuessed: false,
          transportGuessed: false,
          source: "template",
          templateId: t.id,
          fields,
          warnings: [],
        },
      ],
      warnings: [],
    };
  }
  const parsed = parseMcpPaste(String(req.text ?? ""));
  return {
    candidates: parsed.candidates.map((c) => candidateForWebview(c, held)),
    warnings: parsed.warnings,
  };
}

// ---- resolving a draft from the webview ----

interface Resolved {
  draft: McpServerDraft;
  /** Held markers that are no longer known. */
  expired: number;
  /** Every secret value in the draft, for scrubbing the answer. */
  secrets: string[];
}

/** A copy of the draft with held markers swapped for their values. */
export function resolveHeld(draft: McpServerDraft, held: HeldValues): Resolved {
  let expired = 0;
  const secrets: string[] = [];
  const swap = (text: string | undefined) =>
    text?.replace(HELD, (_m, id: string) => {
      const v = held.get(id);
      if (v === undefined) {
        expired++;
        return "";
      }
      secrets.push(v);
      return v;
    });
  // A value that held a credential stays a secret, whatever the page says
  const isHeld = (text: unknown) => new RegExp(HELD.source).test(String(text));
  const values = (list: McpDraftValue[] | undefined) =>
    list?.map((v) => {
      const secret = !!v.secret || isHeld(v.value);
      const value = swap(String(v.value ?? "")) ?? "";
      if (secret && value)
        secrets.push(value.replace(/^(?:Bearer|Basic|Token)\s+/i, ""));
      return { name: String(v.name), value, secret };
    });
  const secretArgs = new Set(
    (Array.isArray(draft.secretArgs) ? draft.secretArgs : []).filter(
      (i) => Number.isInteger(i) && i >= 0,
    ),
  );
  draft.args?.forEach((a, i) => {
    if (isHeld(a)) secretArgs.add(i);
  });
  const out: McpServerDraft = {
    name: String(draft.name ?? ""),
    transport: draft.transport,
    ...(draft.command === undefined
      ? {}
      : { command: swap(String(draft.command)) }),
    ...(draft.args
      ? { args: draft.args.map((a) => swap(String(a)) ?? "") }
      : {}),
    ...(draft.cwd ? { cwd: String(draft.cwd) } : {}),
    ...(draft.url === undefined ? {} : { url: swap(String(draft.url)) }),
    ...(draft.env ? { env: values(draft.env) } : {}),
    ...(draft.headers ? { headers: values(draft.headers) } : {}),
    ...(typeof draft.connectionTimeoutMs === "number"
      ? { connectionTimeoutMs: draft.connectionTimeoutMs }
      : {}),
    ...(typeof draft.toolTimeoutMs === "number"
      ? { toolTimeoutMs: draft.toolTimeoutMs }
      : {}),
    ...(draft.autoTransport === true ? { autoTransport: true } : {}),
    ...(secretArgs.size
      ? { secretArgs: [...secretArgs].sort((a, b) => a - b) }
      : {}),
  };
  for (const i of secretArgs) {
    const a = out.args?.[i];
    if (a) secrets.push(a);
  }
  return { draft: out, expired, secrets };
}

/** A copy of `value` with every secret replaced by the mask, in every string. */
export function scrubSecrets<T>(value: T, secrets: string[]): T {
  const list = [...new Set(secrets.filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  if (!list.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v;
      for (const s of list) out = out.split(s).join(MASK);
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return walk(value) as T;
}

const OWN_SECRET = /^\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}$/;
const OWN_SECRET_ANY = /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/;

/** Fill `${{ secrets.NAME }}` values from the secret store, for the probe only. */
async function withStoredSecrets(
  draft: McpServerDraft,
  host: McpWizardHost,
): Promise<{ draft: McpServerDraft; missing: string[]; secrets: string[] }> {
  const missing: string[] = [];
  const secrets: string[] = [];
  const lookup = async (ref: string): Promise<string | undefined> => {
    let stored: string | undefined;
    try {
      stored = (await host.ide.readSecrets([ref]))?.[ref];
    } catch {
      stored = undefined;
    }
    return stored || readSecretFromEnvFile(host.continueDir(), ref);
  };
  /** `text` with each `${{ secrets.NAME }}` filled in; undefined when one has no value. */
  const fillText = async (text: string): Promise<string | undefined> => {
    let out = text;
    for (const m of text.matchAll(new RegExp(OWN_SECRET_ANY.source, "g"))) {
      const ref = OWN_SECRET.exec(m[0])![1];
      const stored = await lookup(ref);
      if (!stored) return undefined;
      secrets.push(stored);
      out = out.replace(m[0], () => stored);
    }
    return out;
  };
  const fill = async (v: McpDraftValue): Promise<McpDraftValue> => {
    if (v.secret && v.value === "") {
      missing.push(v.name);
      return v;
    }
    const value = await fillText(v.value);
    if (value === undefined) {
      missing.push(v.name);
      return v;
    }
    return { ...v, value };
  };
  const env = draft.env ? await Promise.all(draft.env.map(fill)) : undefined;
  const headers = draft.headers
    ? await Promise.all(draft.headers.map(fill))
    : undefined;
  const args = draft.args
    ? await Promise.all(
        draft.args.map(async (a, i) => {
          const value = await fillText(a);
          if (value === undefined) missing.push(`argument ${i + 1}`);
          return value ?? a;
        }),
      )
    : undefined;
  return {
    draft: {
      ...draft,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
    },
    missing,
    secrets,
  };
}

/** Problems that stop both the probe and the save. */
function draftProblem(draft: McpServerDraft): string | undefined {
  if (!["stdio", "http", "sse"].includes(draft.transport)) {
    return "The draft has no transport.";
  }
  const errors = planMcpServerEntry(draft).errors;
  if (errors.length) return errors.join(" ");
  if (draft.transport === "stdio" && (draft.args ?? []).some((a) => a === "")) {
    return "An argument is empty. Fill in every required value.";
  }
  return undefined;
}

const EXPIRED =
  "A hidden value from the paste is no longer kept. Paste the server again.";

function analyze(
  draft: McpServerDraft,
  host: McpWizardHost,
  workspaceDir?: string,
) {
  const platform = host.platform ?? process.platform;
  const analysis = analyzeLaunch(draft, {
    platform,
    homeDir: host.homeDir ?? os.homedir(),
    ...(workspaceDir ? { workspaceDir } : {}),
  });
  const runtime =
    draft.transport === "stdio" && draft.command
      ? checkRuntime(draft.command, draft.args ?? [], {
          platform,
          env: host.env,
        })
      : undefined;
  return { analysis, runtime };
}

// ---- the handlers ----

type On = (
  name: any,
  handler: (msg: { data: any }) => Promise<unknown>,
) => void;

// ---- folders and trust ----

const samePath = (a: string, b: string) => {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
};

async function openFolders(host: McpWizardHost): Promise<string[]> {
  if (host.projectDirs) return await host.projectDirs();
  const one = await host.projectDir();
  return one ? [one] : [];
}

/**
 * The open folder a request names. The webview's `folder` only chooses
 * among the folders core lists; it is never used as a path.
 */
function pickFolder(dirs: string[], folder: unknown): string | undefined {
  if (folder === undefined || folder === null || folder === "") return dirs[0];
  return dirs.find((d) => samePath(d, String(folder)));
}

function folderTrust(host: McpWizardHost, dir: string): McpFolderTrust {
  if (host.folderTrust) return host.folderTrust(dir);
  try {
    // The same record the loader reads: the folder's MCP files as they are
    // now, against the fingerprint the person trusted
    const mcp = inspectProjectConfig(dir).find((s) => s.scope === "mcp");
    if (mcp === undefined) return "none";
    return mcp.trusted ? "trusted" : "untrusted";
  } catch {
    return "untrusted";
  }
}

type Listed = McpServerListing & { folder?: string };

/** Every saved server: the person's own, then each open folder's. */
async function listAll(
  host: McpWizardHost,
): Promise<{ servers: Listed[]; problems: string[] }> {
  const user = listMcpServers({
    configPath: host.configPath(),
    ...(host.globalMcpDir ? { globalMcpDir: host.globalMcpDir() } : {}),
  });
  const servers: Listed[] = [...user.servers];
  const problems = [...user.problems];
  for (const dir of await openFolders(host)) {
    const project = listMcpServers({ configPath: "", projectDir: dir });
    servers.push(...project.servers.map((s) => ({ ...s, folder: dir })));
    problems.push(...project.problems);
  }
  return { servers, problems };
}

const sameServerName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

function matching(servers: Listed[], t: McpWizardTarget): Listed[] {
  return servers.filter(
    (s) =>
      sameServerName(s.name, String(t?.name ?? "")) &&
      (!t.scope || s.scope === t.scope) &&
      (!t.folder || (s.folder !== undefined && samePath(s.folder, t.folder))),
  );
}

function webviewListing(s: Listed): McpWizardListing {
  const entry = s.entry;
  const names = (m: unknown) =>
    m && typeof m === "object" ? Object.keys(m) : [];
  return {
    name: s.name,
    scope: s.scope,
    file: s.file,
    transport: s.transport,
    ...(s.folder ? { folder: s.folder } : {}),
    target: maskCommandForDisplay(s.target),
    secrets: [...s.secrets],
    envNames: names(entry.env),
    headerNames: names(
      (entry.requestOptions as { headers?: unknown } | undefined)?.headers,
    ),
  };
}

async function probe(
  req: McpWizardProbeRequest,
  host: McpWizardHost,
  held: HeldValues,
): Promise<McpWizardProbeResponse> {
  // Nothing starts and nothing connects without the person's explicit yes
  if (req?.consent !== true) {
    return {
      ran: false,
      reason: "no-consent",
      error:
        "Not tested: the test runs the command or connects to the server, and that needs your go-ahead.",
    };
  }
  const resolved = resolveHeld(req.draft, held);
  const refuse = (
    reason: McpWizardRefusal,
    error: string,
    missing?: string[],
  ) =>
    scrubSecrets<McpWizardProbeResponse>(
      { ran: false, reason, error, ...(missing ? { missing } : {}) },
      resolved.secrets,
    );
  if (resolved.expired) return refuse("expired", EXPIRED);
  const problem = draftProblem(resolved.draft);
  if (problem) return refuse("invalid", problem);
  const { analysis } = analyze(resolved.draft, host, await host.projectDir());
  if (analysis.blocked) {
    return refuse(
      "blocked",
      "Not tested: a safety check blocks this server. Change the command or URL first.",
    );
  }
  // The loader's rule: nothing a folder defines starts before the folder's
  // MCP files are trusted. The test is no way around it.
  if (req.scope === "project") {
    const dir = pickFolder(await openFolders(host), req.folder);
    if (dir && folderTrust(host, dir) === "untrusted") {
      return refuse(
        "untrusted",
        "Not tested: this folder's MCP servers are not trusted yet, so nothing in it is started. Trust the folder first, then test again.",
      );
    }
  }
  const filled = await withStoredSecrets(resolved.draft, host);
  if (filled.missing.length) {
    return refuse(
      "missing-values",
      `Not tested: ${filled.missing.join(", ")} has no value yet.`,
      filled.missing,
    );
  }
  const run = host.probe ?? probeMcpServer;
  const result = await run(filled.draft, {
    ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    ...(host.probeIde ? { ide: host.probeIde } : {}),
    platform: host.platform ?? process.platform,
  });
  return scrubSecrets<McpWizardProbeResponse>({ ran: true, result }, [
    ...resolved.secrets,
    ...filled.secrets,
  ]);
}

async function save(
  req: McpWizardSaveRequest,
  host: McpWizardHost,
  held: HeldValues,
): Promise<McpWizardSaveResponse> {
  const scope: McpServerScope = req?.scope === "project" ? "project" : "user";
  const resolved = resolveHeld(req.draft, held);
  const answer = (r: McpWizardSaveResponse) =>
    scrubSecrets(r, resolved.secrets);
  if (resolved.expired)
    return answer({ ok: false, reason: "expired", error: EXPIRED });
  const problem = draftProblem(resolved.draft);
  if (problem) return answer({ ok: false, reason: "invalid", error: problem });
  const projectDir = pickFolder(await openFolders(host), req?.folder);
  if (analyze(resolved.draft, host, projectDir).analysis.blocked) {
    return answer({
      ok: false,
      reason: "blocked",
      error:
        "Not saved: a safety check blocks this server. Change the command or URL first.",
    });
  }
  if (scope === "project" && !projectDir) {
    return answer({
      ok: false,
      reason: "no-project",
      error: "Open a folder to save a server for this project.",
    });
  }
  const secrets = {
    ide: host.ide,
    storage: await host.secretStorage(),
    continueDir: host.continueDir(),
  };
  const r =
    scope === "project"
      ? await addMcpServerToProjectFile(resolved.draft, {
          projectDir: projectDir!,
          configPath: host.configPath(),
          secrets,
        })
      : await addMcpServerToUserConfig(resolved.draft, {
          configPath: host.configPath(),
          secrets,
        });
  if (!r.ok) return answer(r);
  await host.reload("MCP server added (mcp/save message)");
  // The entry is left out: it is the file's business, and names are enough here
  return answer({
    ok: true,
    scope,
    file: r.file,
    name: r.name,
    secretsStored: r.secretsStored,
    secretsPending: r.secretsPending,
    warnings: r.warnings,
  });
}

/** Register the add dialog's messages on core's messenger. */
export function registerMcpWizardHandlers(
  on: On,
  host: McpWizardHost,
  held: HeldValues = new HeldValues(),
): void {
  on("mcp/listTemplates", async (): Promise<McpTemplateSummary[]> =>
    templateSummaries(),
  );

  on("mcp/parsePaste", async ({ data }): Promise<McpWizardParseResponse> =>
    parse(data ?? { text: "" }, held),
  );

  on(
    "mcp/analyzeLaunch",
    async ({ data }): Promise<McpWizardAnalyzeResponse> => {
      const resolved = resolveHeld(data.draft, held);
      const { analysis, runtime } = analyze(
        resolved.draft,
        host,
        await host.projectDir(),
      );
      return scrubSecrets(
        {
          analysis,
          ...(runtime ? { runtime } : {}),
          expired: resolved.expired > 0,
        },
        resolved.secrets,
      );
    },
  );

  on("mcp/probe", async ({ data }) => probe(data, host, held));

  on("mcp/save", async ({ data }) => save(data, host, held));

  on("mcp/list", async (): Promise<McpWizardListResponse> => {
    const list = await listAll(host);
    return {
      servers: list.servers.map(webviewListing),
      problems: list.problems,
    };
  });

  on("mcp/remove", async ({ data }): Promise<McpWizardRemoveResponse> => {
    const name = String(data?.name ?? "");
    const matches = matching((await listAll(host)).servers, {
      name,
      scope:
        data?.scope === "user" || data?.scope === "project"
          ? data.scope
          : undefined,
      folder: typeof data?.folder === "string" ? data.folder : undefined,
    } as McpWizardTarget);
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
        error: `${matches.length} saved servers are called ${name}. Say which one.`,
        matches: matches.map(webviewListing),
      };
    }
    const r = removeListedMcpServer(matches[0], host.configPath());
    if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
    await host.reload("MCP server removed (mcp/remove message)");
    return r;
  });

  on("mcp/scopes", async (): Promise<McpWizardScopesResponse> => {
    const dirs = await openFolders(host);
    const configPath = host.configPath();
    return {
      user: { file: configPath, exists: fileExists(configPath) },
      folders: dirs.map((dir) => ({
        dir,
        name: path.basename(dir) || dir,
        mcpDir: projectMcpServerDir(dir),
        trust: folderTrust(host, dir),
      })),
      secretStore: {
        kind: await host.secretStorage(),
        envFile: path.join(host.continueDir(), ".env"),
      },
      defaults: {
        connectionTimeoutMs: DEFAULT_MCP_TIMEOUT,
        probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
        toolCallTimeoutMs: DEFAULT_MCP_TOOL_TIMEOUT,
        inheritedEnv: ["PATH", ...COMMONS_ENV_VARS],
        ...(dirs[0] ? { cwd: dirs[0] } : {}),
      },
    };
  });

  on("mcp/getDraft", async ({ data }): Promise<McpWizardGetDraftResponse> => {
    const found = await findOne(host, data);
    if (!found.ok) return found;
    const edit = entryToEditDraft(found.server.entry);
    return {
      ok: true,
      listing: webviewListing(found.server),
      draft: heldDraft(edit.draft, held),
      keptKeys: edit.keptKeys,
      ...(edit.notEditable ? { notEditable: edit.notEditable } : {}),
    };
  });

  on("mcp/update", async ({ data }) => update(data, host, held));

  on("mcp/move", async ({ data }) => move(data, host));
}

function fileExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

async function findOne(
  host: McpWizardHost,
  target: McpWizardTarget | undefined,
): Promise<
  | { ok: true; server: Listed; all: Listed[] }
  | { ok: false; reason: "not-found"; error: string }
> {
  const all = (await listAll(host)).servers;
  const matches = target?.name ? matching(all, target) : [];
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: "not-found",
      error:
        matches.length === 0
          ? `There is no saved server called ${String(target?.name ?? "")}. It may have been removed or renamed in its file.`
          : `${matches.length} saved servers are called ${target!.name}. Edit the file instead.`,
    };
  }
  return { ok: true, server: matches[0], all };
}

/**
 * A draft read from a file, for the webview: a credential written in the
 * file is swapped for a held marker, as for a paste, so the value never
 * reaches the page. References and ordinary values go as they are.
 */
function heldDraft(draft: McpServerDraft, held: HeldValues): McpServerDraft {
  const values = (list: McpDraftValue[] | undefined) =>
    list?.map((v) =>
      v.secret && !referenceIn(v.value)
        ? { ...v, value: held.hold(v.value) }
        : v,
    );
  const secretArgs = new Set(draft.secretArgs ?? []);
  const { secretArgs: _dropped, ...rest } = draft;
  return {
    ...rest,
    ...(draft.args
      ? {
          args: draft.args.map((a, i) =>
            secretArgs.has(i) ? held.hold(a) : a,
          ),
        }
      : {}),
    ...(draft.url === undefined ? {} : { url: webviewUrl(draft.url, held) }),
    ...(draft.env ? { env: values(draft.env) } : {}),
    ...(draft.headers ? { headers: values(draft.headers) } : {}),
  };
}

async function update(
  req: McpWizardUpdateRequest,
  host: McpWizardHost,
  held: HeldValues,
): Promise<McpWizardSaveResponse> {
  const resolved = resolveHeld(req.draft, held);
  const answer = (r: McpWizardSaveResponse) =>
    scrubSecrets(r, resolved.secrets);
  if (resolved.expired)
    return answer({ ok: false, reason: "expired", error: EXPIRED });
  const problem = draftProblem(resolved.draft);
  if (problem) return answer({ ok: false, reason: "invalid", error: problem });
  const found = await findOne(host, req.target);
  if (!found.ok) {
    return answer({ ok: false, reason: "no-file", error: found.error });
  }
  const { server, all } = found;
  if (
    analyze(resolved.draft, host, server.folder ?? (await host.projectDir()))
      .analysis.blocked
  ) {
    return answer({
      ok: false,
      reason: "blocked",
      error:
        "Not saved: a safety check blocks this server. Change the command or URL first.",
    });
  }
  // A folder's server must not take a name the person's own server has (the
  // loader would drop it); the person's own must be unique among their own
  const others = all.filter(
    (s) => s !== server && (server.scope === "project" || s.scope === "user"),
  );
  const r = await updateMcpServer(server, resolved.draft, {
    otherNames: others.map((s) => s.name),
    secrets: {
      ide: host.ide,
      storage: await host.secretStorage(),
      continueDir: host.continueDir(),
    },
  });
  if (!r.ok) return answer(r);
  await host.reload("MCP server changed (mcp/update message)");
  return answer({
    ok: true,
    scope: server.scope,
    file: r.file,
    name: r.name,
    secretsStored: r.secretsStored,
    secretsPending: r.secretsPending,
    warnings: r.warnings,
  });
}

async function move(
  req: McpWizardMoveRequest,
  host: McpWizardHost,
): Promise<McpWizardMoveResponse> {
  const found = await findOne(host, req?.target);
  if (!found.ok) return found;
  const { server, all } = found;
  const scope: McpServerScope =
    req.to?.scope === "project" ? "project" : "user";
  const projectDir =
    scope === "project"
      ? pickFolder(await openFolders(host), req.to?.folder)
      : undefined;
  if (scope === "project" && !projectDir) {
    return {
      ok: false,
      reason: "no-project",
      error: "Open a folder to save a server for this workspace.",
    };
  }
  // From a folder to "all my projects": its command would start from now on
  // without the folder's trust, so the person must have said yes to exactly that
  if (server.scope === "project" && scope === "user" && req.consent !== true) {
    return {
      ok: false,
      reason: "no-consent",
      error:
        "Not copied: a server from this folder would start for every project, and that needs your go-ahead.",
    };
  }
  const { draft } = entryToEditDraft(server.entry);
  if (analyze(draft, host, projectDir ?? server.folder).analysis.blocked) {
    return {
      ok: false,
      reason: "blocked",
      error:
        "Not copied: a safety check blocks this server. Change the command or URL in its file first.",
    };
  }
  const copy = req.copy === true;
  // The names the destination must not repeat. A folder's server must not
  // repeat one of the person's own either: the loader keeps theirs.
  const taken = all
    .filter((s) => (copy ? true : s !== server))
    .filter((s) => scope === "project" || s.scope === "user")
    .map((s) => ({ name: s.name, file: s.file }));
  const r = await moveMcpServer(
    server,
    { scope, configPath: host.configPath(), projectDir },
    {
      copy,
      ...(typeof req.newName === "string" && req.newName.trim()
        ? { newName: req.newName }
        : {}),
      taken,
      secrets: {
        ide: host.ide,
        storage: await host.secretStorage(),
        continueDir: host.continueDir(),
      },
    },
  );
  if (!r.ok) return r;
  if (server.scope === "project" && scope === "user") {
    try {
      await host.onLoosened?.({ name: r.name, from: r.from, to: r.to });
    } catch {
      // the record never undoes a move that is already written
    }
  }
  await host.reload(
    copy
      ? "MCP server copied (mcp/move message)"
      : "MCP server moved (mcp/move message)",
  );
  return { ...r, scope };
}
