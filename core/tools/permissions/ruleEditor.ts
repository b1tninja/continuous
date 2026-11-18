import type { ConfigYaml } from "@continuedev/config-yaml";
import { editConfigYamlFile, restoreConfigFileText } from "../../util/paths";
import { editYamlText } from "../../util/yamlEdit";
import type { AuditTrail } from "./audit/trail";
import {
  analyzeRule,
  CONFIRM_PHRASE,
  confirmationEnough,
  lineDiff,
  type ChangeSource,
  type DiffLine,
  type PeerRule,
  type RuleAnalysis,
} from "./ruleAnalysis";
import {
  listEffectiveRules,
  type EffectiveRule,
  type RuleSourcesInput,
} from "./effectiveRules";
import { readUserConfigFile } from "./readRuleSources";
import type { RuleDecision, ToolPermissions } from "./rules";
import { testToolCall, type TestDecision } from "./testToolCall";
import { canonicalRuleName } from "./names";
import { readUserEnvNames } from "./userEnvNames";
import { refusalFor } from "./ruleRefusal";

/**
 * The write side of the Permissions page and `continuous permissions add|remove|adopt`
 * (plans/rule-editor.md, slice 2).
 *
 * What it writes: the core dialect only, `toolPermissions` in the person's own
 * config.yaml, through the comment-preserving YAML edit. The CLI's `Bash(...)`
 * lists in permissions.yaml are read elsewhere and never written here.
 *
 * What it will not do: write a file it cannot read (a broken config.yaml is an
 * error, not "no rules"), write over a file that changed since the caller read
 * it, report a save that did not happen, or let a broad Always rule in without
 * the typed phrase. Only a webview or CLI message reaches this module; no tool
 * the model can call does, and config.yaml is a locked policy file besides
 * (selfProtect.ts).
 */

export type ToolRuleOp = "add" | "update" | "remove" | "adopt";

export interface ToolRuleEdit {
  op: ToolRuleOp;
  decision: RuleDecision;
  rule: string;
  /** update: the list and text the rule becomes */
  newDecision?: RuleDecision;
  newRule?: string;
  /** adopt: where the rule is now (shown in the audit event) */
  from?: "folder" | "assistant" | "permissions-yaml";
  /** The typed phrase, or "yes" for a plain confirmation */
  confirm?: string;
  /** The hash of the file the caller last saw; a different file is a conflict */
  baseHash?: string;
  /** Check and explain, write nothing */
  dryRun?: boolean;
  /** A sample call, typed as the tester takes it, to show what the rule changes */
  probe?: string;
  /**
   * A person confirmed this change in a dialog the page cannot reach (the
   * IDE's own). Only the host sets it, never a message from the page.
   */
  confirmedNatively?: boolean;
  source: ChangeSource;
}

export type ToolRuleEditResult =
  | "added"
  | "exists"
  | "updated"
  | "removed"
  | "adopted"
  | "preview"
  | "needs-confirmation"
  | "no-config"
  | "invalid"
  | "broken"
  | "conflict"
  | "failed"
  | "not-found"
  | "refused";

export interface VerdictLite {
  decision: TestDecision;
  source?: string;
  /** Where the deciding rule came from, when a rule decided */
  ruleSource?: string;
  reason: string;
}

export interface RuleVerdict {
  /** The sample call, as text */
  probe: string;
  /** What the call gets now, and what it would get with the change */
  before: VerdictLite;
  after: VerdictLite;
}

export interface ToolRuleEditResponse {
  result: ToolRuleEditResult;
  /** A sentence a person reads, for every result that is not a success */
  error?: string;
  analysis?: RuleAnalysis;
  /** What would change (dry run) or changed, as lines of config.yaml */
  diff?: DiffLine[];
  verdict?: RuleVerdict;
  /** Hash of the file before and after, so the caller can edit again from the right base */
  beforeHash?: string;
  afterHash?: string;
  /** There is an earlier text of the file to put back */
  undoable?: boolean;
  /** The policy-change event was written (or the trail is off) */
  auditWritten?: boolean;
}

export interface EditDeps {
  /** The person's own config.yaml */
  file: string;
  /** The rule sources now, read fresh for each call */
  sources: () => RuleSourcesInput;
  /** The trail to write the policy-change event to */
  audit?: AuditTrail;
  home: string;
  cwd?: string;
}

const same = (a: string, b: string) => a.trim() === b.trim();

