import type { EffectiveRule } from "./effectiveRules";
import { canonicalRuleName } from "./names";
import { POLICY_AREAS, type PolicyLevels } from "./policy";
import { validateRuleText } from "./ruleAnalysis";
import {
  matchTerminalCommand,
  matchToolCall,
  parseRule,
  type RuleDecision,
} from "./rules";

/**
 * The pure half of the Custom policy wizard (plans/research/custom-policy.md):
 * the person's own rule lists as the wizard edits them, the changes that turn
 * one set of lists into another, and a preview of what a draft rule matches.
 *
 * No new matching: the preview calls the matchers the engine uses (rules.ts).
 * No new writer: the changes are the add, update and remove edits that
 * ruleEditor.ts already checks, confirms, writes and audits one at a time.
 */

export const RULE_DECISIONS: readonly RuleDecision[] = ["deny", "ask", "allow"];

export type RuleLists = Record<RuleDecision, string[]>;

export const EMPTY_LISTS: RuleLists = { allow: [], ask: [], deny: [] };

/**
 * The lists the wizard may edit: the person's own config.yaml rules only.
 * Rules from a workspace, an assistant or the CLI file are not editable here
 * and are never copied in, so saving cannot turn a workspace's Always rule
 * into the person's own.
 */
export function ownRuleLists(rules: readonly EffectiveRule[]): RuleLists {
  const lists: RuleLists = { allow: [], ask: [], deny: [] };
  const seen = new Set<string>();
  for (const r of rules) {
    if (r.source !== "user-config") continue;
    const key = `${r.decision}\u0000${r.raw.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lists[r.decision].push(r.raw.trim());
  }
  return lists;
}

/** One change, as the rule editor takes it (config/addToolRule and the rest). */
export type PlannedRuleChange =
  | { op: "add"; decision: RuleDecision; rule: string }
  | { op: "remove"; decision: RuleDecision; rule: string }
  | {
      op: "update";
      decision: RuleDecision;
      rule: string;
      newDecision: RuleDecision;
      newRule: string;
    };

const same = (a: string, b: string) => a.trim() === b.trim();

/**
 * The edits that turn `before` into `after`: a rule that changed list is one
 * move (update), a rule that is gone is a remove, a new rule is an add.
 * Removes go first, then moves, then adds, so a rule moved out of a list
 * never meets itself there. Order inside a list is kept as the editor keeps
 * it (adds go to the end).
 */
export function planRuleChanges(
  before: RuleLists,
  after: RuleLists,
): PlannedRuleChange[] {
  const where = (lists: RuleLists, rule: string) =>
    RULE_DECISIONS.find((d) => lists[d].some((r) => same(r, rule)));
  const removes: PlannedRuleChange[] = [];
  const moves: PlannedRuleChange[] = [];
  const adds: PlannedRuleChange[] = [];
  for (const decision of RULE_DECISIONS) {
    for (const rule of before[decision]) {
      const now = where(after, rule);
      if (!now) removes.push({ op: "remove", decision, rule: rule.trim() });
      else if (now !== decision) {
        moves.push({
          op: "update",
          decision,
          rule: rule.trim(),
          newDecision: now,
          newRule: rule.trim(),
        });
      }
    }
  }
  for (const decision of RULE_DECISIONS) {
    for (const rule of after[decision]) {
      if (!where(before, rule)) {
        adds.push({ op: "add", decision, rule: rule.trim() });
      }
    }
  }
  return [...removes, ...moves, ...adds];
}

export type ListEditResult =
  { ok: true; lists: RuleLists } | { ok: false; error: string };

/** Add a rule to a list, checked the way the rule editor checks it. */
export function addToList(
  lists: RuleLists,
  decision: RuleDecision,
  rule: string,
): ListEditResult {
  const text = rule.trim();
  const invalid = validateRuleText(text, decision);
  if (invalid) return { ok: false, error: invalid };
  const at = RULE_DECISIONS.find((d) => lists[d].some((r) => same(r, text)));
  if (at) {
    return {
      ok: false,
      error:
        at === decision
          ? "That rule is already in this list."
          : `That rule is already in the ${DECISION_NAMES[at]} list. Move it instead.`,
    };
  }
  return {
    ok: true,
    lists: { ...lists, [decision]: [...lists[decision], text] },
  };
}

export function removeFromList(
  lists: RuleLists,
  decision: RuleDecision,
  rule: string,
): RuleLists {
  return {
    ...lists,
    [decision]: lists[decision].filter((r) => !same(r, rule)),
  };
}

/** Move a rule to another list, at its end. */
export function moveToList(
  lists: RuleLists,
  from: RuleDecision,
  to: RuleDecision,
  rule: string,
): RuleLists {
  if (from === to) return lists;
  const without = removeFromList(lists, from, rule);
  if (without[to].some((r) => same(r, rule))) return without;
  return { ...without, [to]: [...without[to], rule.trim()] };
}

/** The words the page uses for the three lists (ruleWords.ts). */
export const DECISION_NAMES: Record<RuleDecision, string> = {
  deny: "Never",
  ask: "Ask",
  allow: "Always",
};

/** A sample call the preview checks a draft rule against. */
export interface PreviewSample {
  /** A rule name (`runTerminalCommand`, `readFile`) or an MCP tool name */
  tool: string;
  /** The command, path, URL or query; absent for an MCP tool */
  value?: string;
}

/**
 * Whether a draft rule matches a sample call, using the engine's own
 * matchers: matchTerminalCommand for commands (allow rules match only a
 * command the scanner fully understands, exactly as at run time) and
 * matchToolCall for everything else. Undefined when the rule cannot be read.
 */
export function ruleMatchesSample(
  rule: string,
  decision: RuleDecision,
  sample: PreviewSample,
): boolean | undefined {
  const parsed = parseRule(rule, decision);
  if (!parsed) return undefined;
  const tool = parsed.toolName.startsWith("mcp__")
    ? parsed.toolName
    : canonicalRuleName(parsed.toolName);
  const sampleTool = sample.tool.startsWith("mcp__")
    ? sample.tool
    : canonicalRuleName(sample.tool);
  const rules = [{ ...parsed, toolName: tool }];
  if (sampleTool === "runTerminalCommand") {
    if (tool !== "runTerminalCommand") return false;
    return matchTerminalCommand(rules, sample.value ?? "") !== undefined;
  }
  return matchToolCall(rules, sampleTool, sample.value) !== undefined;
}

/** The areas whose level differs from the base, for the review step. */
export function changedAreas(
  base: PolicyLevels,
  next: PolicyLevels,
): (typeof POLICY_AREAS)[number][] {
  return POLICY_AREAS.filter((a) => base[a] !== next[a]);
}

const VALUE_KEYS = [
  "command",
  "filepath",
  "filePath",
  "file_path",
  "dirPath",
  "path",
  "url",
  "query",
  "pattern",
] as const;

/**
 * A preview sample from one row of the audit list: the tool and the command,
 * path, URL or query it was called with. The row's summary is the masked
 * display value (a command) or the masked arguments as JSON; a value that
 * was clipped or cannot be read gives no sample.
 */
export function sampleFromCall(call: {
  tool: string;
  summary: string;
}): PreviewSample | undefined {
  const tool = call.tool.startsWith("mcp__")
    ? call.tool
    : canonicalRuleName(call.tool);
  if (tool.startsWith("mcp__")) return { tool };
  const text = call.summary.trim();
  if (!text || text.endsWith("…")) return undefined;
  if (tool === "runTerminalCommand" && !text.startsWith("{")) {
    return { tool, value: text };
  }
  try {
    const args = JSON.parse(text) as Record<string, unknown>;
    for (const key of VALUE_KEYS) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        return { tool, value: value.trim() };
      }
    }
  } catch {
    // not JSON: no sample
  }
  return undefined;
}

/**
 * The narrowest rule for one sample: the exact command, path or URL, or the
 * MCP tool's name. Never a wildcard: widening it is the person's choice.
 */
export function ruleForSample(sample: PreviewSample): string | undefined {
  if (sample.tool.startsWith("mcp__")) return sample.tool;
  if (!sample.value) return undefined;
  const rule = `${sample.tool}(${sample.value})`;
  return parseRule(rule, "ask") ? rule : undefined;
}
