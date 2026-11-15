import type { EffectiveRule } from "core/tools/permissions/effectiveRules";
import {
  ownRuleLists,
  planRuleChanges,
  type PlannedRuleChange,
} from "core/tools/permissions/customPolicy";
import {
  BUILTIN_RULES,
  DEFAULT_AGENT_DECIDES,
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  DEFAULT_YOU_DECIDE,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_LEVELS,
  POLICY_PRESETS,
  policyLevelLabel,
  presetOf,
  type BuiltinRuleId,
  type PolicyLevels,
  type PolicyPresetName,
  type QuestionType,
} from "core/tools/permissions/policy";
import type { RuleDecision } from "core/tools/permissions/rules";
import type { StoredCustomSet } from "core/tools/permissions/settingsFile";
import type { PolicyExtras } from "../../../../../redux/slices/uiSlice";

/** The four lists the editor shows: three in config.yaml, the floor in permissions.yaml. */
export type ListKey = RuleDecision | "floor";

export const EDITABLE_LISTS: readonly ListKey[] = [
  "deny",
  "ask",
  "allow",
  "floor",
];

export type EditableLists = Record<ListKey, string[]>;

export const LIST_NAMES: Record<ListKey, string> = {
  deny: "Never",
  ask: "Ask",
  allow: "Always",
  floor: "Always-on Never",
};

export const LIST_HINTS: Record<ListKey, string> = {
  deny: "Refused. Saved in your config.yaml. At IDGAF the call runs and the audit trail records the rule.",
  ask: "Asks you first. Saved in your config.yaml. At IDGAF the call runs and the audit trail records the rule.",
  allow:
    "Runs without asking where the level consults rules. Saved in your config.yaml; only your own file may allow.",
  floor:
    "Refused at every level below IDGAF (floor: in permissions.yaml). At IDGAF the call runs and the audit trail records the rule.",
};

export const decisionOfList = (key: ListKey): RuleDecision =>
  key === "floor" ? "deny" : key;

export type BaseName = PolicyPresetName | "current";

/** Everything the editor changes, before it is saved. */
export interface CustomDraft {
  base: BaseName;
  levels: PolicyLevels;
  builtin: Partial<Record<BuiltinRuleId, boolean>>;
  maxNewPlanItems: number;
  youDecide: QuestionType[];
  agentDecides: QuestionType[];
  questionDelivery: "inbox" | "wait";
  lists: EditableLists;
  trustedMcpServers: string[];
  planMcpTools: string[];
  planAllowTerminal: boolean;
}

export function levelsOfBase(base: BaseName, current: PolicyLevels) {
  return base === "current"
    ? { ...current }
    : { ...POLICY_PRESETS[base].levels };
}

/** The editor's starting point: the base's levels, everything else as it is now. */
export function initialDraft(
  base: BaseName,
  current: PolicyLevels,
  extras: PolicyExtras,
  rules: readonly EffectiveRule[],
): CustomDraft {
  const own = ownRuleLists(rules);
  return {
    base,
    levels: levelsOfBase(base, current),
    builtin: { ...(extras.builtin ?? {}) },
    maxNewPlanItems: extras.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS,
    youDecide: [...(extras.questions?.youDecide ?? DEFAULT_YOU_DECIDE)],
    agentDecides: [
      ...(extras.questions?.agentDecides ?? DEFAULT_AGENT_DECIDES),
    ],
    questionDelivery: extras.questionDelivery ?? "inbox",
    lists: { ...own, floor: [...(extras.floor ?? [])] },
    trustedMcpServers: [...(extras.trustedMcpServers ?? [])],
    planMcpTools: [...(extras.planMcpTools ?? [])],
    planAllowTerminal: extras.planAllowTerminal ?? false,
  };
}

export interface SettingChange {
  /** The key in permissions.yaml */
  key: string;
  before: string;
  after: string;
  /** Saving this lets something through that was stopped, or trusts more */
  loosens: boolean;
}

