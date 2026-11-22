import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolPolicy } from "@continuedev/terminal-security";
import type { MessageModes, Tool } from "../..";
import { resolveShell, type ShellKind } from "../../util/shell";
import { BuiltInToolNames } from "../builtIn";
import {
  fetchUrlContentTool,
  createNewFileTool,
  editFileTool,
  globSearchTool,
  grepSearchTool,
  lsTool,
  readFileTool,
  runTerminalCommandTool,
  searchWebTool,
} from "../definitions";
import { maskArgsForDisplay } from "./displayMask";
import { levelOfCall, type ApprovalSettings } from "./approval";
import type { EnvNameOptions } from "./envNames";
import { lintCommand, type LintFinding } from "./commandLint";
import { findRuleMatch, type DecisionSource } from "./decide";
import {
  listEffectiveRules,
  type EffectiveRule,
  type RuleSourcesInput,
} from "./effectiveRules";
import { evaluateToolPolicyWithRules } from "./evaluate";
import {
  detectInstructionLikeText,
  injectionNotice,
  type InjectionMatch,
} from "./injection";
import { mcpRuleName, parsePermissions } from "./names";
import {
  areaOfTool,
  DEFAULT_POLICY_LEVELS,
  POLICY_AREA_LABELS,
  type PolicyArea,
  type WebLevel,
  type PolicyLevels,
} from "./policy";
import type { ProtectedKind } from "./protected";
import type { Sink } from "./taint/taintSinks";
import type { TaintFact } from "./taint/taintState";
import type { RuleDecision, RuleSource, ToolPermissions } from "./rules";

/**
 * What the Permissions page and `continuous permissions test` run: the real
 * evaluator (`evaluateToolPolicyWithRules`), fed the rules in effect, with an
 * explanation of each step. Nothing is run, written or sent; the reviewer is
 * never called (a call it would get says so).
 */

export type TestDecision = "allow" | "ask" | "deny";

export interface TestToolCallInput {
  /**
   * The tool: a rule name (`runTerminalCommand`), the model's name
   * (`run_terminal_command`), the CLI's (`Bash`) or `mcp__server__tool`.
   */
  tool: string;
  command?: string;
  path?: string;
  url?: string;
  query?: string;
  /** Arguments as the tool takes them, for an MCP tool or to override the above */
  args?: Record<string, unknown>;
  /** The mode the agent is in. Chat has no tools; Plan holds anything that changes things. */
  mode?: MessageModes;
  /** Levels to test with; missing areas use the sources' levels, then the defaults */
  levels?: Partial<PolicyLevels>;
  /** The rule sources (see readRuleSources); `levels` here are overridden by `levels` above */
  sources: RuleSourcesInput;
  /** The person's own `auto.environment.envNames` (readUserEnvNames); never from `sources` */
  envNames?: EnvNameOptions;
  /** The tool's own setting; defaults to the tool's default */
  basePolicy?: ToolPolicy;
  /** The workspace folder; relative paths are resolved against it */
  cwd?: string;
  shell?: ShellKind;
  /** Text a tool returned, to see whether the injection notice would be put in front of it */
  outputText?: string;
  /** The tainted-session fact, to see what the rule would do (taint/taintRule.ts) */
  taint?: TaintFact;
}

export type StepOutcome = "passed" | "decided" | "skipped" | "info";

export interface TestStep {
  id:
    | "mode"
    | "lint"
    | "safety"
    | "floor"
    | "deny"
    | "protected"
    | "ask"
    | "allow"
    | "level"
    | "reviewer"
    | "injection";
  label: string;
  outcome: StepOutcome;
  detail: string;
}

export interface MatchedRule {
  raw: string;
  decision: RuleDecision;
  source: RuleSource;
  file?: string;
  locked: boolean;
  /** This is the rule the decision names */
  deciding: boolean;
}

export interface ToolCallTestResult {
  decision: TestDecision;
  policy: ToolPolicy;
  source?: DecisionSource | "mode" | "plan-mode" | "reviewer";
  /** The sentence a person reads, naming the real source of the rule */
  reason: string;
  /** The tool as the evaluator knows it, and what it was given */
  toolName: string;
  area?: PolicyArea | "web";
  level?: WebLevel;
  readOnly?: string;
  protection?: ProtectedKind;
  /** Every rule in effect that matches this call, the deciding one marked */
  matchedRules: MatchedRule[];
  /** The call would reach the reviewer model, which this test does not call */
  wouldAskReviewer: boolean;
  /** Only with `taint` given: the sink class the call is, when it is one */
  taintSink?: Sink;
  lint: LintFinding[];
  steps: TestStep[];
  notes: string[];
  injection?: { matches: InjectionMatch[]; notice: string };
}

