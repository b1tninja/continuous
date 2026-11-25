import * as posix from "node:path/posix";
import type { DecisionSource } from "../tools/permissions/decide";
import { levelRank, type PolicyLevel } from "../tools/permissions/policy";
import {
  protectedPathHit,
  type ProtectedKind,
} from "../tools/permissions/protected";
import { globMatch } from "../tools/permissions/rules";
import type { SandboxCompileResult } from "./sandboxPolicyTypes";

/**
 * Whether a command the policy would ASK about may run without asking because
 * it is confined (plans/ROADMAP.md W8a). Pure. The default is no.
 *
 * A sandbox never loosens a floor, a deny rule, an ask rule, a protected path
 * or a locked path: those come back as `allowWithoutAsk: false` whatever the
 * level. What it can loosen is a prompt that exists only because the tool's
 * own setting or the default says "ask" (`tool-setting`, `default`).
 *
 * All of these must hold:
 * - the compile has no conflicts and no weakened mode (`ok` and `weakened`);
 * - the caller passes `verified: true`: OUR probes passed on the running
 *   sandbox. Never derive it from srt's own getters (`isSandboxingEnabled()`
 *   returned true after a failed initialize, measured);
 * - the area's level is at or above `minLevel` (default `automatic`; never
 *   below `cautious`, and `manual` never);
 * - the rule engine's decision source is `tool-setting` or `default`, with no
 *   protection kind;
 * - the analyser named every path the command touches, and each is inside the
 *   write scope and outside every deny and every protected location.
 */

export interface AreaDecision {
  /** `ToolPolicy`: only these three exist */
  policy: "allowedWithoutPermission" | "allowedWithPermission" | "disabled";
  source?: DecisionSource;
  protection?: ProtectedKind;
}

export interface SandboxApprovalOptions {
  /** Our own probes passed for this sandbox, now. Must be exactly `true`. */
  verified: boolean;
  /** Paths the analyser found in the command; null or undefined: unknown */
  touchedPaths?: string[] | null;
  /** Directory the command runs in (default: the workspace) */
  cwd?: string;
  /** Lowest area level that may use the sandbox (default `automatic`) */
  minLevel?: PolicyLevel;
}

export interface SandboxApprovalResult {
  allowWithoutAsk: boolean;
  reason: string;
}

const LOOSENABLE: ReadonlySet<DecisionSource> = new Set([
  "tool-setting",
  "default",
]);

/** Paths a command may name without leaving the write scope. */
const HARMLESS = new Set(["/dev/null"]);

const no = (reason: string): SandboxApprovalResult => ({
  allowWithoutAsk: false,
  reason,
});

function underOrEqual(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);
}

function entryHits(entry: string, path: string): boolean {
  if (!/[*?]/.test(entry)) return underOrEqual(path, entry);
  return globMatch(entry, path, true) || globMatch(`${entry}/**`, path, true);
}

/** The first reason a touched path cannot be allowed, if any. */
function pathProblem(
  raw: string,
  plan: Extract<SandboxCompileResult, { ok: true }>,
  cwd: string,
): string | undefined {
  if (/[$`*?[\]{}!]|^~[^/]|\0/.test(raw) || raw.trim() === "") {
    return `"${raw}" is built at run time or is a pattern`;
  }
  const expanded = raw.startsWith("~/")
    ? `${plan.homeDir}${raw.slice(1)}`
    : raw;
  if (/^[A-Za-z]:|\\/.test(expanded)) return `"${raw}" is not a POSIX path`;
  const abs = posix.normalize(
    expanded.startsWith("/") ? expanded : posix.join(cwd, expanded),
  );
  if (HARMLESS.has(abs)) return undefined;
  const fsCfg = plan.config.filesystem;
  if (!fsCfg.allowWrite.some((d) => underOrEqual(abs, d))) {
    return `${abs} is outside the write scope`;
  }
  const denied = [...fsCfg.denyRead, ...fsCfg.denyWrite].find((e) =>
    entryHits(e, abs),
  );
  if (denied) return `${abs} is denied (${denied})`;
  const hit = protectedPathHit(abs, ["secret", "config"], plan.homeDir, cwd);
  if (hit) return `${abs} is a protected ${hit.kind} path`;
  return undefined;
}

export function sandboxAutoApproval(
  level: PolicyLevel,
  areaDecision: AreaDecision,
  plan: SandboxCompileResult,
  options: SandboxApprovalOptions,
): SandboxApprovalResult {
  if (areaDecision.policy === "disabled") return no("the tool is switched off");
  if (areaDecision.policy === "allowedWithoutPermission") {
    return {
      allowWithoutAsk: true,
      reason: "the policy already allows it; the sandbox decided nothing",
    };
  }
  if (!plan.ok) {
    return no(`no usable sandbox plan: ${plan.reasons.join("; ")}`);
  }
  if (plan.conflicts.length > 0) return no("the sandbox plan has conflicts");
  if (plan.weakened.length > 0) {
    return no(`a weakened mode is on (${plan.weakened.join(", ")})`);
  }
  if (options.verified !== true) {
    return no(
      "our probes have not verified this sandbox: confined as configured only",
    );
  }
  const min = options.minLevel ?? "automatic";
  // By rank, not by position in the list: Permissive and Automatic rank the same
  const minRank = Math.max(levelRank(min), levelRank("cautious"));
  const rank = levelRank(level);
  if (rank < 0 || rank < minRank) {
    return no(
      `the level (${level}) is below ${levelRank(min) >= levelRank("cautious") ? min : "cautious"}`,
    );
  }
  if (areaDecision.protection) {
    return no(`a protected path rule asked (${areaDecision.protection})`);
  }
  if (!areaDecision.source || !LOOSENABLE.has(areaDecision.source)) {
    return no(
      `the ask comes from ${areaDecision.source ?? "an unknown source"}, which a sandbox never loosens`,
    );
  }
  const touched = options.touchedPaths;
  if (!touched) return no("the paths the command touches are not known");
  const cwd = posix.normalize(options.cwd ?? plan.workspace);
  for (const raw of touched) {
    const problem = pathProblem(raw, plan, cwd);
    if (problem) return no(problem);
  }
  return {
    allowWithoutAsk: true,
    reason: `confined as configured and verified by our probes; every path is inside the write scope (${plan.config.filesystem.allowWrite.length} roots)`,
  };
}
