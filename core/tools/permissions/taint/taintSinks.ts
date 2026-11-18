import { BuiltInToolNames } from "../../builtIn";
import { hostTrusted } from "../askProtections";
import { commandCandidateSet } from "../candidates";
import { destinationsOf, programName } from "../destinations";
import { canonicalRuleName } from "../names";
import { jqEnvironmentLabel, secretWordLabel } from "../secretCommands";
import type { ShellKind } from "../../../util/shell";

/**
 * Which calls can carry data out of the session or change state beyond the
 * workspace: the sinks the tainted-session rule asks on. Read from the call as
 * the engine already reads it (command candidates, destinations, the tool's own
 * resolved path); no new parser. plans/design/tainted-session.md section 3.
 */
export const SINK_CLASSES = [
  "network-egress",
  "outside-write",
  "credential-read",
  "vcs-publish",
  "package-publish",
  "mcp-send",
] as const;
export type SinkClass = (typeof SINK_CLASSES)[number];

export interface SinkCall {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  /** The tool as the engine holds it, for MCP and read-only claims */
  tool?: {
    uri?: string;
    originalFunctionName?: string;
    readonly?: boolean;
    mcpFromWorkspace?: boolean;
  };
  /** The tool's resolved target: `isWithinWorkspace` false is a write outside */
  resolved?: { isWithinWorkspace: boolean } | null;
  /** Hosts the person trusts (their own config only) */
  trustedDomains?: readonly string[];
  /**
   * The session holds the `secret` label. A trusted host is then an egress
   * like any other: anyone may be able to write to it (a code host, a paste
   * site, a search box), so a secret in the path or query reaches them.
   */
  secretHeld?: boolean;
  shell?: ShellKind;
}

export interface Sink {
  class: SinkClass;
  /** A short word for the reason line: a host, a program, a path kind */
  detail: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const TRUSTED_WITH_SECRET = "trusted, but a secret was read";

/**
 * The egress sink for a host, or undefined when the host is trusted and no
 * secret is held. A trusted host is exempt only while the session holds no
 * secret.
 */
function egressTo(call: SinkCall, host: string): Sink | undefined {
  if (!hostTrusted(host, call.trustedDomains ?? [])) {
    return { class: "network-egress", detail: host };
  }
  return call.secretHeld
    ? { class: "network-egress", detail: `${host} (${TRUSTED_WITH_SECRET})` }
    : undefined;
}

/** Programs that send to a destination the command line chooses. */
const FREE_EGRESS = new Set([
  "curl",
  "wget",
  "http",
  "https",
  "xh",
  "nc",
  "ncat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "invoke-webrequest",
  "invoke-restmethod",
]);

/** `<program> <subcommand>` pairs that publish a package or an image. */
const PUBLISH: Record<string, readonly string[]> = {
  npm: ["publish"],
  pnpm: ["publish"],
  yarn: ["publish", "npm"],
  bun: ["publish"],
  cargo: ["publish"],
  twine: ["upload"],
  gem: ["push"],
  docker: ["push"],
  podman: ["push"],
  nuget: ["push"],
  dotnet: ["nuget"],
  vsce: ["publish"],
  ovsx: ["publish"],
  flit: ["publish"],
  poetry: ["publish"],
  helm: ["push"],
};

/** `gh` verbs that only read; anything else changes something on the host. */
const GH_READS = new Set([
  "view",
  "list",
  "diff",
  "checks",
  "status",
  "checkout",
]);

function firstOperands(words: string[]): string[] {
  return words.slice(1).filter((w) => !w.startsWith("-"));
}

function publishOf(program: string, words: string[]): Sink | undefined {
  const rest = firstOperands(words);
  if (program === "git" && rest[0] === "push") {
    return { class: "vcs-publish", detail: "git push" };
  }
  if (program === "gh") {
    if (rest[0] === "api") return { class: "network-egress", detail: "gh api" };
    if (rest.length >= 2 && !GH_READS.has(rest[1]) && rest[0] !== "auth") {
      return { class: "vcs-publish", detail: `gh ${rest[0]} ${rest[1]}` };
    }
    return undefined;
  }
  const verbs = PUBLISH[program];
  if (verbs && rest[0] && verbs.includes(rest[0])) {
    return { class: "package-publish", detail: `${program} ${rest[0]}` };
  }
  return undefined;
}

function commandSink(call: SinkCall, command: string): Sink | undefined {
  const trusted = call.trustedDomains ?? [];
  for (const c of commandCandidateSet(command, call.shell).list) {
    const words = c.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const program = programName(words[0]);
    const published = publishOf(program, words);
    if (published) return published;

    const secret = words
      .map((w, i) =>
        secretWordLabel(w, i === 0, words.length > 1, words[i - 1]),
      )
      .find(Boolean);
    const label = secret ?? jqEnvironmentLabel(words);
    if (label) return { class: "credential-read", detail: label };

    const found = destinationsOf(c);
    const stranger = found.destinations.find(
      (d) => !hostTrusted(d.host, trusted),
    );
    if (stranger) return { class: "network-egress", detail: stranger.host };
    const trustedOne = found.destinations
      .map((d) => egressTo(call, d.host))
      .find(Boolean);
    if (trustedOne) return trustedOne;
    if (found.unresolved.length) {
      return { class: "network-egress", detail: "an unreadable destination" };
    }
    if (FREE_EGRESS.has(program) && found.destinations.length === 0) {
      return { class: "network-egress", detail: program };
    }
  }
  return undefined;
}

function hostOf(raw: unknown): string | undefined {
  const url = str(raw);
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

const FILE_WRITES = new Set(["writeFile"]);

/** The sink this call is, or undefined when it is not one. */
export function sinkOfCall(call: SinkCall): Sink | undefined {
  const { toolName, parsedArgs, tool } = call;
  if (tool?.uri?.startsWith("mcp:") && tool.originalFunctionName) {
    // `readonly` is a server's hint, believed only for a server the person
    // trusts (mcpTrust.ts), and never for one the open folder brought. For any
    // other server the call is a send.
    return tool.readonly === true && !tool.mcpFromWorkspace
      ? undefined
      : { class: "mcp-send", detail: tool.originalFunctionName };
  }
  if (toolName === BuiltInToolNames.FetchUrlContent) {
    const host = hostOf(parsedArgs.url);
    if (host) return egressTo(call, host);
    return { class: "network-egress", detail: "an unreadable URL" };
  }
  if (toolName === BuiltInToolNames.RunTerminalCommand) {
    const command = str(parsedArgs.command);
    return command ? commandSink(call, command) : undefined;
  }
  if (FILE_WRITES.has(canonicalRuleName(toolName))) {
    return call.resolved && !call.resolved.isWithinWorkspace
      ? { class: "outside-write", detail: "a path outside the workspace" }
      : undefined;
  }
  return undefined;
}
