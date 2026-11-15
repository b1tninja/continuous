import { isKnownRuleName, canonicalRuleName } from "./names";
import {
  areaOfTool,
  BUILTIN_RULES,
  DEFAULT_AGENT_DECIDES,
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  DEFAULT_POLICY_LEVELS,
  DEFAULT_YOU_DECIDE,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVEL_DESCRIPTIONS,
  policyLevelLabel,
  type BuiltinRuleId,
  type PolicyArea,
  type PolicyLevel,
  type PolicyLevels,
  type QuestionDelivery,
  type QuestionType,
} from "./policy";
import {
  isDestinationPattern,
  parseRule,
  type RuleDecision,
  type RuleSource,
  type ToolPermissions,
} from "./rules";

/**
 * Every permission rule in effect, with where it came from and whether it is
 * being obeyed (plans/rule-editor.md, slice 1). Pure: callers read the files
 * (readRuleSources.ts) and pass what they read.
 *
 * AREA OF A RULE. The area is decided by the rule's tool name, the same sets
 * `areaOfTool` uses for a call:
 *   - Context use: readFile, listDirectory, grepSearch, globSearch (and the
 *     CLI's Read, List, Search, Diff, Skills).
 *   - File edits: writeFile (and Edit, MultiEdit, Write).
 *   - Tool use: runTerminalCommand (Bash), fetchUrl, searchWeb, every MCP tool
 *     (`mcp__server__tool`) and any tool this version does not know.
 *   - No area: tools that only touch the session (the task list, Loop's tools).
 * A terminal command rule is shown under Tool use, but a command the parser
 * vouches as only reading is Context use for that one call, so its `areaNote`
 * says the area is decided per call. Plan and Questions have no rule lists:
 * they have a level and a few settings.
 */

export type RuleState = "effective" | "ignored";

/** Why a rule is ignored: `trust` (the source may not loosen), `level`, or `unreadable`. */
export type IgnoredCause = "trust" | "level" | "unreadable";

export interface EffectiveRule {
  /** Stable within one report: `source:decision:index` */
  id: string;
  /** undefined for tools with no area, and for rules that cannot be read */
  area?: PolicyArea;
  /** Set for a terminal command rule, whose area depends on the command */
  areaNote?: string;
  decision: RuleDecision;
  /** The rule as written in its own file */
  raw: string;
  /** Which dialect `raw` is: config.yaml's, or the CLI's permissions.yaml */
  dialect: "core" | "cli";
  /** The rule in config.yaml's dialect (`runTerminalCommand(npm test*)`), when it has one */
  core?: string;
  /** The rule in the CLI's dialect (`Bash(npm test*)`), when it has one */
  cli?: string;
  /** The tool name at the head of the rule, as written */
  tool: string;
  source: RuleSource;
  /** The workspace file, for a `folder` rule */
  file?: string;
  state: RuleState;
  /** Set when `state` is "ignored": the sentence to show. */
  ignoredReason?: string;
  ignoredCause?: IgnoredCause;
  /** Cannot be changed from the rule list: floor rules and built-ins */
  locked: boolean;
  /** Set when `locked`: the sentence that says why and where it is changed */
  lockedReason?: string;
  /** Things that are wrong with an effective rule (never matches, unknown tool) */
  warnings: string[];
}

export interface BuiltinProtection {
  id: BuiltinRuleId;
  label: string;
  description: string;
  on: boolean;
  /** Built-ins can be switched off (permissions.yaml), so they are locked as rules but not as switches. */
  switchable: true;
  areas: PolicyArea[];
}

export interface AreaReport {
  area: PolicyArea;
  label: string;
  level: PolicyLevel;
  levelLabel: string;
  levelDescription: string;
  /** Rules whose tool belongs to this area, in the order: deny, ask, allow, then by source */
  rules: EffectiveRule[];
  builtins: BuiltinProtection[];
  /** Plan and Questions: the few settings they have. Other areas have none. */
  settings?: PlanSettings | QuestionSettings;
}

export interface PlanSettings {
  kind: "plan";
  maxNewItems: number;
  keepsChecks: boolean;
}

export interface QuestionSettings {
  kind: "questions";
  delivery: QuestionDelivery;
  youDecide: QuestionType[];
  agentDecides: QuestionType[];
}

/** The state of the person's own config.yaml, which is where rules are written. */
export interface UserFileState {
  path: string;
  state: "ok" | "missing" | "broken";
  /** Why it is broken; never shown as "no rules" */
  error?: string;
  /** SHA-256 of its text, for the editor's compare before writing */
  hash?: string;
  /** This session made a change that Undo can put back */
  undoable?: boolean;
}

