import type { ShellKind } from "../../util/shell";
import { commandCandidateSet } from "./candidates";
import { dependencyCommandHit } from "./dependencyChange";
import { destinationsOf } from "./destinations";
import { destructiveCommandHit } from "./destructiveCommands";
import { canonicalRuleName } from "./names";
import { parseRule, type RuleSource } from "./rules";

/**
 * ROADMAP B55. The person's own Always rule for one exact command exempts that
 * command, and nothing else, from the two built-in ask rules that read a
 * command: `ask-destructive-commands` and `ask-dependency-change`.
 *
 *   Always: Bash(npm install lodash)
 *   Always: Bash(git push --force-with-lease origin my-branch)
 *
 * Nothing is stored: the exemption is read from the rule, so there is no
 * second list to drift. What it never touches: the safety check's refusals,
 * the always-on rules, protected paths, credentials, policy files, the
 * environment-variable and hidden-name asks, the outside-the-workspace asks,
 * `ask-large-change` and `ask-unknown-host`. Those are separate checks that
 * run on their own.
 *
 * An exemption needs every one of these to hold, and any doubt leaves the
 * built-in rule standing:
 * - the rule is an allow rule in the person's own config.yaml or
 *   permissions.yaml (a workspace or assistant rule is not an owner's rule);
 * - its pattern has no wildcard, so it is one command line, compared as text;
 * - the command is that text, word for word (so no `&&` tail, no pipe);
 * - the line has no shell syntax beyond plain words, no variable or path that
 *   leaves the workspace, no URL or host;
 * - its first word is not a variable assignment and no wrapper, alias or
 *   quoting changes how the rule parser reads it: the candidate set the
 *   parser builds is that one string.
 */
export const EXEMPTABLE_RULES = [
  "ask-destructive-commands",
  "ask-dependency-change",
] as const;
export type ExemptableRule = (typeof EXEMPTABLE_RULES)[number];

/** Sources that are the person's own: nothing from an assistant or the workspace. */
const OWN_SOURCES: ReadonlySet<RuleSource> = new Set([
  "user-config",
  "permissions-yaml",
]);

/** Programs that run another program or script from their arguments. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "exec",
  "time",
  "nice",
  "nohup",
  "timeout",
  "stdbuf",
  "ionice",
  "setsid",
  "watch",
  "command",
  "builtin",
  "xargs",
  "busybox",
  "npx",
  "pnpx",
  "bunx",
  "yarn dlx",
  "eval",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "lua",
  "start",
  "call",
  "runas",
  "find",
  "git-shell",
]);

const FIRST_WORD = /^[A-Za-z][\w.+-]*$/;
const LATER_WORD = /^[\w@.+,:=-][\w@.+,:=/-]*$/;

/** Why a command line cannot be an exemption, or undefined when it is plain enough. */
export function exemptionRefusal(
  command: string,
  shell?: ShellKind,
): string | undefined {
  if (command !== command.trim() || command === "") {
    return "it is empty or has space around it";
  }
  if (/[*?[\]]/.test(command)) return "it has a wildcard";
  const words = command.split(" ");
  if (!FIRST_WORD.test(words[0]) || words.length < 2) {
    return "it must be a program and its arguments, as plain words";
  }
  for (const w of words.slice(1)) {
    if (!LATER_WORD.test(w) || w.includes("..") || w.includes("://")) {
      return "it has more than plain words (quotes, variables, paths that leave the folder, URLs or shell syntax)";
    }
    // `--dir=/etc`: a value that is an absolute path leaves the workspace
    if (/=[/~]/.test(w) || w.startsWith("/")) {
      return "it names a path outside the workspace";
    }
  }
  const dest = destinationsOf(command);
  if (dest.destinations.length || dest.unresolved.length) {
    return "it names a network host or a destination that cannot be read";
  }
  if (WRAPPERS.has(words[0].toLowerCase().replace(/\.exe$/, ""))) {
    return "it starts with a wrapper, shell or interpreter, which runs something else";
  }
  // The parser lists the command and each tail of its words; anything else
  // (`git -C x push` read as `git push`) means it reads the line differently.
  const { list, truncated } = commandCandidateSet(command, shell);
  const tails = new Set(words.map((_, i) => words.slice(i).join(" ")));
  if (truncated || list.some((c) => !tails.has(c))) {
    return "the rule parser reads it as something other than what is written (a wrapper, an alias or quoting)";
  }
  return undefined;
}