type Kind =
  "command" | "read" | "write" | "list" | "fetch" | "grep" | "glob" | "web";

interface KindDef {
  tool: Tool;
  name: string;
  arg: string;
}

const KINDS: Record<Kind, KindDef> = {
  command: {
    tool: runTerminalCommandTool,
    name: BuiltInToolNames.RunTerminalCommand,
    arg: "command",
  },
  read: {
    tool: readFileTool,
    name: BuiltInToolNames.ReadFile,
    arg: "filepath",
  },
  write: {
    tool: editFileTool,
    name: BuiltInToolNames.EditExistingFile,
    arg: "filepath",
  },
  list: { tool: lsTool, name: BuiltInToolNames.LSTool, arg: "dirPath" },
  fetch: {
    tool: fetchUrlContentTool,
    name: BuiltInToolNames.FetchUrlContent,
    arg: "url",
  },
  grep: {
    tool: grepSearchTool,
    name: BuiltInToolNames.GrepSearch,
    arg: "query",
  },
  glob: {
    tool: globSearchTool,
    name: BuiltInToolNames.FileGlobSearch,
    arg: "pattern",
  },
  web: { tool: searchWebTool, name: BuiltInToolNames.SearchWeb, arg: "query" },
};

const ALIASES: Record<string, Kind> = {
  runterminalcommand: "command",
  bash: "command",
  command: "command",
  shell: "command",
  readfile: "read",
  read: "read",
  readfilerange: "read",
  writefile: "write",
  write: "write",
  edit: "write",
  multiedit: "write",
  createnewfile: "write",
  editexistingfile: "write",
  singlefindandreplace: "write",
  listdirectory: "list",
  list: "list",
  ls: "list",
  fetchurl: "fetch",
  fetch: "fetch",
  fetchurlcontent: "fetch",
  grepsearch: "grep",
  search: "grep",
  globsearch: "glob",
  filegobsearch: "glob",
  fileglobsearch: "glob",
  searchweb: "web",
};

function kindOf(tool: string): Kind | undefined {
  return ALIASES[tool.toLowerCase().replace(/[^a-z]/g, "")];
}

/** The tool names the tester understands, for the CLI's help and the page's list. */
export const TESTABLE_TOOLS: readonly string[] = [
  "runTerminalCommand",
  "readFile",
  "writeFile",
  "listDirectory",
  "fetchUrl",
  "grepSearch",
  "globSearch",
  "searchWeb",
  "mcp__<server>__<tool>",
];

function mcpParts(
  name: string,
): { serverName: string; toolName: string } | undefined {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  return m ? { serverName: m[1], toolName: m[2] } : undefined;
}

function resolveInside(
  target: string,
  cwd: string,
): { uri: string; within: boolean } {
  const abs = path.resolve(cwd, target);
  const rel = path.relative(cwd, abs);
  const within = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return { uri: pathToFileURL(abs).href, within };
}

function mergedLevels(input: TestToolCallInput): PolicyLevels {
  return {
    ...DEFAULT_POLICY_LEVELS,
    ...(input.sources.levels ?? {}),
    ...(input.levels ?? {}),
  };
}

/** The rules the engine may use, by source; ignored-for-trust and unreadable ones stay out. */
function usableRules(rules: EffectiveRule[]): {
  sources: Partial<Record<RuleSource, ToolPermissions>>;
  floor: string[];
  cliFile: number;
} {
  const sources: Partial<Record<RuleSource, ToolPermissions>> = {};
  const floor: string[] = [];
  let cliFile = 0;
  for (const r of rules) {
    if (r.source === "floor") {
      floor.push(r.raw);
      continue;
    }
    if (r.source === "permissions-yaml") {
      cliFile++;
      continue;
    }
    if (r.state === "ignored" && r.ignoredCause !== "level") continue;
    const bucket = (sources[r.source] ??= {});
    (bucket[r.decision] ??= []).push(r.raw);
  }
  return { sources, floor, cliFile };
}

const SETTLED_AT: Partial<Record<string, TestStep["id"]>> = {
  floor: "floor",
  "deny-rule": "deny",
  "safety-floor": "safety",
  "tool-setting": "level",
  "protected-path": "protected",
  "ask-rule": "ask",
  "allow-rule": "allow",
  permissive: "level",
  idgaf: "level",
  manual: "level",
  default: "level",
};

function decisionOf(policy: ToolPolicy): TestDecision {
  return policy === "disabled"
    ? "deny"
    : policy === "allowedWithPermission"
      ? "ask"
      : "allow";
}

