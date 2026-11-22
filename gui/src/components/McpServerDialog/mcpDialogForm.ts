import type {
  McpWizardListing,
  McpWizardScopesResponse,
} from "core/config/mcpWizard/protocolHandlers";
import type { McpServerScope } from "core/config/mcpWizard/manageMcpServers";
import { joinShellWords } from "core/config/mcpWizard/shellWords";
import type {
  McpDraftValue,
  McpServerDraft,
} from "core/config/mcpWizard/types";

/*
  The form behind the Add / Edit MCP server dialog, as plain data and pure
  functions: what a draft from core looks like in the form, what the form
  sends back, and what it says about names and places. No React here.
*/

export type McpKind = "command" | "url";

/** How a value's text is known to the page. */
export type StoredAs =
  /** A `${{ secrets.NAME }}` reference: the value is in the secret store */
  | "reference"
  /** A marker for a credential core keeps (from a paste or a file) */
  | "held";

export interface ValueRow {
  id: number;
  name: string;
  value: string;
  secret: boolean;
  /** The person set "store as secret" by hand, so the name no longer decides. */
  secretTouched?: boolean;
  /** Set while `value` is a marker the person has not replaced. */
  stored?: StoredAs;
}

export interface ArgRow {
  id: number;
  value: string;
  stored?: StoredAs;
}

export interface McpForm {
  name: string;
  kind: McpKind;
  command: string;
  args: ArgRow[];
  env: ValueRow[];
  url: string;
  headers: ValueRow[];
  /** Not chosen yet when undefined: the person must say where it goes. */
  scope?: McpServerScope;
  /** The open folder, for "project". */
  folder?: string;
  // Advanced. An empty string is "not set": nothing is written to the file.
  cwd: string;
  timeoutSeconds: string;
  toolTimeoutSeconds: string;
  /** "" is not set: the connection tries Streamable HTTP, then SSE. */
  transport: "" | "http" | "sse";
}

let nextId = 1;
export const rowId = () => nextId++;

export function emptyForm(): McpForm {
  return {
    name: "",
    kind: "command",
    command: "",
    args: [],
    env: [],
    url: "",
    headers: [],
    cwd: "",
    timeoutSeconds: "",
    toolTimeoutSeconds: "",
    transport: "",
  };
}

const HELD = /\$\{\{\s*held\.[0-9a-f-]{36}\s*\}\}/;
const SECRET_REF = /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/;

export function storedAs(value: string): StoredAs | undefined {
  if (HELD.test(value)) return "held";
  if (SECRET_REF.test(value)) return "reference";
  return undefined;
}

/** The secret a reference names, for "Uses the stored secret NAME". */
export function secretNameIn(value: string): string | undefined {
  return SECRET_REF.exec(value)?.[1];
}

/**
 * Whether a variable or header name looks like a credential, so "store as
 * secret" starts on: `*_KEY`, `*_TOKEN`, `*SECRET*`, `Authorization` and
 * the like. The name alone decides; the person can turn it off.
 */
export function looksLikeCredentialName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (
    /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i.test(
      n,
    )
  ) {
    return true;
  }
  if (/secret|passw|credential|bearer/i.test(n)) return true;
  return /(?:^|[_-])(?:key|token|pat|apikey|auth)$/i.test(n);
}

function rows(values: McpDraftValue[] | undefined): ValueRow[] {
  return (values ?? []).map((v) => ({
    id: rowId(),
    name: v.name,
    value: v.value,
    secret: v.secret || looksLikeCredentialName(v.name),
    ...(storedAs(v.value) ? { stored: storedAs(v.value) } : {}),
  }));
}

