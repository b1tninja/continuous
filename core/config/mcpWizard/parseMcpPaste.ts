import { fetchAndRunHit } from "../../tools/permissions/fetchAndRun";

import {
  logicalLines,
  splitSegments,
  tokenizeShellLine,
  type ShellToken,
} from "./shellWords";
import type {
  McpCandidate,
  McpNamedValue,
  McpPasteFormat,
  McpPasteResult,
  McpWizardTransport,
} from "./types";
import { foreignVariablesIn, namedValue } from "./valueHints";

/*
  MCPW1: read what a person pasted from a README (a JSON block, a command
  line, a URL, a `claude mcp add` line, an install link) and return the
  servers it describes. Pure: nothing is resolved, fetched, installed or
  started, and the result is data for the review screen. A paste that is not
  understood returns no candidates and says why; it never guesses a server
  out of prose.
*/

const MAX_PASTE = 200_000;

export function parseMcpPaste(text: string): McpPasteResult {
  const result: McpPasteResult = { candidates: [], warnings: [] };
  if (typeof text !== "string" || !text.trim()) return result;
  let input = text.replace(/^\uFEFF/, "");
  if (input.length > MAX_PASTE) {
    result.warnings.push(
      `Only the first ${MAX_PASTE} characters of the paste were read.`,
    );
    input = input.slice(0, MAX_PASTE);
  }
  const blocks = fencedBlocks(input);
  for (const block of blocks ?? [input]) parseBlock(block, result);
  result.candidates = dedupe(result.candidates);
  return result;
}

/** Bodies of the ``` fences, or undefined when the text has none. */
function fencedBlocks(text: string): string[] | undefined {
  const re = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[2]);
  return out.length ? out : undefined;
}

