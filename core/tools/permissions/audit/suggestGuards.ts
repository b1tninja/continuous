import { destinationsOf } from "../destinations";
import { effectsOfCommand } from "../commandSpecs";
import type { RuleSourcesInput } from "../effectiveRules";
import { classifyReadOnly } from "../readOnlyCommand";
import { readUserEnvNames } from "../userEnvNames";
import type { ToolPolicy } from "@continuedev/terminal-security";
import { testToolCall, type ToolCallTestResult } from "../testToolCall";

/**
 * The guards of `continuous audit suggest`: what a command is, how risky an
 * always-allow for it would be, and whether the real evaluator agrees that the
 * rule would do only what the person meant. Nothing here writes anything.
 */
export type Risk = "low" | "medium" | "high";

export interface RiskClass {
  /** read-only, runs-project-code, writes-files, network, deletes, unclassified */
  kind: string;
  risk: Risk;
  why: string;
}

/** Test, lint and build scripts: they run the project's own code and nothing else is promised. */
const PROJECT_CODE =
  /^(?:(?:npm|pnpm|yarn|bun)(?: run)? (?:test|lint|typecheck|check|build)|pytest|vitest run|jest|go test(?: \.\/\.\.\.)?|cargo (?:test|check|build)|tsc --noEmit|ruff check|eslint)(?: [\w./@:=-]+)*$/;

/** The kind of a command, from what its first word and subcommand are known to do. */
export function classifyCommand(command: string): RiskClass {
  const words = command.trim().split(/\s+/);
  const effects = effectsOfCommand(command);
  if (effects.has("network")) {
    return { kind: "network", risk: "high", why: "it can reach the network" };
  }
  if (effects.has("delete")) {
    return { kind: "deletes", risk: "high", why: "it can delete files" };
  }
  if (effects.has("write")) {
    return { kind: "writes-files", risk: "high", why: "it can write files" };
  }
  try {
    const claim = classifyReadOnly(command);
    if (claim.vouched) {
      return {
        kind: "read-only",
        risk: "low",
        why: "it only reads (parser-checked)",
      };
    }
  } catch {
    // an unreadable command is unclassified, below
  }
  // Flags that make a test or lint run change files
  if (
    /(?:^|\s)(?:--fix\S*|--write|--update\S*|-u|-o|--output\S*)(?:\s|=|$)/.test(
      command,
    )
  ) {
    return {
      kind: "writes-files",
      risk: "high",
      why: "a flag makes it write files",
    };
  }
  if (PROJECT_CODE.test(command.trim())) {
    return {
      kind: "runs-project-code",
      risk: "medium",
      why: `${words[0]} runs the project's own scripts`,
    };
  }
  return {
    kind: "unclassified",
    risk: "medium",
    why: "what this command does is not known to the analysis",
  };
}

/** Words that name a place outside the workspace, or a value the shell would fill in. */
const OUTSIDE = /^(?:[A-Za-z]:[\/]|[\/]|~|\.\.(?:[\/]|$)|%|\$)|\.\.[\/]/;

/** Why a command must never be a generalised allow, or undefined when it is plain. */
export function commandHazard(command: string): string | undefined {
  const dest = destinationsOf(command);
  if (dest.destinations.length || dest.unresolved.length) {
    return "it names a network host or a destination that cannot be read";
  }
  const words = command.trim().split(/\s+/);
  if (words.some((w) => /:\/\/|^[\w.-]+@[\w.-]+:/.test(w))) {
    return "it contains a URL or a remote address";
  }
  if (words.slice(1).some((w) => OUTSIDE.test(w.replace(/^-+[\w-]*=/, "")))) {
    return "it names a path outside the workspace or a variable";
  }
  return undefined;
}

/** Sources that mean a rule or floor, not the setting, made the call ask. */
export const BLOCKING_SOURCES: ReadonlySet<string> = new Set([
  "deny-rule",
  "ask-rule",
  "protected-path",
  "floor",
  "safety-floor",
  "reviewer",
  "mode",
  "plan-mode",
]);

export type Field = "command" | "path";

export interface Probe {
  tool: string;
  field: Field;
  value: string;
}

/** What the tester needs besides the call: the rules, the folder and the tool's own setting. */
export interface JudgeContext {
  sources: RuleSourcesInput;
  cwd?: string;
  /** The tool's own setting, when it is not the tool's default */
  basePolicy?: ToolPolicy;
}

function run(
  probe: Probe,
  ctx: JudgeContext,
  sources: RuleSourcesInput = ctx.sources,
): ToolCallTestResult | undefined {
  try {
    return testToolCall({
      tool: probe.tool,
      [probe.field]: probe.value,
      sources,
      envNames: readUserEnvNames(),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      ...(ctx.basePolicy ? { basePolicy: ctx.basePolicy } : {}),
    } as never);
  } catch {
    return undefined;
  }
}

/** The sources with one more rule in the person's own list. */
export function withRule(
  sources: RuleSourcesInput,
  decision: "allow" | "deny",
  rule: string,
): RuleSourcesInput {
  return {
    ...sources,
    user: {
      ...sources.user,
      [decision]: [...(sources.user?.[decision] ?? []), rule],
    },
  };
}

/**
 * Would this rule, added to the person's list, turn the call from an ask
 * that only the setting caused into an allow (or a refusal)? Anything that a
 * floor, a built-in ask rule, a protected path, a rule of the person's or the
 * reviewer settles is withheld: an allow cannot loosen those and a suggestion
 * must not pretend it does.
 */
export function judgeRule(
  probe: Probe,
  decision: "allow" | "deny",
  rule: string,
  ctx: JudgeContext,
): { ok: true } | { ok: false; reason: string } {
  const before = run(probe, ctx);
  if (!before) return { ok: false, reason: "the tester could not read it" };
  if (before.decision === decision) {
    return { ok: false, reason: `it is already ${decision}ed by a rule` };
  }
  if (decision === "allow") {
    if (before.decision === "allow") {
      return { ok: false, reason: "it is already allowed" };
    }
    const why = before.source ?? "";
    if (
      before.decision === "deny" ||
      BLOCKING_SOURCES.has(why) ||
      before.wouldAskReviewer
    ) {
      return {
        ok: false,
        reason: `it asks because of ${before.wouldAskReviewer ? "the reviewer" : why || "a refusal"}, which an allow rule does not override`,
      };
    }
  }
  const after = run(probe, ctx, withRule(ctx.sources, decision, rule));
  if (!after) return { ok: false, reason: "the tester could not read it" };
  const wanted = decision === "allow" ? "allow-rule" : "deny-rule";
  if (after.decision !== decision || after.source !== wanted) {
    return {
      ok: false,
      reason: `with the rule the call is still ${after.decision} (${after.source ?? "setting"})`,
    };
  }
  return { ok: true };
}

/** Would the rule also allow one of these calls it should never allow? Returns the first it does. */
export function overreach(
  probes: readonly Probe[],
  rule: string,
  ctx: JudgeContext,
): Probe | undefined {
  const withIt = withRule(ctx.sources, "allow", rule);
  return probes.find((p) => {
    const r = run(p, ctx, withIt);
    return r?.decision === "allow" && r.source === "allow-rule";
  });
}

/** Tails a command wildcard must not admit. */
export const COMMAND_TAILS = [
  "--output=/tmp/x",
  "http://example.test/x",
  "../../x",
] as const;

/** Files a directory glob must not admit. */
export const PATH_NAMES = [".env", ".npmrc", "id_rsa"] as const;
