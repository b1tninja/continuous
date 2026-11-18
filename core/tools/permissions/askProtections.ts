import type { ShellKind } from "../../util/shell";
import { destinationsOf, normalizeHost } from "./destinations";
import { builtinRuleOn, type BuiltinRuleId } from "./policy";
import { commandCandidateSet } from "./candidates";
import { dependencyCommandHit, dependencyFileHit } from "./dependencyChange";
import { destructiveCommandHit } from "./destructiveCommands";
import { existingLineCount } from "./fileFacts";
import type { ProtectedHit } from "./protected";

/**
 * The deterministic protections that settle a call with no model (ROADMAP
 * B14 and B30), so most of what a reviewer would be asked is asked or run by
 * rules. Each is a built-in rule with a switch in the person's own settings
 * (`builtin: { id: false }`) and nothing else loosens it: an allow rule, a
 * workspace file and a level below IDGAF leave it standing, the same as a
 * protected path. A call that is already refused stays refused.
 *
 * - `ask-destructive-commands`  history rewrites and recursive deletes
 * - `ask-large-change`          one call that changes many lines, among them
 *                               a `create_new_file` over a file that exists
 * - `ask-dependency-change`     manifests, lockfiles, installs, registries
 * - `ask-unknown-host`          a host outside `trustedDomains`, when the
 *                               person set that list in their own config
 */

/** Changed lines in one call above which it asks. */
export const LARGE_CHANGE_LINES = 300;

const WRITE_TOOLS_WITH_TEXT = new Set([
  "edit_existing_file",
  "single_find_and_replace",
  "multi_edit",
]);
const ALL_WRITE_TOOLS = new Set([...WRITE_TOOLS_WITH_TEXT, "create_new_file"]);

const lineCount = (text: unknown) =>
  typeof text === "string" && text !== "" ? text.split("\n").length : 0;

/** `// ... existing code ...` style placeholders are not changed lines. */
function changedLines(text: unknown): number {
  if (typeof text !== "string") return 0;
  return text
    .split("\n")
    .filter(
      (l) =>
        !/^\s*(\/\/|#|\/\*|<!--)?\s*\.\.\..*(existing|unchanged|rest)/i.test(l),
    ).length;
}

/** Lines one write call changes: the larger of what goes out and what comes in, per edit. */
export function changedLineCount(
  toolName: string,
  args: Record<string, unknown>,
): number {
  if (toolName === "edit_existing_file") return changedLines(args.changes);
  if (toolName === "single_find_and_replace") {
    return Math.max(lineCount(args.old_string), lineCount(args.new_string));
  }
  if (toolName === "multi_edit" && Array.isArray(args.edits)) {
    return args.edits.reduce((sum: number, e: unknown) => {
      const edit = (e ?? {}) as Record<string, unknown>;
      return (
        sum + Math.max(lineCount(edit.old_string), lineCount(edit.new_string))
      );
    }, 0);
  }
  return 0;
}

/**
 * Lines one write call changes. A `create_new_file` over a file that exists
 * counts the larger of what it writes and what it replaces, read from the
 * resolved path; a file that is absent or unreadable is a new file and counts
 * nothing (ROADMAP B57).
 */
function writtenLineCount(input: AskProtectionInput): number {
  const { toolName, parsedArgs } = input;
  if (toolName !== "create_new_file") {
    return changedLineCount(toolName, parsedArgs);
  }
  const existing = existingLineCount(input.resolvedPath);
  if (existing === undefined) return 0;
  const written = lineCount(parsedArgs.contents);
  return parsedArgs.append === true ? written : Math.max(written, existing);
}

export interface AskProtectionInput {
  toolName: string;
  parsedArgs: Record<string, unknown>;
  resolvedPath?: string;
  shell?: ShellKind;
  approval?: { builtin?: Partial<Record<BuiltinRuleId, boolean>> };
  /**
   * Domains the person trusts, from their own config only. Empty means the
   * person did not say, and no host asks.
   */
  trustedDomains?: readonly string[];
  /** Changed lines above which `ask-large-change` asks, from the person's own config only. */
  largeChangeLines?: number;
  /** The folder a command runs in; lets `npm install <name>` read the nearest package.json */
  cwd?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** True when `host` is `domain` or a subdomain of it. */
export function hostTrusted(host: string, domains: readonly string[]): boolean {
  const h = normalizeHost(host).toLowerCase();
  return domains.some((raw) => {
    const d = normalizeHost(raw.replace(/^\*\./, "")).toLowerCase();
    return h === d || h.endsWith(`.${d}`);
  });
}

function hostOfUrl(raw: unknown): string | undefined {
  const url = str(raw);
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

/** Hosts a command contacts, and whether some destination could not be read. */
function commandHosts(
  command: string,
  shell?: ShellKind,
): { hosts: string[]; unresolved: boolean } {
  const hosts = new Set<string>();
  let unresolved = false;
  for (const c of commandCandidateSet(command, shell).list) {
    const d = destinationsOf(c);
    if (d.unresolved.length) unresolved = true;
    for (const dest of d.destinations) hosts.add(dest.host);
  }
  return { hosts: [...hosts], unresolved };
}

function unknownHostHit(input: AskProtectionInput): ProtectedHit | undefined {
  const { toolName, parsedArgs, trustedDomains } = input;
  if (!trustedDomains?.length) return undefined;
  const hosts: string[] = [];
  let unresolved = false;
  if (toolName === "fetch_url_content") {
    const host = hostOfUrl(parsedArgs.url);
    if (host) hosts.push(host);
    else unresolved = true;
  } else if (toolName === "run_terminal_command") {
    const command = str(parsedArgs.command);
    if (!command) return undefined;
    const found = commandHosts(command, input.shell);
    hosts.push(...found.hosts);
    unresolved = found.unresolved;
  } else {
    return undefined;
  }
  const stranger = hosts.find((h) => !hostTrusted(h, trustedDomains));
  if (stranger) return { kind: "unknown-host", path: stranger };
  return unresolved
    ? { kind: "unknown-host", path: "a destination that cannot be read" }
    : undefined;
}

/**
 * The first deterministic protection the call trips, or undefined. Ambiguity
 * asks: a scan that cannot read a destination is a hit, never a pass.
 */
export function askProtectionHit(
  input: AskProtectionInput,
): ProtectedHit | undefined {
  const { toolName, parsedArgs, approval } = input;
  const on = (id: BuiltinRuleId) => builtinRuleOn(approval as never, id);
  const command =
    toolName === "run_terminal_command" ? str(parsedArgs.command) : undefined;

  if (command !== undefined && on("ask-destructive-commands")) {
    const why = destructiveCommandHit(command, input.shell);
    if (why) return { kind: "destructive-command", path: why };
  }
  if (on("ask-dependency-change")) {
    if (command !== undefined) {
      const why = dependencyCommandHit(command, input.shell, input.cwd);
      if (why) return { kind: "dependency-change", path: why };
    } else if (ALL_WRITE_TOOLS.has(toolName)) {
      const why = dependencyFileHit(
        str(parsedArgs.filepath),
        input.resolvedPath,
      );
      if (why) return { kind: "dependency-change", path: why };
    }
  }
  if (ALL_WRITE_TOOLS.has(toolName) && on("ask-large-change")) {
    const lines = writtenLineCount(input);
    if (lines > (input.largeChangeLines ?? LARGE_CHANGE_LINES)) {
      return { kind: "large-change", path: `${lines} changed lines` };
    }
  }
  return on("ask-unknown-host") ? unknownHostHit(input) : undefined;
}