export interface EffectiveRulesReport {
  /** The file rules are written to, and whether it can be read */
  userFile?: UserFileState;
  areas: Record<PolicyArea, AreaReport>;
  /** Every rule, in the same order as the areas, then the ones with no area */
  rules: EffectiveRule[];
  /** Rules for tools with no area, and rules that cannot be read */
  unscoped: EffectiveRule[];
  /** Fixed text: how rules are weighed (order does not matter) */
  decisionOrder: string;
  /** Things the reader of the files had to say, one line each */
  notices: string[];
}

export interface PolicyInput {
  levels?: PolicyLevels;
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
  maxNewPlanItems?: number;
  questions?: {
    delivery?: QuestionDelivery;
    youDecide?: QuestionType[];
    agentDecides?: QuestionType[];
  };
}

export interface RuleSourcesInput extends PolicyInput {
  /** `toolPermissions` of the person's own config.yaml */
  user?: ToolPermissions;
  /** What state that file is in */
  userFile?: UserFileState;
  /** `toolPermissions.auto.environment.trustedDomains` of that file (not part of `user`, which holds the rule lists) */
  trustedDomains?: string[];
  /** `toolPermissions` that came from an assistant or hub configuration */
  assistant?: ToolPermissions;
  /** `toolPermissions` of files that came with the workspace, as written */
  folder?: { file: string; permissions: ToolPermissions }[];
  /** The CLI's lists in permissions.yaml (`exclude` is its word for deny) */
  cliFile?: { allow?: string[]; ask?: string[]; exclude?: string[] };
  /** Deny rules in permissions.yaml that bind at every level */
  floor?: string[];
  /**
   * What an `allow` from the assistant source counts as. Effective until the
   * trust hardening lands (branch rule-trust-hardening): that change sets it
   * to "ignored" and this model already shows the reason.
   */
  assistantAllow?: "effective" | "ignored";
  notices?: string[];
}

const DECISION_ORDER =
  "A call is weighed by decision, not by position: always-on rules, then Never rules, then protected paths, then Ask rules, then Always rules, then the area's level. Where a rule sits in a list does not matter.";

export const FLOOR_LOCK_REASON =
  "An always-on rule (floor:) in your permissions.yaml. It binds at every level below IDGAF (IDGAF runs the call and records the rule), so it is changed only by editing that file.";

export const FOLDER_ALLOW_REASON =
  "It came with the workspace. A repository can add deny and ask rules but not allow rules; move it to your own config.yaml to use it.";
export const ASSISTANT_ALLOW_REASON =
  "It came from the assistant configuration. Only your own config.yaml can add allow rules.";

/** The CLI's tool names (permissions.yaml) and the rule names config.yaml uses. */
const CLI_TO_CORE: Record<string, string> = {
  Bash: "runTerminalCommand",
  Read: "readFile",
  Write: "writeFile",
  Edit: "writeFile",
  MultiEdit: "writeFile",
  List: "listDirectory",
  Fetch: "fetchUrl",
  Search: "grepSearch",
};
const CORE_TO_CLI: Record<string, string> = {
  runTerminalCommand: "Bash",
  readFile: "Read",
  writeFile: "Write",
  listDirectory: "List",
  fetchUrl: "Fetch",
  grepSearch: "Search",
  globSearch: "Search",
};

/** Built-in rules and the areas they act in. */
const BUILTIN_AREAS: Record<BuiltinRuleId, PolicyArea[]> = {
  "protect-secrets": ["context", "tools", "edits"],
  "protect-config": ["tools", "edits"],
  "protect-network-paths": ["context", "tools"],
  "refuse-dangerous-commands": ["tools"],
  "no-fetch-and-run": ["tools"],
  "ask-destructive-commands": ["tools"],
  "ask-large-change": ["edits"],
  "ask-dependency-change": ["tools", "edits"],
  "ask-unknown-host": ["tools"],
  "ask-outside-paths": ["context", "edits"],
  "plan-keeps-checks": ["plan"],
};

/** The area a rule's tool name belongs to, or undefined for session-only tools. */
export function areaOfRuleName(name: string): PolicyArea | undefined {
  return areaOfTool(name);
}