interface Facts {
  matches: MatchedRule[];
  lint: LintFinding[];
  area?: PolicyArea | "web";
  level?: WebLevel;
  reviewer: boolean;
  settledAt: TestStep["id"] | "mode";
  protection?: ProtectedKind;
  rule?: string;
}

function ruleLine(m: MatchedRule): string {
  return `${m.raw}${m.deciding ? " (decided)" : ""}`;
}

function buildSteps(facts: Facts, result: ToolCallTestResult): TestStep[] {
  const order: TestStep["id"][] = [
    "lint",
    "safety",
    "floor",
    "deny",
    "protected",
    "ask",
    "allow",
    "level",
    "reviewer",
  ];
  const labels: Record<string, string> = {
    lint: "Command check",
    safety: "Built-in rule check",
    floor: "Locked rules",
    deny: "Never rules",
    protected: "Protected paths",
    ask: "Ask rules",
    allow: "Always rules",
    level: "Area level",
    reviewer: "Reviewer",
  };
  const matchText = (decision: RuleDecision | "floor") => {
    const list = facts.matches.filter((m) =>
      decision === "floor"
        ? m.source === "floor"
        : m.decision === decision && m.source !== "floor",
    );
    return list.length ? list.map(ruleLine).join("; ") : undefined;
  };
  const steps: TestStep[] = [];
  const settledIndex = order.indexOf(facts.settledAt as TestStep["id"]);
  order.forEach((id, i) => {
    const after =
      settledIndex >= 0 &&
      i > settledIndex &&
      !(id === "reviewer" && facts.reviewer);
    let detail = "";
    let outcome: StepOutcome = after ? "skipped" : "passed";
    if (!after) {
      switch (id) {
        case "lint":
          detail = facts.lint.length
            ? facts.lint.map((f) => `${f.code}: ${f.message}`).join(" ")
            : "Nothing found.";
          outcome = facts.lint.length ? "info" : "passed";
          break;
        case "safety":
          detail = "The built-in check does not refuse this call.";
          break;
        case "floor":
          detail = matchText("floor") ?? "No floor rule matches.";
          break;
        case "deny":
          detail = matchText("deny") ?? "No deny rule matches.";
          break;
        case "protected":
          detail = facts.protection
            ? `Protected: ${facts.protection}.`
            : "Touches no protected path.";
          break;
        case "ask":
          detail = matchText("ask") ?? "No ask rule matches.";
          break;
        case "allow":
          detail = matchText("allow") ?? "No allow rule matches.";
          break;
        case "level":
          detail = facts.level
            ? `${facts.area ? (facts.area === "web" ? "Web" : POLICY_AREA_LABELS[facts.area]) : "This call"} is ${facts.level}.`
            : "This call belongs to no area.";
          break;
        case "reviewer":
          detail = "Not consulted: the call was settled before it.";
          break;
      }
    }
    if (id === "reviewer" && facts.reviewer) {
      detail =
        "Would ask the reviewer: nothing above settled this call and its area is Automatic. This test does not call a model.";
      outcome = "decided";
    }
    if (id === facts.settledAt) {
      outcome = "decided";
      detail = result.reason || detail;
    }
    steps.push({ id, label: labels[id], outcome, detail });
  });
  return steps;
}

type ToolLike = Pick<
  Tool,
  | "group"
  | "originalFunctionName"
  | "uri"
  | "evaluateToolCallPolicy"
  | "readonly"
  | "mcpDefinitionChange"
>;

interface PreparedCall {
  kind?: Kind;
  def?: KindDef;
  mcp?: { serverName: string; toolName: string };
  tool?: ToolLike;
  toolName: string;
  parsedArgs: Record<string, unknown>;
  processedArgs?: Record<string, unknown>;
}

function primaryArgOf(kind: Kind | undefined, input: TestToolCallInput) {
  switch (kind) {
    case "command":
      return input.command;
    case "fetch":
      return input.url;
    case "grep":
    case "web":
      return input.query;
    default:
      return input.path;
  }
}