/** A draft from core (a paste, a template, a saved entry) as the form. */
export function formFromDraft(
  draft: McpServerDraft,
  opts: { transportGuessed?: boolean } = {},
): McpForm {
  const remote = draft.transport !== "stdio";
  return {
    ...emptyForm(),
    name: draft.name ?? "",
    kind: remote ? "url" : "command",
    command: draft.command ?? "",
    args: (draft.args ?? []).map((value) => ({
      id: rowId(),
      value,
      ...(storedAs(value) ? { stored: storedAs(value) } : {}),
    })),
    env: rows(draft.env),
    url: draft.url ?? "",
    headers: rows(draft.headers),
    cwd: draft.cwd ?? "",
    timeoutSeconds:
      typeof draft.connectionTimeoutMs === "number"
        ? String(draft.connectionTimeoutMs / 1000)
        : "",
    toolTimeoutSeconds:
      typeof draft.toolTimeoutMs === "number"
        ? String(draft.toolTimeoutMs / 1000)
        : "",
    // A guess from the address is not the person's choice: it stays not set
    transport:
      !remote || draft.autoTransport || opts.transportGuessed
        ? ""
        : draft.transport === "sse"
          ? "sse"
          : "http",
  };
}

export interface FormProblems {
  name?: string;
  command?: string;
  args?: string;
  env?: string;
  url?: string;
  headers?: string;
  scope?: string;
  timeout?: string;
  toolTimeout?: string;
}