const list = (items: readonly string[]) =>
  items.length ? items.join(", ") : "none";
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** What the save changes in permissions.yaml, key by key, in words. */
export function settingChanges(
  from: CustomDraft,
  to: CustomDraft,
): SettingChange[] {
  const out: SettingChange[] = [];
  for (const area of POLICY_AREAS) {
    const a = from.levels[area];
    const b = to.levels[area];
    if (a === b) continue;
    out.push({
      key: `levels.${area} (${POLICY_AREA_LABELS[area]})`,
      before: policyLevelLabel(area, a),
      after:
        b === "idgaf"
          ? "IDGAF, for this session only (never saved)"
          : policyLevelLabel(area, b),
      loosens: POLICY_LEVELS.indexOf(b) > POLICY_LEVELS.indexOf(a),
    });
  }
  for (const rule of BUILTIN_RULES) {
    const a = from.builtin[rule.id] !== false;
    const b = to.builtin[rule.id] !== false;
    if (a === b) continue;
    out.push({
      key: `builtin.${rule.id}`,
      before: a ? "on" : "off",
      after: b ? "on" : "off",
      loosens: a && !b,
    });
  }
  if (from.maxNewPlanItems !== to.maxNewPlanItems) {
    out.push({
      key: "plan.maxNewItems",
      before: String(from.maxNewPlanItems),
      after: String(to.maxNewPlanItems),
      loosens: to.maxNewPlanItems > from.maxNewPlanItems,
    });
  }
  if (!sameSet(from.youDecide, to.youDecide)) {
    out.push({
      key: "questions.youDecide",
      before: list(from.youDecide),
      after: list(to.youDecide),
      loosens: from.youDecide.some((t) => !to.youDecide.includes(t)),
    });
  }
  if (!sameSet(from.agentDecides, to.agentDecides)) {
    out.push({
      key: "questions.agentDecides",
      before: list(from.agentDecides),
      after: list(to.agentDecides),
      loosens: to.agentDecides.some((t) => !from.agentDecides.includes(t)),
    });
  }
  if (from.questionDelivery !== to.questionDelivery) {
    out.push({
      key: "questions.delivery",
      before: from.questionDelivery,
      after: to.questionDelivery,
      loosens: false,
    });
  }
  if (!sameSet(from.lists.floor, to.lists.floor)) {
    out.push({
      key: "floor",
      before: list(from.lists.floor),
      after: list(to.lists.floor),
      loosens: from.lists.floor.some((r) => !to.lists.floor.includes(r)),
    });
  }
  if (!sameSet(from.trustedMcpServers, to.trustedMcpServers)) {
    out.push({
      key: "mcpServers (trusted)",
      before: list(from.trustedMcpServers),
      after: list(to.trustedMcpServers),
      loosens: to.trustedMcpServers.some(
        (s) => !from.trustedMcpServers.includes(s),
      ),
    });
  }
  if (!sameSet(from.planMcpTools, to.planMcpTools)) {
    out.push({
      key: "plan.mcpTools",
      before: list(from.planMcpTools),
      after: list(to.planMcpTools),
      loosens: to.planMcpTools.some((t) => !from.planMcpTools.includes(t)),
    });
  }
  if (from.planAllowTerminal !== to.planAllowTerminal) {
    out.push({
      key: "plan.allowTerminal",
      before: from.planAllowTerminal ? "on" : "off",
      after: to.planAllowTerminal ? "on" : "off",
      loosens: to.planAllowTerminal,
    });
  }
  return out;
}

/**
 * The custom set to keep at `levels.custom` when this draft is saved, or
 * undefined to leave the file's as it is: a draft at a preset's levels is
 * that preset (and the old set stays recallable), and a set with IDGAF in it
 * or one started from IDGAF is for this session only (owner decision O2).
 * `from` is the preset it started from; from "what is set now", the preset
 * those levels matched, or the stored set's own `from` when they were it.
 */
export function customSetToStore(
  draft: Pick<CustomDraft, "base" | "levels">,
  current: PolicyLevels,
  stored: StoredCustomSet | undefined,
): StoredCustomSet | undefined {
  const { base, levels } = draft;
  if (presetOf(levels)) return undefined;
  if (base === "idgaf" || POLICY_AREAS.some((a) => levels[a] === "idgaf")) {
    return undefined;
  }
  let from: StoredCustomSet["from"];
  if (base !== "current") from = base;
  else {
    const was = presetOf(current);
    if (was && was !== "idgaf") from = was;
    else if (
      stored &&
      POLICY_AREAS.every((a) => stored.levels[a] === current[a])
    ) {
      from = stored.from;
    }
  }
  return { ...(from ? { from } : {}), levels: { ...levels } };
}

/** The config.yaml edits, one checked change at a time (the rule editor's own). */
export function ruleChanges(
  from: CustomDraft,
  to: CustomDraft,
): PlannedRuleChange[] {
  const { floor: _a, ...before } = from.lists;
  const { floor: _b, ...after } = to.lists;
  return planRuleChanges(before, after);
}

/** "Add to Never: x", "Move x from Ask to Never", "Remove x from Always". */
export function describeRuleChange(c: PlannedRuleChange): string {
  if (c.op === "add") return `Add to ${LIST_NAMES[c.decision]}: ${c.rule}`;
  if (c.op === "remove") {
    return `Remove from ${LIST_NAMES[c.decision]}: ${c.rule}`;
  }
  return `Move from ${LIST_NAMES[c.decision]} to ${LIST_NAMES[c.newDecision]}: ${c.rule}`;
}