/** One list of the config's `toolPermissions`, as written. */
function listOf(config: ConfigYaml, decision: RuleDecision): string[] {
  return [...((config.toolPermissions?.[decision] as string[]) ?? [])];
}

function withList(
  config: ConfigYaml,
  decision: RuleDecision,
  list: string[],
): ConfigYaml {
  const current: ToolPermissions = { ...(config.toolPermissions ?? {}) };
  if (list.length) current[decision] = list;
  else delete current[decision];
  const next: ConfigYaml = { ...config };
  if (Object.keys(current).length) next.toolPermissions = current;
  else delete next.toolPermissions;
  return next;
}

/**
 * The config with the edit applied, and why nothing changed when nothing did.
 * Pure. Other lists, other keys and the order of the other rules are left alone.
 */
export function applyToolRuleOp(
  config: ConfigYaml,
  edit: Pick<
    ToolRuleEdit,
    "op" | "decision" | "rule" | "newDecision" | "newRule"
  >,
): { config: ConfigYaml; skip?: "exists" | "not-found" } {
  const rule = edit.rule.trim();
  if (edit.op === "add" || edit.op === "adopt") {
    const list = listOf(config, edit.decision);
    if (list.some((r) => same(r, rule))) return { config, skip: "exists" };
    return { config: withList(config, edit.decision, [...list, rule]) };
  }
  const from = listOf(config, edit.decision);
  if (!from.some((r) => same(r, rule))) return { config, skip: "not-found" };
  const without = from.filter((r) => !same(r, rule));
  if (edit.op === "remove") {
    return { config: withList(config, edit.decision, without) };
  }
  // update: the same rule may move list, change text, or both
  const toDecision = edit.newDecision ?? edit.decision;
  const toRule = (edit.newRule ?? edit.rule).trim();
  const target =
    toDecision === edit.decision ? without : listOf(config, toDecision);
  if (target.some((r) => same(r, toRule))) return { config, skip: "exists" };
  // Keep the rule where it was in its list when only the text changes
  if (toDecision === edit.decision) {
    const at = from.findIndex((r) => same(r, rule));
    const next = [...from];
    next[at] = toRule;
    return { config: withList(config, edit.decision, next) };
  }
  const moved = withList(config, edit.decision, without);
  return { config: withList(moved, toDecision, [...target, toRule]) };
}

const OWNER: Record<string, string> = {
  "user-config": "your rule",
  floor: "a floor rule",
  folder: "a workspace rule",
  assistant: "an assistant rule",
  "permissions-yaml": "a rule in your CLI file",
  builtin: "a built-in rule",
};

function peersOf(sources: RuleSourcesInput): PeerRule[] {
  return listEffectiveRules(sources)
    .rules.filter((r: EffectiveRule) => r.state === "effective")
    .map((r) => ({
      decision: r.decision,
      raw: r.core ?? r.raw,
      owner: OWNER[r.source] ?? "another rule",
    }));
}

type FieldOf = "command" | "path" | "url" | "query";

const FIELD: Record<string, FieldOf> = {
  runTerminalCommand: "command",
  readFile: "path",
  writeFile: "path",
  listDirectory: "path",
  fetchUrl: "url",
  grepSearch: "query",
  globSearch: "query",
  searchWeb: "query",
};

/** A call a rule would match, made from its pattern, or undefined when it cannot be made. */
export function sampleCallFor(
  rule: string,
): { tool: string; field?: FieldOf; value: string } | undefined {
  const m = rule.trim().match(/^([A-Za-z_][\w.*-]*)(?:\((.*)\))?$/);
  if (!m) return undefined;
  const [, head, pattern] = m;
  if (head.startsWith("mcp__")) {
    return { tool: head.replace(/\*+/g, "x"), value: "" };
  }
  const field = FIELD[canonicalRuleName(head)];
  if (!field || pattern === undefined) return undefined;
  const value = pattern.replace(/\*+$/, "").replace(/\*+/g, "x").trim();
  if (!value) return undefined;
  return { tool: canonicalRuleName(head), field, value };
}

function verdictOf(
  tool: string,
  field: FieldOf | undefined,
  value: string,
  sources: RuleSourcesInput,
  cwd: string | undefined,
): VerdictLite | undefined {
  try {
    const r = testToolCall({
      tool,
      ...(field ? { [field]: value } : {}),
      sources,
      envNames: readUserEnvNames(),
      ...(cwd ? { cwd } : {}),
    } as never);
    const deciding = r.matchedRules.find((m) => m.deciding);
    return {
      decision: r.decision,
      source: r.source,
      ...(deciding ? { ruleSource: deciding.source } : {}),
      reason: r.reason,
    };
  } catch {
    return undefined;
  }
}

