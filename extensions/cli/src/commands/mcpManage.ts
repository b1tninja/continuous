/**
 * `continuous mcp list`, `test <name>` and `remove <name>` (MCPW7): the saved
 * servers in your own config.yaml and in this project's
 * `.continuous/mcpServers/*.yaml`. `list` and `remove` start nothing; `test`
 * asks first, because a test runs the command (or connects to the URL).
 */

import path from "node:path";

import { analyzeLaunch } from "core/config/mcpWizard/analyzeLaunch.js";
import {
  entryToDraft,
  findMcpServers,
  listMcpServers,
  removeMcpServer,
  type McpServerListing,
  type McpServerLocations,
  type McpServerScope,
} from "core/config/mcpWizard/manageMcpServers.js";
import { probeMcpServer } from "core/config/mcpWizard/probeMcpServer.js";
import { readSecretFromEnvFile } from "core/util/secretsFile.js";

import { env } from "../env.js";

import { hostOf, printProbe, type McpAddOptions, type McpIo } from "./mcp.js";

function locations(options: McpAddOptions): {
  loc: McpServerLocations;
  continueDir: string;
} {
  const continueDir = options.continueDir ?? env.continueHome;
  return {
    continueDir,
    loc: {
      configPath: options.configFile ?? path.join(continueDir, "config.yaml"),
      projectDir: options.projectDir ?? process.cwd(),
    },
  };
}

function scopeOf(options: McpAddOptions): McpServerScope | undefined {
  return options.scope === "user" || options.scope === "project"
    ? options.scope
    : undefined;
}

function listCommand(options: McpAddOptions, io: McpIo): number {
  const { loc } = locations(options);
  const { servers, problems } = listMcpServers(loc);
  if (options.json) {
    io.out(
      JSON.stringify(
        servers.map(({ name, scope, file, transport, target, secrets }) => ({
          name,
          scope,
          file,
          transport,
          target,
          secrets,
        })),
        null,
        2,
      ),
    );
  } else if (servers.length === 0) {
    io.out(
      "No MCP servers saved. Add one with: continuous mcp add '<README snippet>'",
    );
  } else {
    for (const s of servers) {
      io.out(`${s.name} (${s.scope}, ${s.transport})`);
      io.out(`  ${s.target}`);
      if (s.secrets.length) io.out(`  secrets: ${s.secrets.join(", ")}`);
      io.out(`  in ${s.file}`);
    }
  }
  for (const p of problems) io.err(`Could not read: ${p}`);
  return problems.length ? 1 : 0;
}

function pickOne(
  name: string | undefined,
  options: McpAddOptions,
  io: McpIo,
): McpServerListing | number {
  if (!name) {
    io.err("Name the server: continuous mcp test <name>");
    return 2;
  }
  const { loc } = locations(options);
  const matches = findMcpServers(name, loc, scopeOf(options));
  if (matches.length === 0) {
    io.err(`There is no saved server called ${name}. See continuous mcp list.`);
    return 1;
  }
  if (matches.length > 1) {
    io.err(
      `${matches.length} saved servers are called ${name}. Pass --scope user or --scope project.`,
    );
    return 2;
  }
  return matches[0];
}

async function testCommand(
  name: string | undefined,
  options: McpAddOptions,
  io: McpIo,
): Promise<number> {
  const server = pickOne(name, options, io);
  if (typeof server === "number") return server;
  const { continueDir } = locations(options);
  // The draft holds the secret values for the test; it is never printed
  const { draft, missing } = entryToDraft(server.entry, (n) =>
    readSecretFromEnvFile(continueDir, n),
  );
  if (missing.length) {
    io.err(
      `Not tested: ${missing.join(", ")} has no value in ~/.continuous/.env. A secret kept in the editor's secure storage cannot be read from the terminal.`,
    );
    return 1;
  }
  // Checked on the saved text, so no finding can quote a secret's value
  const unresolved = entryToDraft(server.entry, () => undefined).draft;
  const analysis = analyzeLaunch(unresolved, { platform: process.platform });
  if (analysis.blocked) {
    for (const f of analysis.findings.filter((x) => x.level === "block")) {
      io.err(`Blocked: ${f.message}`);
    }
    io.err("Not tested: a check above blocks this server.");
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
    server.transport === "stdio"
      ? `Run \`${server.target}\` as you to test it? [y/N] `
      : `Connect to ${hostOf(server.target)} to test it? [y/N] `;
  const yes =
    options.yesRun || (io.confirm ? await io.confirm(question) : false);
  if (!yes) {
    io.err(
      "Not tested. Answer y in a terminal, or pass --yes-run for a pinned command.",
    );
    return 1;
  }
  io.out("Connecting...");
  const result = await probeMcpServer(draft, { timeoutMs: options.timeoutMs });
  printProbe(result, io);
  return result.ok ? 0 : 1;
}

function removeCommand(
  name: string | undefined,
  options: McpAddOptions,
  io: McpIo,
): number {
  if (!name) {
    io.err("Name the server: continuous mcp remove <name>");
    return 2;
  }
  const { loc } = locations(options);
  const r = removeMcpServer(name, loc, scopeOf(options));
  if (!r.ok) {
    io.err(`Not removed: ${r.error}`);
    return r.reason === "ambiguous" ? 2 : 1;
  }
  io.out(
    r.fileDeleted
      ? `Removed ${name}: deleted ${r.file}.`
      : `Removed ${name} from ${r.file}.`,
  );
  if (r.secrets.length) {
    io.out(
      `  Its secrets (${r.secrets.join(", ")}) were kept, since another server may use them. Remove them from ~/.continuous/.env if nothing else does.`,
    );
  }
  return 0;
}

export async function mcpManageCommand(
  action: "list" | "test" | "remove",
  args: string[],
  options: McpAddOptions,
  io: McpIo,
): Promise<number> {
  if (action === "list") return listCommand(options, io);
  if (args.length > 1) {
    io.err(`Usage: continuous mcp ${action} <name> [--scope user|project]`);
    return 2;
  }
  return action === "test"
    ? testCommand(args[0], options, io)
    : removeCommand(args[0], options, io);
}
