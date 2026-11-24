import type { TimerSettings } from "core/tools/permissions/decisionTimer";
import {
  BUILTIN_RULES,
  DEFAULT_AGENT_DECIDES,
  DEFAULT_MAX_NEW_PLAN_ITEMS,
  DEFAULT_YOU_DECIDE,
  policyLevelLabel,
  QUESTION_TYPES,
  type PolicyLevel,
  builtinIsOn,
  PRESET_FREE_RULES,
} from "core/tools/permissions/policy";
import type { PolicyExtras } from "../../redux/slices/uiSlice";

/**
 * The one line each folded group of permission settings shows while closed.
 * Each says whether the person set the value ("Set by you") or what is in
 * use when they did not ("Not set"), from the same state the controls read.
 */
export interface FoldSummary {
  text: string;
  /** Something was loosened: the header is drawn in the warning colour. */
  warning?: boolean;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Built-in rules: how many are on, and which are off. */
export function builtinRulesSummary(extras: PolicyExtras): FoldSummary {
  // The rules a preset sets; the two the person owns are named beside them
  const rules = BUILTIN_RULES.filter((r) => !PRESET_FREE_RULES.has(r.id));
  const off = rules.filter((r) => extras.builtin?.[r.id] === false);
  const total = rules.length;
  const count = `${total - off.length} of ${total} on`;
  const shell = [
    builtinIsOn(extras.builtin, "check-shell-commands")
      ? "Check shell commands: on"
      : "",
    builtinIsOn(extras.builtin, "steer-repeated-calls")
      ? ""
      : "Tell the agent when it repeats a call: off",
  ]
    .filter(Boolean)
    .map((t) => "; " + t)
    .join("");
  if (off.length > 0) {
    return {
      text: `Set by you: ${count}. Off: ${off.map((r) => r.label).join("; ")}${shell}`,
      warning: true,
    };
  }
  const written = Object.keys(extras.builtin ?? {}).length > 0;
  return {
    text: `${written ? "Set by you" : "Not set"}: ${count}${shell}`,
  };
}

/** Plans and questions: the re-plan allowance and how many question kinds stay with the person. */
export function plansAndQuestionsSummary(extras: PolicyExtras): FoldSummary {
  const items = extras.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS;
  const you = extras.questions?.youDecide ?? DEFAULT_YOU_DECIDE;
  const set =
    extras.maxNewPlanItems !== undefined ||
    extras.questions?.youDecide !== undefined ||
    extras.questions?.agentDecides !== undefined;
  return {
    text: `${set ? "Set by you" : "Not set"}: ${plural(items, "new to-do", "new to-dos")}; you decide ${you.length} of ${QUESTION_TYPES.length} kinds`,
  };
}

/** How many question kinds each side decides, for the line above the selects. */
export function whoDecidesCounts(extras: PolicyExtras): {
  you: number;
  agent: number;
  level: number;
  set: boolean;
} {
  const you = extras.questions?.youDecide ?? DEFAULT_YOU_DECIDE;
  const agent = extras.questions?.agentDecides ?? DEFAULT_AGENT_DECIDES;
  return {
    you: you.length,
    agent: agent.length,
    level: QUESTION_TYPES.filter((t) => !you.includes(t) && !agent.includes(t))
      .length,
    set:
      extras.questions?.youDecide !== undefined ||
      extras.questions?.agentDecides !== undefined,
  };
}

function windows(settings: TimerSettings | undefined): string[] {
  return Object.entries(settings ?? {})
    .filter(([, seconds]) => Number(seconds) > 0)
    .map(
      ([level, s]) =>
        `${policyLevelLabel("tools", level as PolicyLevel)} ${s} s`,
    );
}

/** Decision timer: every window that is set, or that none is. */
export function decisionTimerSummary(extras: PolicyExtras): FoldSummary {
  const asks = windows(extras.timer);
  const allowed = windows(extras.headsUp);
  if (asks.length === 0 && allowed.length === 0) {
    return { text: "Not set: off. A decision takes effect at once" };
  }
  const parts = [
    ...(asks.length ? [`asks wait ${asks.join(", ")}`] : []),
    ...(allowed.length ? [`allowed calls wait ${allowed.join(", ")}`] : []),
  ];
  return { text: `Set by you: ${parts.join("; ")}` };
}

/** The confirmation skip: the file has the line only while it is on. */
export function skipConfirmState(extras: PolicyExtras): string {
  return extras.skipPermissionConfirm === true
    ? "Set by you: on. A permission change is saved without the dialog."
    : "Not set: off, so the dialog still appears.";
}