/** A rule in the other dialect, when the tool has a counterpart and the pattern carries over. */
function convert(
  raw: string,
  from: "core" | "cli",
): { core?: string; cli?: string } {
  const m = raw.match(/^([A-Za-z_][\w.*-]*)(?:\((.*)\))?$/);
  if (!m) return {};
  const [, head, pattern] = m;
  const suffix = pattern === undefined ? "" : `(${pattern})`;
  if (head.startsWith("mcp__")) {
    // The same name in both; a pattern after an MCP name never matches either way
    return { core: raw, cli: raw };
  }
  if (from === "core") {
    const cliName = CORE_TO_CLI[canonicalRuleName(head)];
    // `host:`, `net:` and `effect:` patterns are the core engine's own
    const coreOnly =
      pattern !== undefined &&
      (isDestinationPattern(pattern) || /^effect:/i.test(pattern.trim()));
    return {
      core: raw,
      ...(cliName && !coreOnly ? { cli: `${cliName}${suffix}` } : {}),
    };
  }
  const coreName = CLI_TO_CORE[head];
  return { cli: raw, ...(coreName ? { core: `${coreName}${suffix}` } : {}) };
}

function warningsFor(raw: string, decision: RuleDecision): string[] {
  const warnings: string[] = [];
  const m = raw.match(/^([A-Za-z_][\w.*-]*)(?:\((.*)\))?$/);
  if (!m) return warnings;
  const [, head, pattern] = m;
  if (!isKnownRuleName(canonicalRuleName(head)) && !isKnownRuleName(head)) {
    warnings.push(
      `"${head}" is not a tool name this version knows, so the rule matches nothing unless a tool has that exact name.`,
    );
  }
  if (head.startsWith("mcp__") && pattern !== undefined) {
    warnings.push(
      "A pattern after an MCP tool name never matches: write the rule as the tool name alone.",
    );
  }
  if (
    decision === "allow" &&
    pattern !== undefined &&
    (isDestinationPattern(pattern) || /^effect:/i.test(pattern.trim()))
  ) {
    warnings.push("An allow rule written this way never allows anything.");
  }
  return warnings;
}

function levelIgnore(
  decision: RuleDecision,
  area: PolicyArea | undefined,
  levels: PolicyLevels,
): string | undefined {
  if (!area) return undefined;
  const level = levels[area];
  const name = POLICY_AREA_LABELS[area];
  if (level === "idgaf") {
    return `${name} is set to ${policyLevelLabel(area, level)}, which ignores every rule except the floor.`;
  }
  // File edits are excluded: their check is the diff the person reviews
  if (level === "manual" && decision === "allow" && area !== "edits") {
    return `${name} is Manual, so allow rules are not consulted. Deny and ask rules still apply.`;
  }
  return undefined;
}

interface Pending {
  source: RuleSource;
  decision: RuleDecision;
  raw: string;
  dialect: "core" | "cli";
  file?: string;
  locked: boolean;
}

function gather(input: RuleSourcesInput): Pending[] {
  const out: Pending[] = [];
  const add = (
    source: RuleSource,
    perms: ToolPermissions | undefined,
    extra: { file?: string; locked?: boolean } = {},
  ) => {
    for (const decision of ["deny", "ask", "allow"] as RuleDecision[]) {
      for (const raw of perms?.[decision] ?? []) {
        out.push({
          source,
          decision,
          raw,
          dialect: "core",
          locked: extra.locked ?? false,
          ...(extra.file ? { file: extra.file } : {}),
        });
      }
    }
  };
  add("floor", { deny: input.floor }, { locked: true });
  add("user-config", input.user);
  for (const f of input.folder ?? []) add("folder", f.permissions, f);
  add("assistant", input.assistant);
  const cli = input.cliFile;
  for (const [list, decision] of [
    ["exclude", "deny"],
    ["ask", "ask"],
    ["allow", "allow"],
  ] as const) {
    for (const raw of cli?.[list] ?? []) {
      out.push({
        source: "permissions-yaml",
        decision,
        raw,
        dialect: "cli",
        locked: false,
      });
    }
  }
  return out;
}