function userWith(
  sources: RuleSourcesInput,
  perms: ToolPermissions | undefined,
): RuleSourcesInput {
  return { ...sources, user: perms };
}

function computeVerdict(
  edit: ToolRuleEdit,
  after: ToolPermissions | undefined,
  deps: EditDeps,
  sources: RuleSourcesInput,
): RuleVerdict | undefined {
  const ruleText =
    (edit.op === "update" ? edit.newRule : edit.rule) ?? edit.rule;
  let sample = sampleCallFor(ruleText);
  if (edit.probe?.trim()) {
    const tool = sample?.tool ?? canonicalRuleName(ruleText.split("(")[0]);
    const field = FIELD[tool];
    if (!field && !tool.startsWith("mcp__")) return undefined;
    sample = {
      tool: tool.startsWith("mcp__") ? edit.probe.trim() : tool,
      field,
      value: edit.probe.trim(),
    };
  }
  if (!sample) return undefined;
  const before = verdictOf(
    sample.tool,
    sample.field,
    sample.value,
    sources,
    deps.cwd,
  );
  const post = verdictOf(
    sample.tool,
    sample.field,
    sample.value,
    userWith(sources, after),
    deps.cwd,
  );
  if (!before || !post) return undefined;
  return {
    probe: sample.field ? sample.value : sample.tool,
    before,
    after: post,
  };
}

interface UndoEntry {
  beforeText: string;
  afterHash: string;
  beforeHash: string | undefined;
  decision: RuleDecision;
  rule: string;
  /** Putting the file back lets something run that the change had stopped */
  loosensOnUndo: boolean;
}

/** Earlier file texts of this session, newest last, per file. */
const undoStacks = new Map<string, UndoEntry[]>();
const MAX_UNDO = 20;

/** Whether the next undo would loosen, for the host to confirm; false when there is none. */
export function undoWouldLoosen(file: string): boolean {
  const stack = undoStacks.get(file) ?? [];
  return stack[stack.length - 1]?.loosensOnUndo ?? false;
}

export function hasUndo(file: string): boolean {
  return (undoStacks.get(file)?.length ?? 0) > 0;
}

/** For tests */
export function clearUndoForTests(): void {
  undoStacks.clear();
}

function pushUndo(file: string, entry: UndoEntry): void {
  const stack = undoStacks.get(file) ?? [];
  stack.push(entry);
  while (stack.length > MAX_UNDO) stack.shift();
  undoStacks.set(file, stack);
}

/**
 * Whether undoing this change loosens: taking back an Always tightens, taking
 * back a removed Always or an added Never or Ask loosens, and a changed rule
 * is treated as loosening when unsure.
 */
function undoLoosens(edit: ToolRuleEdit): boolean {
  if (edit.op === "add" || edit.op === "adopt")
    return edit.decision !== "allow";
  if (edit.op === "remove") return edit.decision === "allow";
  return true;
}

function confirmedKind(
  analysis: RuleAnalysis,
  native?: boolean,
): "typed" | "click" | "native" | undefined {
  if (native && analysis.loosens) return "native";
  if (analysis.friction === "none") return undefined;
  return analysis.friction === "typed" ? "typed" : "click";
}

/** The adopt source: the rule must be one that is listed somewhere that cannot allow. */
function adoptSourceOf(
  sources: RuleSourcesInput,
  decision: RuleDecision,
  rule: string,
): ToolRuleEdit["from"] | undefined {
  for (const f of sources.folder ?? []) {
    if ((f.permissions[decision] ?? []).some((r) => same(r, rule))) {
      return "folder";
    }
  }
  if ((sources.assistant?.[decision] ?? []).some((r) => same(r, rule))) {
    return "assistant";
  }
  return undefined;
}

/** Why an Always rule is refused (a locked rule, protected path or built-in rule holds the calls), or undefined. */
function refusalOf(
  edit: ToolRuleEdit,
  sources: RuleSourcesInput,
  verdict: RuleVerdict | undefined,
): string | undefined {
  if (edit.op === "remove") return undefined;
  const updating = edit.op === "update";
  return refusalFor({
    decision: updating ? (edit.newDecision ?? edit.decision) : edit.decision,
    rule: updating ? (edit.newRule ?? edit.rule) : edit.rule,
    peers: peersOf(sources),
    ...(verdict ? { after: verdict.after } : {}),
  });
}