function parseBlock(block: string, result: McpPasteResult) {
  const body = block.trim();
  if (!body) return;
  const asJson = jsonOf(body);
  if (asJson.kind === "json") {
    fromJsonDocument(asJson.value, result, "server-json");
    return;
  }
  if (asJson.kind === "broken") {
    result.warnings.push(asJson.why);
    return;
  }
  if (/^\s*\[mcp_servers\./m.test(body)) {
    fromCodexToml(body, result);
    return;
  }
  for (const line of logicalLines(body)) parseLine(line, result);
}

// ---------------------------------------------------------------------------
// JSON

type JsonRead =
  | { kind: "json"; value: unknown }
  | { kind: "broken"; why: string }
  | { kind: "not-json" };

/** Remove `//` and `/* *\/` comments and trailing commas outside strings (JSONC). */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\") j++;
      }
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function jsonOf(body: string): JsonRead {
  // A leading `# Add this to claude_desktop_config.json` line is prose
  const text = body.replace(/^(?:\s*#[^\n]*\n)+/, "").trim();
  if (!/^[{"[]/.test(text)) return { kind: "not-json" };
  // A bare key (`"mcpServers": {...}`) is a fragment of an object
  const attempts = [text, `{${text}}`, `{${text.replace(/,\s*$/, "")}}`];
  for (const attempt of attempts) {
    try {
      return { kind: "json", value: JSON.parse(stripJsonc(attempt)) };
    } catch {
      // try the next form
    }
  }
  if (/^\[/.test(text) && !/mcpServers|"command"|"url"/.test(text)) {
    return { kind: "not-json" };
  }
  const elided = /(^|[\s{,[])\.\.\.(?=[\s,}\]]|$)|…/.test(text);
  return {
    kind: "broken",
    why: elided
      ? "A JSON block has parts left out (`...`), so it was not read. Paste the whole block."
      : "A block looks like JSON but does not parse, so it was not read. Check for a missing brace or quote, or paste the whole block.",
  };
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fromJsonDocument(
  doc: unknown,
  result: McpPasteResult,
  single: McpPasteFormat,
  nameHint?: string,
  extraSecretInputs: ReadonlySet<string> = new Set(),
) {
  if (!isObject(doc)) {
    result.warnings.push("The JSON is not an object with servers in it.");
    return;
  }
  const secretInputs = vscodeSecretInputs(doc);
  for (const id of extraSecretInputs) secretInputs.add(id);
  const groups: [McpPasteFormat, Record<string, any>][] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (!isObject(value)) continue;
    if (/(^|\.)mcpServers$/.test(key)) groups.push(["mcpServers-json", value]);
    else if (key === "servers") groups.push(["vscode-json", value]);
    else if (key === "context_servers") groups.push(["zed-json", value]);
    else if (key === "mcp") {
      if (isObject(value.servers)) groups.push(["vscode-json", value.servers]);
      else groups.push(["opencode-json", value]);
      for (const id of vscodeSecretInputs(value)) secretInputs.add(id);
    }
  }
  if (groups.length === 0) {
    if (looksLikeServer(doc)) {
      const name =
        typeof doc.name === "string" && doc.name.trim()
          ? doc.name.trim()
          : nameHint;
      const c = fromServerEntry(name, doc, single, secretInputs);
      if (c) result.candidates.push(c);
      else result.warnings.push("The JSON server entry has no command or URL.");
      return;
    }
    result.warnings.push(
      "The JSON has no `mcpServers`, `servers` or `context_servers`, and is not a server entry.",
    );
    return;
  }
  for (const [format, entries] of groups) {
    let found = 0;
    for (const [name, entry] of Object.entries(entries)) {
      if (!isObject(entry)) continue;
      if (!looksLikeServer(entry)) {
        result.warnings.push(
          `"${name}" has no command or URL, so it was skipped.`,
        );
        continue;
      }
      const c = fromServerEntry(name, entry, format, secretInputs);
      if (c) {
        result.candidates.push(c);
        found++;
      }
    }
    if (found === 0 && Object.keys(entries).length === 0) {
      result.warnings.push("The server list in the JSON is empty.");
    }
  }
}

function withoutKey(o: Record<string, any>, key: string): Record<string, any> {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

function looksLikeServer(e: Record<string, any>): boolean {
  return (
    typeof e.command === "string" ||
    Array.isArray(e.command) ||
    isObject(e.command) ||
    typeof e.url === "string" ||
    typeof e.serverUrl === "string" ||
    typeof e.httpUrl === "string"
  );
}

/** VS Code `inputs` with `password: true`: their references are secrets. */
function vscodeSecretInputs(doc: Record<string, any>): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(doc.inputs)) return out;
  for (const i of doc.inputs) {
    if (isObject(i) && typeof i.id === "string" && i.password === true) {
      out.add(i.id);
    }
  }
  return out;
}

const KNOWN_KEYS = new Set([
  "name",
  "type",
  "transport",
  "command",
  "args",
  "env",
  "environment",
  "cwd",
  "url",
  "serverUrl",
  "httpUrl",
  "headers",
  "http_headers",
  "requestOptions",
]);

function transportOfEntry(
  e: Record<string, any>,
  hasUrl: boolean,
): { transport?: McpWizardTransport; guessed: boolean; unsupported?: string } {
  const raw =
    typeof e.type === "string"
      ? e.type
      : typeof e.transport === "string"
        ? e.transport
        : "";
  const t = raw.toLowerCase().replace(/[_\s]/g, "-");
  if (t === "stdio" || t === "local")
    return { transport: "stdio", guessed: false };
  if (["http", "streamable-http", "streamablehttp", "remote"].includes(t)) {
    return { transport: "http", guessed: false };
  }
  if (t === "sse") return { transport: "sse", guessed: false };
  if (t) return { guessed: false, unsupported: raw };
  if (!hasUrl) return { transport: "stdio", guessed: false };
  if (typeof e.httpUrl === "string")
    return { transport: "http", guessed: false };
  return { transport: transportOfUrl(urlOfEntry(e) ?? ""), guessed: true };
}

function urlOfEntry(e: Record<string, any>): string | undefined {
  for (const k of ["url", "httpUrl", "serverUrl"]) {
    if (typeof e[k] === "string" && e[k].trim()) return e[k].trim();
  }
  return undefined;
}

function transportOfUrl(url: string): McpWizardTransport {
  return /\/sse\/?(?:[?#]|$)/i.test(url) ? "sse" : "http";
}

function fromServerEntry(
  name: string | undefined,
  e: Record<string, any>,
  format: McpPasteFormat,
  secretInputs: ReadonlySet<string>,
): McpCandidate | undefined {
  const warnings: string[] = [];
  const read = commandOfEntry(e, warnings);
  let { command, args } = read;
  const env = read.env;

  const url = urlOfEntry(e);
  if (command !== undefined && !command.trim()) command = undefined;
  if (command === undefined && url === undefined) return undefined;

  const { transport, guessed, unsupported } = transportOfEntry(
    e,
    command === undefined,
  );
  if (!transport) {
    warnings.push(
      `The server type "${unsupported}" is not supported here, so this entry was not added.`,
    );
    return undefined;
  }

  // "command": "npx -y pkg" with no args: one string holding the whole line
  if (
    transport === "stdio" &&
    command &&
    !args?.length &&
    /\s/.test(command.trim()) &&
    /^[A-Za-z0-9._-]+\s/.test(command.trim())
  ) {
    const words = tokenizeShellLine(command).filter(
      (t): t is string => typeof t === "string",
    );
    command = words[0];
    args = words.slice(1);
    warnings.push(
      "The command was one line of text; it was split into the program and its arguments. Check them.",
    );
  }

  const headersRaw = headersOfEntry(e);

  const unmapped = Object.keys(e).filter((k) => !KNOWN_KEYS.has(k));
  if (unmapped.length) {
    warnings.push(`Not carried over: ${unmapped.join(", ")}.`);
  }
  if (e.disabled === true || e.enabled === false) {
    warnings.push("The source marks this server as turned off.");
  }

  const envValues = Object.entries(env ?? {}).map(([k, v]) =>
    namedValue(k, v, secretInputs),
  );
  const headerValues = Object.entries(headersRaw ?? {}).map(([k, v]) =>
    namedValue(k, v, secretInputs),
  );
  noteReferences(envValues, headerValues, warnings);
  const foreign = [command ?? "", ...(args ?? []), url ?? "", e.cwd ?? ""]
    .filter((s): s is string => typeof s === "string")
    .flatMap(foreignVariablesIn)
    .filter((v) => !/^\{?\s*secrets\./.test(v));
  if (foreign.length) {
    warnings.push(
      `Contains variables that Continuous does not fill in: ${[...new Set(foreign)].map((v) => "${" + v + "}").join(", ")}. Replace them with real values.`,
    );
  }

  const named = name?.trim();
  const guessedName = named
    ? undefined
    : command
      ? nameFromCommand(command, args ?? [])
      : nameFromUrl(url!);
  const candidate: McpCandidate = {
    name: named || guessedName || "mcp-server",
    nameGuessed: !named,
    transport,
    transportGuessed: guessed,
    env: transport === "stdio" ? envValues : [],
    headers: transport === "stdio" ? [] : headerValues,
    sourceFormat: format,
    warnings,
  };
  if (transport === "stdio") {
    if (!command) {
      warnings.push("A command-line server needs a command.");
      return undefined;
    }
    candidate.command = command;
    candidate.args = args ?? [];
    if (typeof e.cwd === "string" && e.cwd) candidate.cwd = e.cwd;
    if (url) warnings.push("The entry also had a URL; the command is used.");
  } else {
    if (!url) {
      warnings.push("A remote server needs a URL.");
      return undefined;
    }
    candidate.url = url;
    if (command)
      warnings.push("The entry also had a command; the URL is used.");
    if (envValues.length)
      warnings.push(
        "Environment variables do not apply to a remote server and were left out.",
      );
  }
  return candidate;
}

/** The program, its arguments and its environment, from any of the shapes. */
function commandOfEntry(
  e: Record<string, any>,
  warnings: string[],
): {
  command?: string;
  args?: string[];
  env?: Record<string, unknown>;
} {
  let command: string | undefined;
  let args: string[] | undefined;
  let env: Record<string, unknown> | undefined = isObject(e.env)
    ? e.env
    : isObject(e.environment)
      ? e.environment
      : undefined;
  if (isObject(e.command)) {
    // Zed's older form: "command": { "path": ..., "args": [...], "env": {...} }
    command = typeof e.command.path === "string" ? e.command.path : undefined;
    args = stringArray(e.command.args);
    if (isObject(e.command.env)) env = e.command.env;
  } else if (Array.isArray(e.command)) {
    // OpenCode: "command": ["npx", "pkg"]
    const parts = stringArray(e.command) ?? [];
    command = parts[0];
    args = parts.slice(1);
  } else if (typeof e.command === "string") {
    command = e.command;
    args = stringArray(e.args);
  }
  if (Array.isArray(e.args) && !args?.length) args = stringArray(e.args);
  if (
    Array.isArray(e.args) &&
    e.args.some((a: unknown) => typeof a !== "string")
  ) {
    warnings.push("Arguments that are not text were left out.");
  }
  return { command, args, env };
}

function headersOfEntry(
  e: Record<string, any>,
): Record<string, unknown> | undefined {
  if (isObject(e.headers)) return e.headers;
  if (isObject(e.http_headers)) return e.http_headers;
  if (isObject(e.requestOptions?.headers)) return e.requestOptions.headers;
  return undefined;
}

function noteReferences(
  env: McpNamedValue[],
  headers: McpNamedValue[],
  warnings: string[],
) {
  const refs = [...env, ...headers].filter(
    (v) => v.reference && v.reference.kind !== "secret",
  );
  if (refs.length) {
    warnings.push(
      `Values to fill in (the paste refers to another tool's variables): ${refs.map((r) => r.name).join(", ")}.`,
    );
  }
  const placeholders = [...env, ...headers].filter((v) => v.placeholder);
  if (placeholders.length) {
    warnings.push(
      `Replace the example values of ${placeholders.map((p) => p.name).join(", ")} with your own.`,
    );
  }
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((a): a is string => typeof a === "string");
}

// ---------------------------------------------------------------------------
// Codex TOML: [mcp_servers.<name>] with command, args, url, env

function fromCodexToml(body: string, result: McpPasteResult) {
  let current: Record<string, any> | undefined;
  let currentName = "";
  let inEnv = false;
  const servers: [string, Record<string, any>][] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[mcp_servers\.("?)([^\]"]+)\1(\.env)?\]$/.exec(line);
    if (header) {
      if (header[3]) {
        inEnv = header[2] === currentName;
        continue;
      }
      currentName = header[2];
      current = {};
      inEnv = false;
      servers.push([currentName, current]);
      continue;
    }
    if (line.startsWith("[")) {
      current = undefined;
      continue;
    }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    let value: unknown;
    try {
      value = JSON.parse(kv[2].replace(/'([^']*)'/g, '"$1"'));
    } catch {
      continue;
    }
    if (inEnv) (current.env ??= {})[kv[1]] = value;
    else current[kv[1]] = value;
  }
  for (const [name, entry] of servers) {
    const c = looksLikeServer(entry)
      ? fromServerEntry(name, entry, "codex-toml", new Set())
      : undefined;
    if (c) result.candidates.push(c);
    else
      result.warnings.push(
        `"${name}" has no command or URL, so it was skipped.`,
      );
  }
}

// ---------------------------------------------------------------------------
// Command lines, URLs and links

const NODE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const SETUP_WORDS = new Set([
  "setup",
  "install",
  "init",
  "login",
  "logout",
  "auth",
  "configure",
  "uninstall",
  "update",
  "upgrade",
  "add",
]);
const LAUNCHERS = new Set([
  "npx",
  "pnpx",
  "bunx",
  "pnpm",
  "yarn",
  "npm",
  "uvx",
  "uv",
  "pipx",
  "docker",
  "podman",
  "node",
  "python",
  "python3",
  "py",
  "deno",
  "bun",
]);

function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

function parseLine(rawLine: string, result: McpPasteResult) {
  let line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) return;
  line = line.replace(/^(?:\$|>|PS[^>]*>)\s+/, "");

  const link = fromInstallLink(line);
  if (link) {
    if (typeof link === "string") result.warnings.push(link);
    else result.candidates.push(link);
    return;
  }

  if (/^https?:\/\/\S+$/i.test(line)) {
    const c = fromBareUrl(line);
    if (typeof c === "string") result.warnings.push(c);
    else result.candidates.push(c);
    return;
  }

  const tokens = tokenizeShellLine(line);
  if (
    tokens.some((t) => typeof t === "object" && t.op === "|") &&
    fetchAndRunHit(line)
  ) {
    result.warnings.push(
      "A line downloads a script and runs it (`curl ... | sh`). That installs something; it is not an MCP server and was not read.",
    );
    return;
  }
  for (const seg of splitSegments(tokens)) {
    parseSegment(seg.words, result);
  }
}

function parseSegment(words: string[], result: McpPasteResult) {
  const env: [string, string][] = [];
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
    const eq = words[i].indexOf("=");
    env.push([words[i].slice(0, eq), words[i].slice(eq + 1)]);
    i++;
  }
  const rest = words.slice(i);
  if (rest.length === 0) return;
  const prog = programName(rest[0]);

  if (prog === "claude" && rest[1] === "mcp") {
    if (rest[2] === "add")
      return pushOrWarn(result, fromClaudeAdd(rest.slice(3)));
    if (rest[2] === "add-json") {
      return fromAddJson(rest.slice(3), result, "claude-mcp-add-json");
    }
    result.warnings.push(
      `\`claude mcp ${rest[2] ?? ""}\` does not add a server.`,
    );
    return;
  }
  if (
    (prog === "code" || prog === "code-insiders") &&
    rest.includes("--add-mcp")
  ) {
    const json = rest[rest.indexOf("--add-mcp") + 1];
    return fromAddJson(
      json === undefined ? [] : [json],
      result,
      "code-add-mcp",
      true,
    );
  }
  if (
    rest[1] === "mcp" &&
    rest[2] === "add" &&
    /^[a-z][a-z0-9-]*$/.test(prog)
  ) {
    return pushOrWarn(result, fromGenericAdd(prog, rest.slice(3)));
  }
  if (!LAUNCHERS.has(prog)) return;
  pushOrWarn(result, fromLauncher(rest, env, "command-line"));
}

function pushOrWarn(
  result: McpPasteResult,
  c: McpCandidate | string | undefined,
) {
  if (c === undefined) return;
  if (typeof c === "string") result.warnings.push(c);
  else result.candidates.push(c);
}

function fromAddJson(
  words: string[],
  result: McpPasteResult,
  format: McpPasteFormat,
  nameInJson = false,
) {
  const name = nameInJson ? undefined : words[0];
  const json = nameInJson ? words[0] : words[1];
  if (!json) {
    result.warnings.push("The command has no JSON server definition.");
    return;
  }
  const read = jsonOf(json);
  if (read.kind !== "json") {
    result.warnings.push("The JSON in the command does not parse.");
    return;
  }
  const before = result.candidates.length;
  fromJsonDocument(read.value, result, format, name);
  for (const c of result.candidates.slice(before)) c.sourceFormat = format;
}

/** `claude mcp add [options] <name> [<url> | -- <command> [args...]]` */
function fromClaudeAdd(words: string[]): McpCandidate | string {
  const opts = readAddOptions(words, new Set(["--client-secret"]));
  const [name, ...positional] = opts.positional;
  if (!name) return "`claude mcp add` has no server name.";
  const t = opts.transport?.toLowerCase();
  const warnings: string[] = [];
  if (opts.scope) {
    warnings.push(
      `The command asks for scope "${opts.scope}"; here you choose where it is saved.`,
    );
  }
  if (opts.oauth.length) {
    warnings.push(
      `Sign-in options not carried over: ${opts.oauth.join(", ")}.`,
    );
  }
  const looksUrl =
    positional[0] !== undefined && /^https?:\/\//i.test(positional[0]);
  if (!opts.command.length && (t === "http" || t === "sse" || looksUrl)) {
    const url = positional[0];
    if (!url) return "`claude mcp add` names a remote server but has no URL.";
    if (positional.length > 1) {
      warnings.push(
        `Extra words after the URL were ignored: ${positional.slice(1).join(" ")}.`,
      );
    }
    const headers = opts.headers.map(([k, v]) => namedValue(k, v));
    noteReferences([], headers, warnings);
    return {
      name,
      nameGuessed: false,
      transport:
        t === "sse" ? "sse" : t === "http" ? "http" : transportOfUrl(url),
      transportGuessed: !t,
      url,
      env: [],
      headers,
      sourceFormat: "claude-mcp-add",
      warnings,
    };
  }
  const cmd = opts.command.length ? opts.command : positional;
  if (!cmd.length) return "`claude mcp add` has no command to run.";
  const c = fromLauncher(cmd, opts.env, "claude-mcp-add", name, true);
  if (c === undefined)
    return "`claude mcp add` names a command that does not start a server.";
  if (typeof c === "string") return c;
  c.warnings.unshift(...warnings);
  return c;
}

/** `codex|gemini|amp|grok|droid mcp add <name> [--] <command...>` */
function fromGenericAdd(tool: string, words: string[]): McpCandidate | string {
  const opts = readAddOptions(words, new Set());
  const [name, ...positional] = opts.positional;
  if (!name) return `\`${tool} mcp add\` has no server name.`;
  let cmd = opts.command.length ? opts.command : positional;
  if (cmd.length === 1 && /\s/.test(cmd[0])) {
    cmd = tokenizeShellLine(cmd[0]).filter(
      (t): t is string => typeof t === "string",
    );
  }
  if (cmd.length === 1 && /^https?:\/\//i.test(cmd[0])) {
    const c = fromBareUrl(cmd[0], true);
    if (typeof c === "string") return c;
    return { ...c, name, nameGuessed: false, sourceFormat: "cli-mcp-add" };
  }
  if (!cmd.length) return `\`${tool} mcp add\` has no command to run.`;
  const c = fromLauncher(cmd, opts.env, "cli-mcp-add", name, true);
  if (c === undefined)
    return `\`${tool} mcp add\` names a command that does not start a server.`;
  if (typeof c === "string") return c;
  c.warnings.unshift(`Read as a \`${tool} mcp add\` command.`);
  return c;
}

interface AddOptions {
  transport?: string;
  scope?: string;
  env: [string, string][];
  headers: [string, string][];
  oauth: string[];
  positional: string[];
  command: string[];
}

function readAddOptions(words: string[], flagsOnly: Set<string>): AddOptions {
  const o: AddOptions = {
    env: [],
    headers: [],
    oauth: [],
    positional: [],
    command: [],
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      o.command = words.slice(i + 1);
      break;
    }
    // `mcp add name npx -y pkg`: once a program follows the name, every
    // later word is that program's, including its own flags
    if (o.positional.length >= 2 && !/^https?:\/\//i.test(o.positional[1])) {
      o.command = [...o.positional.slice(1), ...words.slice(i)];
      o.positional = o.positional.slice(0, 1);
      break;
    }
    const [flag, inline] =
      w.startsWith("--") && w.includes("=")
        ? [w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]
        : [w, undefined];
    const take = () => inline ?? words[++i] ?? "";
    if (flagsOnly.has(flag)) {
      o.oauth.push(flag);
      continue;
    }
    switch (flag) {
      case "--transport":
      case "-t":
        o.transport = take();
        continue;
      case "--scope":
      case "-s":
        o.scope = take();
        continue;
      case "--env":
      case "-e": {
        const kv = take();
        const eq = kv.indexOf("=");
        if (eq > 0) o.env.push([kv.slice(0, eq), kv.slice(eq + 1)]);
        else if (kv) o.env.push([kv, ""]);
        continue;
      }
      case "--header":
      case "-H": {
        const hv = take();
        const colon = hv.indexOf(":");
        if (colon > 0)
          o.headers.push([
            hv.slice(0, colon).trim(),
            hv.slice(colon + 1).trim(),
          ]);
        continue;
      }
      case "--client-id":
      case "--callback-port":
        o.oauth.push(flag);
        take();
        continue;
    }
    o.positional.push(w);
  }
  if (
    o.positional.length >= 2 &&
    !o.command.length &&
    !/^https?:\/\//i.test(o.positional[1])
  ) {
    o.command = o.positional.slice(1);
    o.positional = o.positional.slice(0, 1);
  }
  return o;
}

/** What a launcher line starts: npx, uvx, docker run, node, python ... */
function fromLauncher(
  words: string[],
  envPairs: [string, string][],
  format: McpPasteFormat,
  name?: string,
  explicit = false,
): McpCandidate | string | undefined {
  const [first, ...args] = words;
  const prog = programName(first);
  const warnings: string[] = [];

  if (
    NODE_RUNNERS.has(prog) ||
    (["pnpm", "yarn"].includes(prog) && args[0] === "dlx") ||
    (prog === "npm" && args[0] === "exec") ||
    (prog === "bun" && args[0] === "x")
  ) {
    const offset = NODE_RUNNERS.has(prog) ? 0 : 1;
    const pkgIndex = firstPositional(
      args,
      offset,
      new Set(["-p", "--package"]),
    );
    const pkg = pkgIndex === undefined ? undefined : args[pkgIndex];
    if (!pkg)
      return explicit ? `\`${first}\` has no package to run.` : undefined;
    const after = args.slice(pkgIndex! + 1);
    if (/^@modelcontextprotocol\/inspector(@|$)/.test(pkg)) {
      return "A line starts the MCP Inspector, a tool for testing servers. It was not read as a server; paste the server's own command.";
    }
    const reason = notAServerReason(after);
    if (reason) return reason;
  } else if (
    prog === "npm" ||
    prog === "pnpm" ||
    prog === "yarn" ||
    prog === "bun"
  ) {
    if (/^(?:i|install|add|ci)$/.test(args[0] ?? "")) {
      return "A line installs a package. That is a step before adding a server, not a server.";
    }
    if (!explicit) return undefined;
  } else if (prog === "uvx" || prog === "pipx") {
    const offset = prog === "pipx" ? (args[0] === "run" ? 1 : -1) : 0;
    if (offset < 0) {
      return /^install$/.test(args[0] ?? "")
        ? "A line installs a package. That is a step before adding a server, not a server."
        : undefined;
    }
    const pkgIndex = firstPositional(
      args,
      offset,
      new Set(["--from", "--with", "--python", "-p", "--spec"]),
    );
    if (pkgIndex === undefined)
      return explicit ? `\`${first}\` has no package to run.` : undefined;
    const reason = notAServerReason(args.slice(pkgIndex + 1));
    if (reason) return reason;
  } else if (prog === "docker" || prog === "podman") {
    const reason = dockerNotAServer(args);
    if (reason) return reason;
  } else if (prog === "uv") {
    // `uv pip install`, `uv sync`: only `uv run` and `uv tool run` start something
    if (!args.includes("run")) return undefined;
  } else if (prog === "python" || prog === "python3" || prog === "py") {
    if (args[0] === "-m" && /^pip$/.test(args[1] ?? "")) {
      return "A line installs a package. That is a step before adding a server, not a server.";
    }
    if (!args.length) return undefined;
  } else if (prog === "node" || prog === "deno") {
    if (!args.length) return undefined;
  }

  const env = envPairs.map(([k, v]) => namedValue(k, v));
  noteReferences(env, [], warnings);
  const foreign = words.flatMap(foreignVariablesIn);
  if (foreign.length) {
    warnings.push(
      `Contains variables that Continuous does not fill in: ${[...new Set(foreign)].map((v) => "${" + v + "}").join(", ")}. Replace them with real values.`,
    );
  }
  return {
    name: name ?? nameFromCommand(first, args),
    nameGuessed: name === undefined,
    transport: "stdio",
    transportGuessed: false,
    command: first,
    args,
    env,
    headers: [],
    sourceFormat: format,
    warnings,
  };
}

/** Index of the first word that is not an option (or an option's value). */
function firstPositional(
  args: string[],
  from: number,
  withValue: Set<string>,
): number | undefined {
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (withValue.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return i;
  }
  return undefined;
}

/** A package started with a setup subcommand, or as an HTTP server. */
function notAServerReason(after: string[]): string | undefined {
  const sub = after.find((a) => !a.startsWith("-"));
  if (
    sub !== undefined &&
    after.indexOf(sub) === 0 &&
    SETUP_WORDS.has(sub.toLowerCase())
  ) {
    return `A line runs a package's \`${sub}\` step. That sets something up; it is not the server itself.`;
  }
  const t = after.indexOf("--transport");
  const tv =
    t >= 0
      ? after[t + 1]?.toLowerCase()
      : after
          .find((a) => a.startsWith("--transport="))
          ?.split("=")[1]
          ?.toLowerCase();
  if (
    (tv && tv !== "stdio") ||
    after.includes("--port") ||
    after.some((a) => a.startsWith("--port=")) ||
    (sub !== undefined && /^(?:sse|streamablehttp|http)$/i.test(sub))
  ) {
    return "A line starts a server that listens on a network port. Add it by its URL (for example http://localhost:PORT/mcp) after it is running.";
  }
  return undefined;
}

function dockerNotAServer(args: string[]): string | undefined {
  if (args[0] !== "run") {
    return "A `docker` line that is not `docker run` does not start a server.";
  }
  let interactive = false;
  let detached = false;
  for (const a of args.slice(1)) {
    if (a === "--interactive" || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(a))
      interactive = true;
    if (a === "--detach" || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) detached = true;
  }
  if (detached) {
    return "A `docker run` line starts the container in the background (`-d`). An MCP server over stdio needs `-i` and no `-d`; a background container is reached by URL.";
  }
  if (!interactive) {
    return "A `docker run` line has no `-i`, so it cannot talk over stdio. It was not read as an MCP server.";
  }
  return undefined;
}

function fromBareUrl(url: string, explicit = false): McpCandidate | string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "A URL in the paste could not be read.";
  }
  const path = parsed.pathname.toLowerCase();
  const mcpish =
    /(^|[./-])mcp([./-]|$)/i.test(parsed.hostname) ||
    /(^|\/)(mcp|sse)(\/|$)/.test(path) ||
    /mcp/.test(path);
  if (!explicit && !mcpish) {
    return `The URL ${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname} does not look like an MCP endpoint (most end in /mcp or /sse), so it was not added. If it is one, paste it in a JSON entry with "url".`;
  }
  return {
    name: nameFromUrl(url),
    nameGuessed: true,
    transport: transportOfUrl(url),
    transportGuessed: true,
    url,
    env: [],
    headers: [],
    sourceFormat: "url",
    warnings: [],
  };
}

/** `vscode:mcp/install?{json}` and Cursor's `cursor://.../mcp/install?name=&config=` */
function fromInstallLink(line: string): McpCandidate | string | undefined {
  // The web redirect that README badges use:
  // https://insiders.vscode.dev/redirect/mcp/install?name=..&inputs=[..]&config={..}
  const web =
    /^https:\/\/(?:insiders\.)?vscode\.dev\/redirect\/mcp\/install\?(.+)$/i.exec(
      line,
    );
  if (web) {
    const params = new URLSearchParams(web[1]);
    let config: unknown;
    let inputs: unknown;
    try {
      config = JSON.parse(params.get("config") ?? "");
      inputs = params.get("inputs")
        ? JSON.parse(params.get("inputs")!)
        : undefined;
    } catch {
      return "The VS Code install link does not hold a readable server definition.";
    }
    if (!isObject(config))
      return "The VS Code install link has no server in it.";
    const doc = { ...config, ...(Array.isArray(inputs) ? { inputs } : {}) };
    const r: McpPasteResult = { candidates: [], warnings: [] };
    const name = params.get("name") ?? undefined;
    fromJsonDocument(
      withoutKey(doc, "inputs"),
      r,
      "vscode-link",
      name,
      vscodeSecretInputs(doc),
    );
    const c = r.candidates[0];
    if (!c)
      return r.warnings[0] ?? "The VS Code install link has no server in it.";
    c.sourceFormat = "vscode-link";
    c.warnings.unshift(
      "This came from an install link. A link proves nothing about who made it.",
    );
    return c;
  }
  const vs = /^(vscode(?:-insiders)?):\/?\/?mcp\/install\?(.+)$/i.exec(line);
  if (vs) {
    let json: unknown;
    try {
      json = JSON.parse(decodeURIComponent(vs[2]));
    } catch {
      return "The VS Code install link does not hold a readable server definition.";
    }
    const r: McpPasteResult = { candidates: [], warnings: [] };
    fromJsonDocument(json, r, "vscode-link");
    const c = r.candidates[0];
    if (!c)
      return r.warnings[0] ?? "The VS Code install link has no server in it.";
    c.sourceFormat = "vscode-link";
    c.warnings.unshift(
      "This came from an install link. A link proves nothing about who made it.",
    );
    return c;
  }
  const cu =
    /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?(.+)$/i.exec(line);
  if (cu) {
    const params = new URLSearchParams(cu[1]);
    const name = params.get("name") ?? undefined;
    const config = params.get("config");
    let json: unknown;
    try {
      json = JSON.parse(decodeBase64(config ?? ""));
    } catch {
      return "The Cursor install link does not hold a readable server definition.";
    }
    const r: McpPasteResult = { candidates: [], warnings: [] };
    fromJsonDocument(json, r, "cursor-link", name);
    const c = r.candidates[0];
    if (!c)
      return r.warnings[0] ?? "The Cursor install link has no server in it.";
    c.sourceFormat = "cursor-link";
    c.warnings.unshift(
      "This came from an install link. A link proves nothing about who made it.",
    );
    return c;
  }
  return undefined;
}

function decodeBase64(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = globalThis.atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Names

/** A short name from the package or image: `@modelcontextprotocol/server-github` is `github`. */
export function nameFromCommand(command: string, args: string[]): string {
  const prog = programName(command);
  let id: string | undefined;
  if (NODE_RUNNERS.has(prog) || prog === "uvx") {
    const i = firstPositional(
      args,
      0,
      new Set(["-p", "--package", "--from", "--with", "--python"]),
    );
    id = i === undefined ? undefined : args[i];
  } else if (["pnpm", "yarn", "npm", "pipx", "bun"].includes(prog)) {
    const i = firstPositional(args, 1, new Set(["-p", "--package", "--spec"]));
    id = i === undefined ? undefined : args[i];
  } else if (prog === "docker" || prog === "podman") {
    id = dockerImage(args);
  } else if (prog === "uv") {
    const run = args.indexOf("run");
    id =
      run >= 0
        ? args.slice(run + 1).find((a) => !a.startsWith("-"))
        : undefined;
  } else if (["python", "python3", "py"].includes(prog)) {
    id = args[0] === "-m" ? args[1] : args.find((a) => !a.startsWith("-"));
  } else if (prog === "node" || prog === "deno") {
    id = args.find((a) => !a.startsWith("-") && a !== "run");
  } else {
    id = command;
  }
  return shortName(id ?? command);
}

function dockerImage(args: string[]): string | undefined {
  const withValue = new Set([
    "-e",
    "--env",
    "-v",
    "--volume",
    "--mount",
    "--name",
    "-p",
    "--publish",
    "--network",
    "--net",
    "--entrypoint",
    "-u",
    "--user",
    "-w",
    "--workdir",
    "--env-file",
    "--platform",
    "--cap-add",
    "--cap-drop",
    "--add-host",
    "--label",
    "-l",
  ]);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (withValue.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

function shortName(id: string): string {
  let s = id.trim();
  s = s.replace(/^(?:https?:\/\/|git\+)/, "");
  // version: pkg@1.2.3, @scope/pkg@latest, pkg==1.0, image:tag
  s = s.replace(/(.)@[^/@]*$/, "$1").replace(/==.*$/, "");
  const parts = s.split(/[\\/]/).filter(Boolean);
  let last = (parts.pop() ?? s).replace(/:[^:]*$/, "");
  last = last.replace(/\.(?:js|mjs|cjs|ts|py)$/, "");
  if (
    /^(?:mcp|server|mcp-server|index|main|cli|app|dist|src)$/i.test(last) &&
    parts.length
  ) {
    last = parts.pop()!.replace(/^@/, "");
  }
  let name = last
    .replace(/^@/, "")
    .replace(/^(?:mcp[-_]server[-_]|server[-_]|mcp[-_])/i, "")
    .replace(/(?:[-_]mcp[-_]server|[-_]mcp|[-_]server)$/i, "")
    .replace(/^mcp_server_/, "")
    .replace(/_/g, "-");
  if (/\./.test(name)) name = name.replace(/^awslabs\./, "");
  return name || "mcp-server";
}

/** `https://mcp.notion.com/mcp` is `notion`; `https://api.githubcopilot.com/mcp/` is `githubcopilot`. */
export function nameFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "mcp-server";
  }
  if (/^(?:localhost|127\.|\[?::1\]?$)/.test(host)) return "local-server";
  const labels = host
    .split(".")
    .filter(
      (l) =>
        !/^(?:mcp|api|www|sse|com|io|dev|app|net|org|ai|co|global)$/.test(l),
    );
  return labels[0] ?? host.split(".")[0] ?? "mcp-server";
}

function dedupe(cs: McpCandidate[]): McpCandidate[] {
  const seen = new Set<string>();
  return cs.filter((c) => {
    const key = JSON.stringify([c.name, c.transport, c.command, c.args, c.url]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The token type, re-exported for tests. */
export type { ShellToken };