export interface BuiltinExemption {
  /** The Always rule as written */
  rule: string;
  /** The one command line it exempts */
  command: string;
  /** The built-in rules that would have asked about it */
  exempts: ExemptableRule[];
}

export interface OwnRules {
  /** Where each list of rules was written */
  [source: string]: { allow?: string[] } | undefined;
}

/** The commands the person's own Always rules name exactly, with the rule text. */
function exactCommands(
  sources: OwnRules | undefined,
  shell: ShellKind | undefined,
): { rule: string; command: string }[] {
  const out: { rule: string; command: string }[] = [];
  for (const [origin, perms] of Object.entries(sources ?? {})) {
    if (!OWN_SOURCES.has(origin as RuleSource)) continue;
    for (const raw of perms?.allow ?? []) {
      const parsed =
        typeof raw === "string" ? parseRule(raw, "allow") : undefined;
      if (!parsed || parsed.pattern === undefined) continue;
      if (canonicalRuleName(parsed.toolName) !== "runTerminalCommand") continue;
      if (exemptionRefusal(parsed.pattern, shell) === undefined) {
        out.push({ rule: parsed.raw, command: parsed.pattern });
      }
    }
  }
  return out;
}

/** The built-in rules that would ask about this command, among the exemptable ones. */
function hitsOf(
  command: string,
  shell: ShellKind | undefined,
  cwd: string | undefined,
): ExemptableRule[] {
  const out: ExemptableRule[] = [];
  if (destructiveCommandHit(command, shell)) out.push(EXEMPTABLE_RULES[0]);
  if (dependencyCommandHit(command, shell, cwd)) out.push(EXEMPTABLE_RULES[1]);
  return out;
}

/**
 * Every exemption the person's own rules give, for the Permissions page and
 * `continuous permissions`. A rule that exempts nothing is not listed.
 */
export function listExemptions(
  sources: OwnRules | undefined,
  options: { shell?: ShellKind; cwd?: string } = {},
): BuiltinExemption[] {
  return exactCommands(sources, options.shell)
    .map(({ rule, command }) => ({
      rule,
      command,
      exempts: hitsOf(command, options.shell, options.cwd),
    }))
    .filter((e) => e.exempts.length > 0);
}

/**
 * The built-in rules this call is exempt from: the rule it matches word for
 * word, and the built-in rules that would have asked about it. Empty for
 * anything else.
 */
export function exemptedRules(
  command: string,
  sources: OwnRules | undefined,
  options: { shell?: ShellKind; cwd?: string } = {},
): { rule: string; exempts: ExemptableRule[] } | undefined {
  const own = exactCommands(sources, options.shell).find(
    (e) => e.command === command,
  );
  if (!own) return undefined;
  const exempts = hitsOf(command, options.shell, options.cwd);
  return exempts.length ? { rule: own.rule, exempts } : undefined;
}

/** The built-in rule's own words for a person, for the Permissions page and the CLI. */
export function exemptionLine(e: BuiltinExemption): string {
  return `${e.rule} exempts ${e.exempts.join(", ")}`;
}

/** `{ exemptedBy: [...] }` for a built-in rule some exemption relaxes, or nothing. */
export function exemptedByOf(
  id: string,
  exemptions: readonly BuiltinExemption[],
): { exemptedBy?: string[] } {
  const rules = exemptions
    .filter((e) => (e.exempts as readonly string[]).includes(id))
    .map((e) => e.rule);
  return rules.length ? { exemptedBy: rules } : {};
}