/** The tool, its arguments and the path facts the tool's own check reads. */
function prepareCall(input: TestToolCallInput, cwd: string): PreparedCall {
  const mcp = mcpParts(input.tool);
  const kind = mcp ? undefined : kindOf(input.tool);
  const def = kind ? KINDS[kind] : undefined;
  const primary = primaryArgOf(kind, input);
  const parsedArgs: Record<string, unknown> = {
    ...(def && primary !== undefined ? { [def.arg]: primary } : {}),
    ...(input.args ?? {}),
  };
  const toolName =
    def?.name ?? (mcp ? mcpRuleName(mcp.serverName, mcp.toolName) : input.tool);
  const tool: ToolLike | undefined = def
    ? def.tool
    : mcp
      ? {
          group: mcp.serverName,
          originalFunctionName: mcp.toolName,
          uri: `mcp:${mcp.serverName}`,
          readonly: false,
        }
      : undefined;
  const pathArg =
    def && kind && ["read", "write", "list"].includes(kind)
      ? parsedArgs[def.arg]
      : undefined;
  let processedArgs: Record<string, unknown> | undefined;
  if (typeof pathArg === "string" && pathArg) {
    const { uri, within } = resolveInside(pathArg, cwd);
    processedArgs = {
      resolvedPath: {
        uri,
        displayPath: pathArg,
        isAbsolute: path.isAbsolute(pathArg),
        isWithinWorkspace: within,
      },
    };
  }
  return { kind, def, mcp, tool, toolName, parsedArgs, processedArgs };
}

/** Every rule that matches, one at a time, so a shadowed rule still shows. */
function findMatches(
  rules: EffectiveRule[],
  call: PreparedCall,
  basePolicy: ToolPolicy,
  shell: ShellKind,
  decidedBy: string | undefined,
): MatchedRule[] {
  if (!call.tool) return [];
  const resolvedPath = call.processedArgs
    ? decodeURIComponent(
        new URL((call.processedArgs.resolvedPath as { uri: string }).uri)
          .pathname,
      )
    : undefined;
  const matches: MatchedRule[] = [];
  for (const r of rules) {
    if (r.source === "permissions-yaml") continue;
    if (r.state === "ignored" && r.ignoredCause !== "level") continue;
    const hit = findRuleMatch({
      toolName: call.toolName,
      mcp: call.mcp,
      parsedArgs: call.parsedArgs,
      resolvedPath,
      base: basePolicy,
      evaluated: basePolicy,
      rules: parsePermissions({ [r.decision]: [r.raw] }, r.source),
      shell,
    });
    if (!hit) continue;
    matches.push({
      raw: r.raw,
      decision: r.decision,
      source: r.source,
      ...(r.file ? { file: r.file } : {}),
      locked: r.locked,
      deciding: decidedBy === r.raw,
    });
  }
  return matches;
}

interface Verdict {
  policy: ToolPolicy;
  source: ToolCallTestResult["source"];
  reason: string;
  settledMode: boolean;
  wouldAskReviewer: boolean;
}

/** The evaluator's answer, then what the mode and the reviewer add to it. */
function verdictOf(
  evaluated: ReturnType<typeof evaluateToolPolicyWithRules>,
  input: TestToolCallInput,
  facts: { basePolicy: ToolPolicy; tool?: ToolLike; level?: WebLevel },
): Verdict {
  let policy = evaluated.policy;
  let source: Verdict["source"] = evaluated.source;
  let reason = evaluated.reason ?? "";
  // The evaluator names no source when no rule or level was involved
  if (policy === "disabled" && !source) {
    const off = facts.basePolicy === "disabled";
    source = off ? "tool-setting" : "safety-floor";
    reason = off
      ? "This tool is turned off in your tool settings."
      : "This command is refused by the built-in safety check.";
  }
  let settledMode = false;
  if (input.mode === "chat") {
    policy = "disabled";
    source = "mode";
    reason = "Chat mode offers no tools, so this call cannot happen.";
    settledMode = true;
  }
  if (!reason) {
    reason =
      policy === "allowedWithoutPermission"
        ? "Nothing stops this call, so it runs."
        : policy === "disabled"
          ? "This tool is turned off or the call is refused."
          : "Nothing settles this call, so it asks.";
  }
  const open =
    policy === "allowedWithPermission" &&
    (source === undefined || source === "tool-setting" || source === "default");
  const wouldAskReviewer =
    open &&
    facts.level === "automatic" &&
    input.mode !== "plan" &&
    !settledMode;
  if (wouldAskReviewer) {
    reason =
      "Would ask the reviewer: your rules leave this call open and its area is Automatic. This test does not call a model.";
  }
  return { policy, source, reason, settledMode, wouldAskReviewer };
}

function settledStep(v: Verdict): Facts["settledAt"] {
  if (v.settledMode) return "mode";
  if (v.source === "plan-mode") return "level";
  if (v.wouldAskReviewer) return "reviewer";
  return SETTLED_AT[v.source ?? "default"] ?? "level";
}