function toRule(
  p: Pending,
  index: number,
  levels: PolicyLevels,
  assistantAllow: "effective" | "ignored",
): EffectiveRule {
  const id = `${p.source}:${p.decision}:${index}`;
  const base = {
    id,
    decision: p.decision,
    raw: p.raw,
    dialect: p.dialect,
    source: p.source,
    ...(p.file ? { file: p.file } : {}),
    locked: p.locked,
    ...(p.locked ? { lockedReason: FLOOR_LOCK_REASON } : {}),
  };
  const parsed = parseRule(p.raw, p.decision);
  if (!parsed) {
    return {
      ...base,
      tool: p.raw,
      state: "ignored",
      ignoredCause: "unreadable",
      ignoredReason: `Cannot be read. Write it as toolName(pattern) or just toolName.`,
      warnings: [],
    };
  }
  const area = areaOfRuleName(parsed.toolName);
  const rule: EffectiveRule = {
    ...base,
    ...convert(p.raw, p.dialect),
    tool: parsed.toolName,
    ...(area ? { area } : {}),
    ...(canonicalRuleName(parsed.toolName) === "runTerminalCommand"
      ? {
          areaNote:
            "A command that only reads is Context use for that call; the area is decided per command.",
        }
      : {}),
    state: "effective",
    warnings: warningsFor(p.raw, p.decision),
  };
  let reason: string | undefined;
  let cause: IgnoredCause | undefined;
  if (p.source === "folder" && p.decision === "allow") {
    reason = FOLDER_ALLOW_REASON;
    cause = "trust";
  } else if (
    p.source === "assistant" &&
    p.decision === "allow" &&
    assistantAllow === "ignored"
  ) {
    reason = ASSISTANT_ALLOW_REASON;
    cause = "trust";
  } else if (p.source !== "floor" && p.source !== "permissions-yaml") {
    reason = levelIgnore(p.decision, area, levels);
    cause = reason ? "level" : undefined;
  }
  if (reason && cause) {
    rule.state = "ignored";
    rule.ignoredReason = reason;
    rule.ignoredCause = cause;
  }
  return rule;
}

const DECISION_RANK: Record<RuleDecision, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
};

function sortRules(a: EffectiveRule, b: EffectiveRule): number {
  return (
    DECISION_RANK[a.decision] - DECISION_RANK[b.decision] ||
    a.tool.localeCompare(b.tool) ||
    a.raw.localeCompare(b.raw)
  );
}

function areaReport(
  area: PolicyArea,
  rules: EffectiveRule[],
  input: RuleSourcesInput,
  levels: PolicyLevels,
): AreaReport {
  const level = levels[area];
  const builtins: BuiltinProtection[] = BUILTIN_RULES.filter((b) =>
    BUILTIN_AREAS[b.id].includes(area),
  ).map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    on: input.builtin?.[b.id] !== false,
    switchable: true,
    areas: BUILTIN_AREAS[b.id],
  }));
  const report: AreaReport = {
    area,
    label: POLICY_AREA_LABELS[area],
    level,
    levelLabel: policyLevelLabel(area, level),
    levelDescription: POLICY_LEVEL_DESCRIPTIONS[area][level],
    rules: rules.filter((r) => r.area === area).sort(sortRules),
    builtins,
  };
  if (area === "plan") {
    report.settings = {
      kind: "plan",
      maxNewItems: input.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS,
      keepsChecks: input.builtin?.["plan-keeps-checks"] !== false,
    };
  }
  if (area === "questions") {
    report.settings = {
      kind: "questions",
      delivery: input.questions?.delivery ?? "inbox",
      youDecide: input.questions?.youDecide ?? [...DEFAULT_YOU_DECIDE],
      agentDecides: input.questions?.agentDecides ?? [...DEFAULT_AGENT_DECIDES],
    };
  }
  return report;
}

/**
 * Every rule from every source, with its area, decision, both dialects, source
 * and whether it is obeyed. Rules of a floor, a built-in switch or a level are
 * included so a person sees what binds them; nothing here is written.
 */
export function listEffectiveRules(
  input: RuleSourcesInput,
): EffectiveRulesReport {
  const levels = input.levels ?? DEFAULT_POLICY_LEVELS;
  const assistantAllow = input.assistantAllow ?? "effective";
  const rules = gather(input).map((p, i) =>
    toRule(p, i, levels, assistantAllow),
  );
  const areas = Object.fromEntries(
    POLICY_AREAS.map((a) => [a, areaReport(a, rules, input, levels)]),
  ) as Record<PolicyArea, AreaReport>;
  const unscoped = rules.filter((r) => !r.area).sort(sortRules);
  return {
    areas,
    rules: [...POLICY_AREAS.flatMap((a) => areas[a].rules), ...unscoped],
    unscoped,
    decisionOrder: DECISION_ORDER,
    notices: input.notices ?? [],
    ...(input.userFile ? { userFile: input.userFile } : {}),
  };
}

/** Rules that belong to one area, for `--area`. */
export function rulesOfArea(
  report: EffectiveRulesReport,
  area: PolicyArea,
): EffectiveRule[] {
  return report.areas[area].rules;
}
