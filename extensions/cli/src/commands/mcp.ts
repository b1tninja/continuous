/**
 * `continuous mcp add <paste-or-file> [--dry-run]`: the add wizard's core
 * steps in the terminal (plans/research/mcp-server-wizard.md section 6.7).
 * Parse what was pasted, show what would run and what is risky, ask once
 * before the test connection (the test runs the command), then add the
 * server to your own config.yaml with secrets stored in ~/.continuous/.env.
 * `--dry-run` never starts or connects to anything and writes nothing.
 */

import * as fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";

import {
  addMcpServerToUserConfig,
  planMcpServerEntry,
  renderEntryYaml,
} from "core/config/mcpWizard/addMcpServer.js";
import {
  analyzeLaunch,
  type LaunchAnalysis,
} from "core/config/mcpWizard/analyzeLaunch.js";
import { parseMcpPaste } from "core/config/mcpWizard/parseMcpPaste.js";
import {
  probeMcpServer,
  type McpProbeResult,
} from "core/config/mcpWizard/probeMcpServer.js";
import type {
  McpCandidate,
  McpDraftValue,
  McpNamedValue,
  McpPasteFormat,
  McpPasteResult,
  McpServerDraft,
} from "core/config/mcpWizard/types.js";
import { maskCommandForDisplay } from "core/tools/permissions/displayMask.js";
import { readSecretFromEnvFile } from "core/util/secretsFile.js";

import { env } from "../env.js";

export interface McpAddOptions {
  dryRun?: boolean;
  /** Pick one server when the paste holds several. */
  name?: string;
  /** Save without the test connection. */
  skipTest?: boolean;
  /** Run the test without asking; refused for an unpinned package. */
  yesRun?: boolean;
  /** For tests: the config file and the ~/.continuous folder. */
  configFile?: string;
  continueDir?: string;
  timeoutMs?: number;
}

export interface McpIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ask a yes/no question; false when there is no terminal. */
  confirm?: (question: string) => Promise<boolean>;
  readStdin?: () => string;
}

const FORMAT_LABELS: Record<McpPasteFormat, string> = {
  "mcpServers-json":
    "an mcpServers JSON block (Claude Desktop, Cursor, Cline, Windsurf)",
  "vscode-json": "a VS Code mcp.json servers block",
  "zed-json": "a Zed context_servers block",
  "opencode-json": "an OpenCode mcp block",
  "server-json": "one server entry in JSON",
  "codex-toml": "a Codex mcp_servers TOML table",
  "command-line": "a command line",
  url: "a URL",
  "claude-mcp-add": "a `claude mcp add` command",
  "claude-mcp-add-json": "a `claude mcp add-json` command",
  "code-add-mcp": "a `code --add-mcp` command",
  "cli-mcp-add": "another tool's `mcp add` command",
  "vscode-link": "a VS Code install link",
  "cursor-link": "a Cursor install link",
};

const NOT_UNDERSTOOD =
  "I could not find a server in that text. Paste a JSON config, a command such as `npx -y some-package`, or a URL that starts with https://.";

async function terminalConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function readInput(args: string[], io: McpIo): string {
  if (args.length === 1 && args[0] === "-") {
    return io.readStdin ? io.readStdin() : fs.readFileSync(0, "utf8");
  }
  if (args.length === 1) {
    try {
      if (fs.statSync(args[0]).isFile())
        return fs.readFileSync(args[0], "utf8");
    } catch {
      // not a file: the text itself
    }
  }
  return args.join(" ");
}

/** How a pasted value becomes a value to save. */
function draftValue(v: McpNamedValue): McpDraftValue {
  if (v.reference?.kind === "secret") {
    return {
      name: v.name,
      value: `\${{ secrets.${v.reference.name} }}`,
      secret: true,
    };
  }
  if (v.reference || v.placeholder) {
    // Another tool's variable or an example value: a secret to fill in later
    return { name: v.name, value: "", secret: true };
  }
  return { name: v.name, value: v.value ?? "", secret: v.secretLooking };
}

export function candidateToDraft(c: McpCandidate): McpServerDraft {
  return {
    name: c.name,
    transport: c.transport,
    ...(c.command === undefined
      ? {}
      : { command: c.command, args: c.args ?? [] }),
    ...(c.cwd ? { cwd: c.cwd } : {}),
    ...(c.url === undefined ? {} : { url: c.url }),
    env: c.env.map(draftValue),
    headers: c.headers.map(draftValue),
  };
}

function describeValue(v: McpDraftValue, ref: string | undefined): string {
  if (!v.secret) return `${v.name} = ${maskCommandForDisplay(v.value)}`;
  if (v.value === "")
    return `${v.name}: needs a value (set ${ref ?? v.name} in ~/.continuous/.env)`;
  return `${v.name}: secret, saved as ${ref ? "${{ secrets." + ref + " }}" : "a secret reference"}`;
}