/** What the editor says about this change: validity, friction, loosening, warnings. */
function analysisOf(
  edit: ToolRuleEdit,
  sources: RuleSourcesInput,
  home: string,
): RuleAnalysis {
  const removing = edit.op === "remove";
  const updating = edit.op === "update";
  return analyzeRule({
    decision: updating ? (edit.newDecision ?? edit.decision) : edit.decision,
    rule: updating ? (edit.newRule ?? edit.rule) : edit.rule,
    removing,
    ...(updating
      ? { replaces: { decision: edit.decision, rule: edit.rule } }
      : {}),
    peers: peersOf(sources),
    home,
  });
}

/**
 * Add, update, remove or adopt one rule of the person's own config.yaml.
 * Every outcome is a named result with a sentence; a dry run writes nothing.
 */
export function editToolRule(
  edit: ToolRuleEdit,
  deps: EditDeps,
): ToolRuleEditResponse {
  const file = readUserConfigFile(deps.file);
  if (file.state === "missing") {
    return {
      result: "no-config",
      error:
        "There is no config.yaml to save rules to. Rules are saved to your own config.yaml only.",
    };
  }
  if (file.state === "broken") {
    return {
      result: "broken",
      error: `${file.error ?? "config.yaml cannot be read."} Nothing was changed. Fix the file, then try again.`,
    };
  }
  if (edit.baseHash && edit.baseHash !== file.hash) {
    return {
      result: "conflict",
      error:
        "config.yaml changed since you opened this. Reload the page, check the rule list and try again.",
      beforeHash: file.hash,
    };
  }

  const sources = deps.sources();
  const analysis = analysisOf(edit, sources, deps.home);
  if (!analysis.valid) {
    return { result: "invalid", error: analysis.error, analysis };
  }

  let from = edit.from;
  if (edit.op === "adopt") {
    from = adoptSourceOf(sources, edit.decision, edit.rule);
    if (!from) {
      return {
        result: "not-found",
        error:
          "That rule is not in an assistant or workspace file, so there is nothing to adopt.",
        analysis,
      };
    }
  }

  const textBefore = file.text ?? "";
  const applied = applyToolRuleOp(
    { toolPermissions: file.permissions } as ConfigYaml,
    edit,
  );
  if (applied.skip === "exists") {
    return {
      result: "exists",
      analysis,
      error:
        edit.op === "update"
          ? "A rule with that text is already in that list."
          : "You already have this rule.",
      beforeHash: file.hash,
    };
  }
  if (applied.skip === "not-found") {
    return {
      result: "not-found",
      error: "That rule is not in your config.yaml any more. Reload the page.",
      analysis,
      beforeHash: file.hash,
    };
  }

  // Dry run of the real edit: the same function that writes
  const dry = editYamlText<ConfigYaml>(
    textBefore,
    (c) => applyToolRuleOp(c, edit).config,
  );
  if (dry.error) {
    return {
      result: "failed",
      error: `config.yaml cannot be edited safely: ${dry.error}. Nothing was changed.`,
      analysis,
    };
  }
  const diff = lineDiff(textBefore, dry.text ?? textBefore);
  const afterPerms = applied.config.toolPermissions as
    ToolPermissions | undefined;
  const verdict = computeVerdict(edit, afterPerms, deps, sources);
  const refusal = refusalOf(edit, sources, verdict);
  if (refusal) {
    return {
      result: "refused",
      error: refusal,
      analysis,
      ...(verdict ? { verdict } : {}),
      beforeHash: file.hash,
    };
  }

  if (edit.dryRun) {
    return {
      result: "preview",
      analysis,
      diff,
      ...(verdict ? { verdict } : {}),
      beforeHash: file.hash,
      undoable: hasUndo(deps.file),
    };
  }
  if (!confirmationEnough(analysis.friction, edit.confirm)) {
    return {
      result: "needs-confirmation",
      error:
        analysis.friction === "typed"
          ? `This allows more than you may mean. Type "${CONFIRM_PHRASE}" to confirm.`
          : "This makes a rule looser. Confirm to continue.",
      analysis,
      diff,
      ...(verdict ? { verdict } : {}),
      beforeHash: file.hash,
    };
  }

  const wrote = editConfigYamlFile(
    deps.file,
    (c) => applyToolRuleOp(c, edit).config,
  );
  if (!wrote.ok) {
    return {
      result: "failed",
      error: wrote.error,
      analysis,
      beforeHash: file.hash,
    };
  }
  const written = readUserConfigFile(deps.file);
  if (written.state !== "ok") {
    return {
      result: "failed",
      error: `The file was written but cannot be read back: ${written.error ?? "it is missing"}. Use Undo or restore config.yaml.bak.`,
      analysis,
      beforeHash: file.hash,
      afterHash: written.hash,
    };
  }
  const expect = applyToolRuleOp(
    { toolPermissions: file.permissions } as ConfigYaml,
    edit,
  ).config.toolPermissions as ToolPermissions | undefined;
  for (const d of ["allow", "ask", "deny"] as const) {
    const a = JSON.stringify(written.permissions?.[d] ?? []);
    const b = JSON.stringify(expect?.[d] ?? []);
    if (a !== b) {
      return {
        result: "failed",
        error: `The rule is not in config.yaml after saving (${d} list differs). Use Undo, or restore config.yaml.bak.`,
        analysis,
        beforeHash: file.hash,
        afterHash: written.hash,
      };
    }
  }

  if (wrote.changed && written.hash) {
    pushUndo(deps.file, {
      beforeText: textBefore,
      afterHash: written.hash,
      beforeHash: file.hash,
      decision: edit.decision,
      rule: edit.rule.trim(),
      loosensOnUndo: undoLoosens(edit),
    });
  }
  const auditWritten = deps.audit
    ? deps.audit.policy({
        source: edit.source,
        op: edit.op,
        decision: edit.decision,
        rule: edit.rule.trim(),
        ...(edit.op === "update"
          ? {
              newDecision: edit.newDecision ?? edit.decision,
              newRule: (edit.newRule ?? edit.rule).trim(),
            }
          : {}),
        ...(from ? { from } : {}),
        loosens: analysis.loosens,
        ...(confirmedKind(analysis, edit.confirmedNatively)
          ? { confirmed: confirmedKind(analysis, edit.confirmedNatively) }
          : {}),
        ...(file.hash ? { beforeHash: file.hash } : {}),
        ...(written.hash ? { afterHash: written.hash } : {}),
      })
    : true;
  const result: ToolRuleEditResult =
    edit.op === "add"
      ? "added"
      : edit.op === "update"
        ? "updated"
        : edit.op === "remove"
          ? "removed"
          : "adopted";
  return {
    result,
    analysis,
    diff,
    ...(verdict ? { verdict } : {}),
    beforeHash: file.hash,
    afterHash: written.hash,
    undoable: hasUndo(deps.file),
    auditWritten,
  };
}