/** Whether a tool result with this text would carry the injection notice. */
function resultCheck(outputText: string): {
  step: TestStep;
  injection?: ToolCallTestResult["injection"];
} {
  const found = detectInstructionLikeText(outputText);
  return {
    injection: found.length
      ? { matches: found, notice: injectionNotice(found).trim() }
      : undefined,
    step: {
      id: "injection",
      label: "Result check",
      outcome: found.length ? "info" : "passed",
      detail: found.length
        ? `The result would be marked: it ${found.map((m) => m.label).join("; ")}.`
        : "The result looks like data, so it is not marked.",
    },
  };
}

/**
 * Run one tool call through the real evaluator and say why it came out as it
 * did. Deterministic and side-effect free: it reads nothing but what it is
 * given (and the file system's answer to "is this path inside the workspace").
 */
export function testToolCall(input: TestToolCallInput): ToolCallTestResult {
  const levels = mergedLevels(input);
  const report = listEffectiveRules({ ...input.sources, levels });
  const usable = usableRules(report.rules);
  const cwd = input.cwd ?? process.cwd();
  const shell = input.shell ?? resolveShell().kind;
  const call = prepareCall(input, cwd);
  const { tool, toolName, parsedArgs } = call;
  const notes: string[] = [];
  if (usable.cliFile) {
    notes.push(
      `${usable.cliFile} rule${usable.cliFile === 1 ? "" : "s"} in permissions.yaml use the CLI's own dialect and are weighed by the CLI first. This test runs the shared engine only.`,
    );
  }
  if (!tool) {
    notes.push(
      `"${input.tool}" is not a tool name the tester knows (${TESTABLE_TOOLS.join(", ")}); the evaluator leaves an unknown tool at its setting.`,
    );
  }

  const basePolicy: ToolPolicy =
    input.basePolicy ??
    (call.def?.tool.defaultToolPolicy as ToolPolicy | undefined) ??
    "allowedWithPermission";
  const approval: ApprovalSettings = {
    levels,
    builtin: input.sources.builtin,
    floor: usable.floor,
  };
  const evaluated = evaluateToolPolicyWithRules({
    tool: tool as never,
    toolName,
    basePolicy,
    parsedArgs,
    processedArgs: call.processedArgs,
    permissions: undefined,
    permissionSources: usable.sources,
    approval,
    trustedDomains:
      input.sources.trustedDomains ??
      input.sources.user?.auto?.environment?.trustedDomains,
    envNames: input.envNames,
    largeChangeLines: input.sources.user?.auto?.environment?.largeChangeLines,
    cwd,
    shell,
    // Plan mode's hold is the evaluator's own last step
    planMode: input.mode === "plan",
    ...(input.taint ? { taint: input.taint } : {}),
  });

  const callContext = { parsedArgs, cwd, shell };
  const found = tool
    ? levelOfCall(approval, toolName, tool as never, callContext)
    : undefined;
  const area = found?.area ?? areaOfTool(toolName, tool as never, callContext);
  const level = found?.level ?? (area ? levels[area] : undefined);
  const matches = findMatches(
    report.rules,
    call,
    basePolicy,
    shell,
    evaluated.rule,
  );
  const verdict = verdictOf(evaluated, input, { basePolicy, tool, level });
  const lint =
    call.kind === "command" && typeof parsedArgs.command === "string"
      ? lintCommand(parsedArgs.command, shell)
      : [];

  const result: ToolCallTestResult = {
    decision: decisionOf(verdict.policy),
    policy: verdict.policy,
    ...(verdict.source ? { source: verdict.source } : {}),
    reason: verdict.reason,
    toolName,
    ...(area ? { area } : {}),
    ...(level ? { level } : {}),
    ...(evaluated.readOnly ? { readOnly: evaluated.readOnly } : {}),
    ...(evaluated.protection ? { protection: evaluated.protection } : {}),
    matchedRules: matches,
    wouldAskReviewer: verdict.wouldAskReviewer,
    ...(evaluated.taintSink ? { taintSink: evaluated.taintSink } : {}),
    lint,
    steps: [],
    notes,
  };
  result.steps = buildSteps(
    {
      matches,
      lint,
      area,
      level,
      reviewer: verdict.wouldAskReviewer,
      settledAt: settledStep(verdict),
      protection: evaluated.protection,
      rule: evaluated.rule,
    },
    result,
  );
  if (verdict.settledMode) {
    result.steps.unshift({
      id: "mode",
      label: "Mode",
      outcome: "decided",
      detail: verdict.reason,
    });
  }
  if (input.outputText) {
    const check = resultCheck(input.outputText);
    if (check.injection) result.injection = check.injection;
    result.steps.push(check.step);
  }
  // The tester echoes the call it was given; a credential in it is masked.
  return maskArgsForDisplay(result);
}