/** The number of seconds, or undefined when the text is not one. */
export function parseSeconds(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d+(?:\.\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 && n <= 3600 ? n : undefined;
}

function rowProblem(list: ValueRow[], noun: string): string | undefined {
  const seen = new Set<string>();
  for (const r of list) {
    const name = r.name.trim();
    if (!name && r.value.trim()) return `Give each ${noun} a name.`;
    if (!name) continue;
    if (seen.has(name.toLowerCase())) return `${name} is listed twice.`;
    seen.add(name.toLowerCase());
  }
  return undefined;
}

/** What stops Test and Save, field by field. `scope` only stops Save. */
export function formProblems(form: McpForm): FormProblems {
  const p: FormProblems = {};
  if (!form.name.trim()) p.name = "Give the server a name.";
  if (form.kind === "command") {
    if (!form.command.trim()) p.command = "Enter the command to run.";
    const last = form.args.length - 1;
    if (form.args.some((a, i) => a.value === "" && i !== last)) {
      p.args = "An argument is empty. Fill it in or remove it.";
    }
    const env = rowProblem(form.env, "variable");
    if (env) p.env = env;
  } else {
    if (!/^https?:\/\/\S+$/i.test(form.url.trim())) {
      p.url = "Enter an address that starts with https:// or http://.";
    }
    const headers = rowProblem(form.headers, "header");
    if (headers) p.headers = headers;
  }
  if (
    form.timeoutSeconds.trim() &&
    parseSeconds(form.timeoutSeconds) === undefined
  ) {
    p.timeout = "Enter a number of seconds, such as 30.";
  }
  if (
    form.toolTimeoutSeconds.trim() &&
    parseSeconds(form.toolTimeoutSeconds) === undefined
  ) {
    p.toolTimeout = "Enter a number of seconds, such as 120.";
  }
  if (!form.scope) p.scope = "Choose where to save it.";
  return p;
}

function values(list: ValueRow[]): McpDraftValue[] {
  return list
    .filter((r) => r.name.trim())
    .map((r) => ({
      name: r.name.trim(),
      value: r.value,
      secret: r.secret || r.stored !== undefined,
    }));
}

/** The arguments as they will be passed: a trailing empty row is not one. */
export function argsOf(form: McpForm): string[] {
  const list = form.args.map((a) => a.value);
  while (list.length && list[list.length - 1] === "") list.pop();
  return list;
}

/**
 * The draft to test or save. A setting the person left empty is left out,
 * so it stays unset in the file and the built-in behaviour applies.
 */
export function draftFromForm(form: McpForm): McpServerDraft {
  const timeout = parseSeconds(form.timeoutSeconds);
  const toolTimeout = parseSeconds(form.toolTimeoutSeconds);
  const common = {
    name: form.name.trim(),
    ...(timeout === undefined
      ? {}
      : { connectionTimeoutMs: Math.round(timeout * 1000) }),
    ...(toolTimeout === undefined
      ? {}
      : { toolTimeoutMs: Math.round(toolTimeout * 1000) }),
  };
  if (form.kind === "command") {
    return {
      ...common,
      transport: "stdio",
      command: form.command.trim(),
      args: argsOf(form),
      env: values(form.env),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
    };
  }
  const url = form.url.trim();
  return {
    ...common,
    // With no choice the connection decides; this is only a label for it
    transport:
      form.transport || (/\/sse\/?(?:[?#]|$)/i.test(url) ? "sse" : "http"),
    ...(form.transport === "" ? { autoTransport: true } : {}),
    url,
    headers: values(form.headers),
  };
}

const HIDDEN = "(hidden value)";

/** One argument as the preview shows it: never a marker's id. */
export function displayArg(value: string): string {
  return value.replace(new RegExp(HELD.source, "g"), HIDDEN);
}

/**
 * Exactly what would be started, one word per item, for "Will run". The
 * command is not passed through a shell: each item reaches the program as
 * one argument, whatever spaces or quotes it holds.
 */
export function willRun(form: McpForm): string[] {
  return [form.command.trim(), ...argsOf(form)].map(displayArg);
}

/** The same as one line, quoted only where a word needs it. */
export function willRunLine(form: McpForm): string {
  return joinShellWords(willRun(form));
}

/** Changes with anything that changes what is started. */
export function launchSignature(form: McpForm): string {
  return JSON.stringify([
    form.command.trim(),
    argsOf(form),
    form.cwd.trim(),
    form.env.map((e) => [e.name, e.value]),
  ]);
}

// ---- where it is saved ----

export const sepOf = (p: string) =>
  p.includes("\\") && !p.includes("/") ? "\\" : "/";

export const SCOPE_LABEL: Record<McpServerScope, string> = {
  user: "All projects",
  project: "This workspace",
};

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const samePath = (a?: string, b?: string) =>
  (a ?? "").replace(/[\\/]+$/, "").toLowerCase() ===
  (b ?? "").replace(/[\\/]+$/, "").toLowerCase();

export interface NameCheck {
  /** Stops Save. */
  error?: string;
  /** Does not stop Save. */
  note?: string;
}

/**
 * Whether the name is free where the server will be saved, and with what it
 * collides when it is not. `editing` is the server being edited: it does
 * not collide with itself.
 */
export function checkName(
  form: Pick<McpForm, "name" | "scope" | "folder">,
  saved: McpWizardListing[],
  editing?: { name: string; scope: McpServerScope; folder?: string },
): NameCheck {
  const name = form.name.trim();
  if (!name || !form.scope) return {};
  const others = saved.filter(
    (s) =>
      same(s.name, name) &&
      !(
        editing &&
        same(s.name, editing.name) &&
        s.scope === editing.scope &&
        (s.scope === "user" || samePath(s.folder, editing.folder))
      ),
  );
  const mine = others.find((s) => s.scope === "user");
  const here = others.find(
    (s) =>
      s.scope === "project" &&
      (!form.folder || samePath(s.folder, form.folder)),
  );
  if (form.scope === "user") {
    if (mine) {
      return {
        error: `A server called ${mine.name} is already saved for all your projects, in ${mine.file}.`,
      };
    }
    if (here) {
      return {
        note: `This workspace also has a server called ${here.name} (${here.file}). Yours will be used and the workspace one will not start.`,
      };
    }
    return {};
  }
  if (here) {
    return {
      error: `A server called ${here.name} is already saved for this workspace, in ${here.file}.`,
    };
  }
  if (mine) {
    return {
      error: `You already have a server called ${mine.name} for all your projects (${mine.file}). A workspace server cannot share its name: yours would be used instead.`,
    };
  }
  return {};
}

/** The file a save would write, to show before saving. */
export function targetFile(
  form: Pick<McpForm, "name" | "scope" | "folder">,
  scopes: McpWizardScopesResponse | undefined,
  fileName: (name: string) => string,
): string | undefined {
  if (!scopes || !form.scope) return undefined;
  if (form.scope === "user") return scopes.user.file;
  const folder =
    scopes.folders.find((f) => samePath(f.dir, form.folder)) ??
    scopes.folders[0];
  if (!folder) return undefined;
  return `${folder.mcpDir}${sepOf(folder.mcpDir)}${fileName(form.name || "name")}`;
}

/** Where a secret value is kept, in the product's words. */
export function secretPlace(
  scopes: McpWizardScopesResponse | undefined,
): string {
  if (!scopes) return "your secret store";
  return scopes.secretStore.kind === "secure"
    ? "the editor's secure storage"
    : scopes.secretStore.envFile;
}

const seconds = (ms: number) => {
  const s = ms / 1000;
  return `${s} second${s === 1 ? "" : "s"}`;
};

/**
 * What happens when a setting is left empty, in words, from what core
 * reports about its own behaviour. Never the word "default" alone.
 */
export function unsetText(scopes: McpWizardScopesResponse | undefined): {
  cwd: string;
  timeout: string;
  timeoutPlaceholder: string;
  transport: string;
  env: string;
  headers: string;
} {
  const d = scopes?.defaults;
  const several = (scopes?.folders.length ?? 0) > 1;
  return {
    cwd: d?.cwd
      ? several
        ? `Not set: the server starts in the first open folder, ${d.cwd}, whichever folder it is saved for.`
        : `Not set: the server starts in the open folder, ${d.cwd}.`
      : "Not set: no folder is open, so the server starts where the editor itself runs.",
    timeout: d
      ? `Not set: the editor waits ${seconds(d.connectionTimeoutMs)} for the server to connect.`
      : "Not set: the built-in limit applies.",
    timeoutPlaceholder: d ? String(d.connectionTimeoutMs / 1000) : "",
    transport: "Not set: tries streamable HTTP, then SSE",
    env: d
      ? `None: of the editor's own environment the server gets only ${d.inheritedEnv.join(", ")}.`
      : "None.",
    headers: "None: no extra headers are sent.",
  };
}

/**
 * What the tool call limit is while its own field is empty, from
 * core/context/mcp/mcpTimeouts.ts: it follows a connection timeout the
 * person set (as it did before it had a setting of its own), and is the
 * built-in limit otherwise. `follows` is that connection timeout, in
 * seconds, for "Set it separately".
 */
export function toolTimeoutUnset(
  scopes: McpWizardScopesResponse | undefined,
  timeoutSeconds: string,
): { text: string; follows?: number; placeholder: string } {
  const connection = parseSeconds(timeoutSeconds);
  if (connection !== undefined) {
    return {
      text: `Not set: follows your connection timeout, ${seconds(connection * 1000)}.`,
      follows: connection,
      placeholder: String(connection),
    };
  }
  const d = scopes?.defaults;
  return d
    ? {
        text: `Not set: each tool call may take ${seconds(d.toolCallTimeoutMs)}.`,
        placeholder: String(d.toolCallTimeoutMs / 1000),
      }
    : { text: "Not set: the built-in limit applies.", placeholder: "" };
}

/**
 * What a server's place means for its tools, from core/context/mcp/mcpTrust.ts:
 * a read-only claim is believed for the person's own servers and never for a
 * folder's.
 */
export function toolTrustText(scope: McpServerScope | undefined): string {
  if (scope === "project") {
    return "Saved for this workspace: when the server says a tool is read-only, that is not believed, so every tool asks first.";
  }
  if (scope === "user") {
    return "Saved for all your projects: a tool the server marks as read-only is believed and starts as Automatic.";
  }
  return "For a server saved for all your projects, a tool it marks as read-only starts as Automatic. For a workspace server that claim is not believed, so every tool asks first.";
}