export type UndoResult = "undone" | "nothing-to-undo" | "conflict" | "failed";

export interface UndoResponse {
  result: UndoResult;
  error?: string;
  afterHash?: string;
  undoable?: boolean;
  auditWritten?: boolean;
}

/**
 * Put back the file as it was before the last change this session made, but
 * only if the file is still exactly what that change wrote. A file someone
 * (or a hand edit) changed since is left alone and the person is told.
 */
export function undoToolRuleChange(
  deps: Pick<EditDeps, "file" | "audit"> & { source: ChangeSource },
): UndoResponse {
  const stack = undoStacks.get(deps.file) ?? [];
  const entry = stack[stack.length - 1];
  if (!entry) {
    return { result: "nothing-to-undo", error: "There is nothing to undo." };
  }
  const now = readUserConfigFile(deps.file);
  if (now.state !== "ok" || now.hash !== entry.afterHash) {
    return {
      result: "conflict",
      error:
        "config.yaml changed after that edit, so it was not put back. Check the file and edit the rule by hand if needed.",
      undoable: true,
    };
  }
  const restored = restoreConfigFileText(deps.file, entry.beforeText);
  if (!restored.ok) {
    return { result: "failed", error: restored.error, undoable: true };
  }
  stack.pop();
  const after = readUserConfigFile(deps.file);
  const auditWritten = deps.audit
    ? deps.audit.policy({
        source: deps.source,
        op: "undo",
        decision: entry.decision,
        rule: entry.rule,
        loosens: entry.loosensOnUndo,
        ...(now.hash ? { beforeHash: now.hash } : {}),
        ...(after.hash ? { afterHash: after.hash } : {}),
      })
    : true;
  return {
    result: "undone",
    afterHash: after.hash,
    undoable: hasUndo(deps.file),
    auditWritten,
  };
}
