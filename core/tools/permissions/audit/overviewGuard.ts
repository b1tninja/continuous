import crypto from "node:crypto";
import type { RuleSourcesInput } from "../effectiveRules";
import { staysInside } from "../names";
import { findProtected } from "../protectedCall";
import type { MostAskedRow } from "./auditOverview";
import {
  classifyCommand,
  commandHazard,
  judgeRule,
  type Probe,
} from "./suggestGuards";

/**
 * The same guards `continuous audit suggest` applies, run on a most-asked row
 * before the page offers it (ROADMAP B69): a row that a floor, a protected
 * path, a built-in ask rule, a rule of the person's or the reviewer settles,
 * a command that writes, deletes or reaches the network, or a path outside the
 * workspace is not offered. What remains is still only a preview: the person
 * reviews it in the rule editor, which shows the diff and asks to confirm.
 */
const RULE = /^(runTerminalCommand|readFile|listDirectory)\(([\s\S]*)\)$/;

function probeOf(rule: string): Probe | undefined {
  const m = RULE.exec(rule);
  if (!m) return undefined;
  return m[1] === "runTerminalCommand"
    ? { tool: m[1], field: "command", value: m[2] }
    : { tool: m[1], field: "path", value: m[2] };
}

/** Verdicts by sources, rule and answer; a verdict holds until the rules change. */
const VERDICTS = new Map<string, boolean>();
const MAX_VERDICTS = 2000;
/** Time one call may spend asking the real evaluator; what is left waits for the next open */
export const GUARD_BUDGET_MS = 80;

function cheapGuard(row: MostAskedRow, probe: Probe): boolean {
  if (probe.field === "path") {
    const args =
      probe.tool === "readFile"
        ? { filepath: probe.value }
        : { dirPath: probe.value };
    if (findProtected({ toolName: probe.tool, parsedArgs: args })) return false;
    return row.answer !== "allow" || staysInside(probe.value);
  }
  if (row.answer !== "allow") return true;
  const risk = classifyCommand(probe.value);
  if (!["read-only", "runs-project-code"].includes(risk.kind)) return false;
  return !commandHazard(probe.value);
}

/**
 * A guard for one request. The checks that need no evaluator run first; the
 * evaluator (two tester runs per row, slow with hundreds of rules) runs under
 * a time budget and its verdicts are remembered, so a row left over is judged
 * at the next open. A row that was not judged is never offered.
 */
export function makeGuard(
  sources: RuleSourcesInput,
  cwd: string | undefined,
  budgetMs = GUARD_BUDGET_MS,
) {
  const fingerprint = crypto
    .createHash("sha1")
    .update(JSON.stringify([sources, cwd]))
    .digest("hex");
  const start = performance.now();
  let cut = false;
  return {
    keep(row: MostAskedRow): boolean {
      const probe = probeOf(row.rule);
      if (!probe || !cheapGuard(row, probe)) return false;
      const key = `${fingerprint}|${row.answer}|${row.rule}`;
      const known = VERDICTS.get(key);
      if (known !== undefined) return known;
      if (performance.now() - start > budgetMs) {
        cut = true;
        return false;
      }
      const ok = judgeRule(probe, row.answer, row.rule, { sources, cwd }).ok;
      if (VERDICTS.size >= MAX_VERDICTS) VERDICTS.clear();
      VERDICTS.set(key, ok);
      return ok;
    },
    /** Some rows were left unjudged for lack of time */
    get cut() {
      return cut;
    },
  };
}