function refOf(entryPart: unknown, key: string): string | undefined {
  const value =
    entryPart && typeof entryPart === "object"
      ? (entryPart as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string"
    ? /\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/.exec(value)?.[1]
    : undefined;
}

function printReview(
  c: McpCandidate,
  draft: McpServerDraft,
  analysis: LaunchAnalysis,
  file: string,
  io: McpIo,
) {
  const plan = planMcpServerEntry(draft);
  io.out(
    `Server: ${c.name}${c.nameGuessed ? " (name made from the package; pass --name to change it)" : ""}`,
  );
  io.out(`Read as: ${FORMAT_LABELS[c.sourceFormat]}`);
  if (draft.transport === "stdio") {
    io.out("Runs on your computer, as you:");
    io.out(`  ${analysis.display}`);
    if (draft.cwd) io.out(`  in ${draft.cwd}`);
  } else {
    io.out(
      `Connects to: ${analysis.display}${c.transportGuessed ? " (the connection type is decided by the test)" : ""}`,
    );
  }
  const envPart = plan.entry.env;
  const headerPart = (
    plan.entry.requestOptions as { headers?: unknown } | undefined
  )?.headers;
  for (const v of draft.env ?? [])
    io.out(`  env ${describeValue(v, refOf(envPart, v.name))}`);
  for (const h of draft.headers ?? [])
    io.out(`  header ${describeValue(h, refOf(headerPart, h.name))}`);
  for (const w of c.warnings) io.out(`Note: ${w}`);
  for (const f of analysis.findings) {
    const word =
      f.level === "block" ? "Blocked" : f.level === "warn" ? "Warning" : "Note";
    io.out(`${word}: ${f.message}`);
  }
  io.out(`Will be added to: ${file}`);
  io.out(renderEntryYaml(plan.entry).trimEnd());
}

function printProbe(r: McpProbeResult, io: McpIo) {
  if (r.ok) {
    io.out(
      `Connected in ${(r.durationMs / 1000).toFixed(1)} s. Found ${r.tools.length} tools, ${r.resources.length} resources, ${r.prompts.length} prompts.`,
    );
    for (const t of r.tools) {
      io.out(
        `  ${t.instructionLike.length ? "! " : ""}${t.name}${t.description ? ` - ${t.description.slice(0, 100)}` : ""}`,
      );
      if (t.instructionLike.length) {
        io.out(
          `    This tool description contains text that reads like instructions to the model (${t.instructionLike.join("; ")}).`,
        );
      }
    }
    if (r.tools.some((t) => t.instructionLike.length)) {
      io.out(
        "The check is a hint, not a gate: an honest server can trip it and a hostile one can avoid it.",
      );
    }
    io.out(r.notice);
  } else {
    io.err("Could not connect.");
    for (const e of r.errors)
      io.err(`  ${e.split("\n").filter(Boolean).slice(0, 2).join(" ")}`);
  }
  for (const h of r.hints) io.out(`${h.text}${h.link ? ` ${h.link}` : ""}`);
  if (!r.ok && r.stderr.lines.length) {
    io.err("Last output:");
    for (const l of r.stderr.lines) io.err(`  ${l}`);
  }
}

function pickCandidate(
  parsed: McpPasteResult,
  options: McpAddOptions,
  io: McpIo,
): McpCandidate | number {
  const all: McpCandidate[] = parsed.candidates;
  if (all.length === 0) {
    io.err(NOT_UNDERSTOOD);
    for (const w of parsed.warnings) io.err(`  ${w}`);
    return 1;
  }
  if (all.length > 1) {
    const picked = options.name
      ? all.find((c: McpCandidate) => c.name === options.name)
      : undefined;
    if (!picked) {
      io.err(
        `Found ${all.length} servers. Pass --name with one of: ${all.map((c: McpCandidate) => c.name).join(", ")}.`,
      );
      return 2;
    }
    return picked;
  }
  const only: McpCandidate = all[0];
  return options.name
    ? { ...only, name: options.name, nameGuessed: false }
    : only;
}

function headersOf(entry: Record<string, unknown>): unknown {
  return (entry.requestOptions as { headers?: unknown } | undefined)?.headers;
}

/** Ask, then run the test connection. Returns an exit code on failure. */
async function testFirst(
  draft: McpServerDraft,
  analysis: LaunchAnalysis,
  options: McpAddOptions,
  continueDir: string,
  io: McpIo,
): Promise<number | undefined> {
  const plan = planMcpServerEntry(draft);
  // A value the person already put in ~/.continuous/.env can be used for the test
  const fill = (v: McpDraftValue, part: unknown) =>
    withStoredValue(v, part, continueDir);
  const probeDraft: McpServerDraft = {
    ...draft,
    env: (draft.env ?? []).map((v) => fill(v, plan.entry.env)),
    headers: (draft.headers ?? []).map((v) => fill(v, headersOf(plan.entry))),
  };
  const missing = [...(probeDraft.env ?? []), ...(probeDraft.headers ?? [])]
    .filter((v) => v.secret && v.value === "")
    .map((v) => v.name);
  if (missing.length) {
    io.err(
      `Not tested: ${missing.join(", ")} has no value yet. Pass --skip-test to save it now and fill it in later.`,
    );
    return 1;
  }
  if (
    options.yesRun &&
    analysis.findings.some((f) => f.code === "unpinned-package")
  ) {
    io.err(
      "--yes-run is refused for a package that is not pinned to a version. Pin it, or answer the question in a terminal.",
    );
    return 1;
  }
  const question =
    draft.transport === "stdio"
      ? `Run \`${analysis.display}\` as you to test it? [y/N] `
      : `Connect to ${hostOf(draft.url)} to test it? [y/N] `;
  const yes =
    options.yesRun || (io.confirm ? await io.confirm(question) : false);
  if (!yes) {
    io.err(
      "Not tested and not added. Answer y in a terminal, pass --yes-run for a pinned command, or --skip-test to save without testing.",
    );
    return 1;
  }
  io.out("Connecting...");
  const result = await probeMcpServer(probeDraft, {
    timeoutMs: options.timeoutMs,
  });
  printProbe(result, io);
  if (!result.ok) {
    io.err(
      "Not added. Fix the problem above and try again, or pass --skip-test to save it anyway.",
    );
    return 1;
  }
  return undefined;
}

async function save(
  draft: McpServerDraft,
  file: string,
  continueDir: string,
  tested: boolean,
  io: McpIo,
): Promise<number> {
  const r = await addMcpServerToUserConfig(draft, {
    configPath: file,
    secrets: {
      // The terminal has no keychain: secrets go to ~/.continuous/.env
      ide: { readSecrets: async () => ({}), writeSecrets: async () => {} },
      storage: "env",
      continueDir,
    },
  });
  if (!r.ok) {
    io.err(`Not added: ${r.error}`);
    if (r.suggestion) {
      io.err(`Pass --name ${r.suggestion} to add it under another name.`);
    }
    return 1;
  }
  io.out(
    `Added ${r.name} to ${r.file}.${tested ? "" : " This server has not been tested."}`,
  );
  for (const s of r.secretsStored) {
    io.out(`  ${s.name} is stored in ~/.continuous/.env.`);
  }
  for (const p of r.secretsPending) {
    io.out(`  Set ${p} in ~/.continuous/.env before the server starts.`);
  }
  for (const w of r.warnings) io.out(`  ${w}`);
  return 0;
}

export async function mcpCommand(
  action: string | undefined,
  args: string[],
  options: McpAddOptions,
  io: McpIo = {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    confirm: terminalConfirm,
  },
): Promise<number> {
  if (action !== "add") {
    io.err(
      "Usage: continuous mcp add <paste-or-file> [--dry-run] [--name <name>] [--skip-test] [--yes-run]",
    );
    io.err(
      "Pass the README snippet in quotes, a file that holds it, or - to read it from stdin.",
    );
    return 2;
  }
  const parsed: McpPasteResult = parseMcpPaste(readInput(args, io));
  const candidate = pickCandidate(parsed, options, io);
  if (typeof candidate === "number") return candidate;
  for (const w of parsed.warnings) io.out(`Note: ${w}`);

  const continueDir = options.continueDir ?? env.continueHome;
  const file = options.configFile ?? path.join(continueDir, "config.yaml");
  const draft = candidateToDraft(candidate);
  const analysis = analyzeLaunch(draft, { platform: process.platform });
  printReview(candidate, draft, analysis, file, io);

  if (analysis.blocked) {
    io.err(
      "Not added: a check above blocks this server. Change the command or URL and try again.",
    );
    return 1;
  }
  if (options.dryRun) {
    io.out(
      "Dry run: nothing was started, nothing was connected to, and nothing was written.",
    );
    return 0;
  }
  if (!options.skipTest) {
    const failed = await testFirst(draft, analysis, options, continueDir, io);
    if (failed !== undefined) return failed;
  }
  return save(draft, file, continueDir, !options.skipTest, io);
}

/** For the test only: a pending secret's value from ~/.continuous/.env. */
function withStoredValue(
  v: McpDraftValue,
  part: unknown,
  continueDir: string,
): McpDraftValue {
  if (!(v.secret && v.value === "")) return v;
  const ref = refOf(part, v.name);
  const stored = ref ? readSecretFromEnvFile(continueDir, ref) : undefined;
  return stored ? { ...v, value: stored } : v;
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "the server";
  }
}
