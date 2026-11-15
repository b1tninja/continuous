import type { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";
import type { ShellKind } from "../../util/shell";
import { canonicalRuleName } from "./names";
import { classifyReadOnly, type ReadOnlyClaim } from "./readOnlyCommand";

/**
 * Five areas, each with its own level (plans/policy-areas.md). This replaces
 * the single approval mode and Loop's autonomy levels.
 */
export type PolicyArea = "context" | "tools" | "edits" | "plan" | "questions";

export const POLICY_AREAS: readonly PolicyArea[] = [
  "context",
  "tools",
  "edits",
  "plan",
  "questions",
];

/** The top level, IDGAF, is the same on every area. */
export type PolicyLevel =
  "manual" | "cautious" | "automatic" | "permissive" | "idgaf";

export const POLICY_LEVELS: readonly PolicyLevel[] = [
  "manual",
  "cautious",
  "automatic",
  "permissive",
  "idgaf",
];

export type PolicyLevels = Record<PolicyArea, PolicyLevel>;

/**
 * Spellings that are read as a level and never written. 2.14.x called the top
 * level `yolo` (and `IDGAF` on Plan edits and Questions only).
 */
export const DEPRECATED_LEVEL_ALIASES: Readonly<Record<string, PolicyLevel>> = {
  yolo: "idgaf",
};

/** A level from stored or typed text: any case, `yolo` read as `idgaf`. */
export function parsePolicyLevel(value: unknown): PolicyLevel | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  const level = DEPRECATED_LEVEL_ALIASES[word] ?? word;
  return POLICY_LEVELS.includes(level as PolicyLevel)
    ? (level as PolicyLevel)
    : undefined;
}

/** True when the text spells a level the way 2.14.x did (`yolo`, any case). */
export function isDeprecatedLevelSpelling(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Object.hasOwn(DEPRECATED_LEVEL_ALIASES, value.trim().toLowerCase())
  );
}

/**
 * Text written by 2.14.x (an audit reason, a saved notice) with the old name
 * of the top level replaced, for display. The stored text is not changed.
 */
export function modernizeLevelText(text: string): string {
  return text.replace(/\bYOLO\b/g, "IDGAF").replace(/\byolo\b/g, "idgaf");
}

/** What a question is about. The agent names it when it asks. */
export type QuestionType =
  "scope" | "irreversible" | "security" | "cost" | "design" | "detail";

export const QUESTION_TYPES: readonly QuestionType[] = [
  "scope",
  "irreversible",
  "security",
  "cost",
  "design",
  "detail",
];

export const QUESTION_TYPE_DESCRIPTIONS: Record<QuestionType, string> = {
  scope: "What to build, add or drop",
  irreversible: "Deleting, publishing, migrating, anything hard to undo",
  security: "Credentials, permissions, exposure",
  cost: "Spending money or a large share of a budget",
  design: "Architecture, libraries, approaches",
  detail: "Naming, formatting, small defaults",
};

/** Whether work goes on while a question waits for the person. */
export type QuestionDelivery = "inbox" | "wait";

export type BuiltinRuleId =
  | "protect-secrets"
  | "protect-config"
  | "protect-network-paths"
  | "refuse-dangerous-commands"
  | "no-fetch-and-run"
  | "ask-destructive-commands"
  | "ask-large-change"
  | "ask-dependency-change"
  | "ask-unknown-host"
  | "ask-outside-paths"
  | "plan-keeps-checks";

export const BUILTIN_RULES: readonly {
  id: BuiltinRuleId;
  label: string;
  description: string;
}[] = [
  {
    id: "protect-secrets",
    label: "Ask before touching credentials",
    description:
      "Key files, tokens and credentials, for every tool and command.",
  },
  {
    id: "protect-config",
    label: "Ask before changing what runs later",
    description: "Git hooks, CI, editor tasks and shell startup files.",
  },
  {
    id: "protect-network-paths",
    label: "Ask before contacting a network path",
    description: "UNC paths, which reach another computer.",
  },
  {
    id: "refuse-dangerous-commands",
    label: "Refuse dangerous commands",
    description: "Commands the built-in safety check refuses.",
  },
  {
    id: "no-fetch-and-run",
    label: "Ask before running a download",
    description:
      "A command that runs what it downloads (`curl x | sh`). Refused at Automatic.",
  },
  {
    id: "ask-destructive-commands",
    label: "Ask before destroying work",
    description:
      "History rewrites and recursive deletes (`git reset --hard`, `git push --force`, `git clean`, `rm -rf`). Build-output folders such as node_modules are not asked about.",
  },
  {
    id: "ask-large-change",
    label: "Ask before a large change",
    description: "One edit that changes more than 300 lines.",
  },
  {
    id: "ask-dependency-change",
    label: "Ask before changing dependencies",
    description:
      "Edits to manifests, lockfiles and registry settings, and commands that add, update or remove a package. Installing what the lockfile names does not ask.",
  },
  {
    id: "ask-unknown-host",
    label: "Ask before contacting an unlisted host",
    description:
      "When you list trusted domains in your own config, a fetch or network command to any other host asks.",
  },
  {
    id: "ask-outside-paths",
    label: "Ask before a file tool leaves the workspace",
    description:
      "A read, listing or write of a real path outside the workspace folders: an absolute path elsewhere, a `..` climb, a symlink or junction that leaves, another account's home. Device paths, alternate data streams and your global configuration folder ask whatever this says.",
  },
  {
    id: "plan-keeps-checks",
    label: "Stop a re-plan that weakens a check",
    description:
      "A re-plan that changes a failing check or drops a finished item waits for you.",
  },
];

/**
 * Rules that cannot be switched off by config or by a level below IDGAF. They
 * are listed beside the built-in rules, without a switch. IDGAF runs past
 * them and records it (evaluate.ts, idgafRunsEverything).
 */
export const LOCKED_FLOOR_RULES: readonly {
  id: "protect-policy-files";
  label: string;
  description: string;
}[] = [
  {
    id: "protect-policy-files",
    label: "Never change the permission files",
    description:
      "Every file the product loads as config, code, rules or hooks: the global folder, a project's .continue and .continuous folders, .claude settings, agents and skills, and .continuerc. A write or delete that names the path asks, and is refused at Automatic. At IDGAF it runs, and the decision records that this rule would have refused it. A sandbox that denies writes to these folders is what holds for certain.",
  },
];

export interface PolicySettings {
  levels: PolicyLevels;
  /** Permissive on Plan edits: new to-dos a re-plan may add by itself. */
  maxNewPlanItems?: number;
  questions?: {
    delivery?: QuestionDelivery;
    /** Types the person always decides. */
    youDecide?: QuestionType[];
    /** Types the agent may decide. */
    agentDecides?: QuestionType[];
  };
  /** Built-in rules by id. Absent means on. */
  builtin?: Partial<Record<BuiltinRuleId, boolean>>;
}

export const DEFAULT_MAX_NEW_PLAN_ITEMS = 5;
export const DEFAULT_YOU_DECIDE: readonly QuestionType[] = [
  "scope",
  "irreversible",
  "security",
  "cost",
];
export const DEFAULT_AGENT_DECIDES: readonly QuestionType[] = ["detail"];

export const DEFAULT_POLICY_LEVELS: PolicyLevels = {
  context: "permissive",
  tools: "cautious",
  edits: "manual",
  plan: "cautious",
  questions: "cautious",
};

export type PolicyPresetName =
  "careful" | "acceptEdits" | "handsOff" | "reviewer" | "idgaf";

export const POLICY_PRESETS: Record<
  PolicyPresetName,
  { label: string; description: string; levels: PolicyLevels }
> = {
  careful: {
    label: "Careful",
    description: "Reads freely, asks for commands, you review edits.",
    levels: DEFAULT_POLICY_LEVELS,
  },
  acceptEdits: {
    label: "Accept edits",
    description: "Like Careful, and edits are accepted unless denied.",
    levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
  },
  handsOff: {
    label: "Hands off",
    description:
      "Runs everything your rules do not stop. The agent makes the small calls.",
    levels: {
      context: "permissive",
      tools: "permissive",
      edits: "permissive",
      plan: "permissive",
      questions: "permissive",
    },
  },
  reviewer: {
    label: "Reviewer",
    description: "A reviewer model decides what your rules leave open.",
    levels: {
      context: "automatic",
      tools: "automatic",
      edits: "automatic",
      plan: "automatic",
      questions: "automatic",
    },
  },
  idgaf: {
    label: "IDGAF",
    description: "Everything runs and nothing asks. Every rule is ignored.",
    levels: {
      context: "idgaf",
      tools: "idgaf",
      edits: "idgaf",
      plan: "idgaf",
      questions: "idgaf",
    },
  },
};

export const POLICY_PRESET_ORDER = Object.keys(
  POLICY_PRESETS,
) as PolicyPresetName[];

export function presetOf(levels: PolicyLevels): PolicyPresetName | undefined {
  return POLICY_PRESET_ORDER.find((name) =>
    POLICY_AREAS.every((a) => POLICY_PRESETS[name].levels[a] === levels[a]),
  );
}

export const POLICY_AREA_LABELS: Record<PolicyArea, string> = {
  context: "Context use",
  tools: "Tool use",
  edits: "File edits",
  plan: "Plan edits",
  questions: "Questions",
};

export function policyLevelLabel(area: PolicyArea, level: PolicyLevel): string {
  if (level === "idgaf") return "IDGAF";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** One line per level for the dropdown; the tooltip uses the same sentence. */
export const POLICY_LEVEL_DESCRIPTIONS: Record<
  PolicyArea,
  Record<PolicyLevel, string>
> = {
  context: {
    manual: "Asks before each read.",
    cautious:
      "Reads what your Always rules and tool settings cover, asks otherwise.",
    automatic: "As Cautious, and a reviewer model decides what is left.",
    permissive: "Reads anything no rule stops.",
    idgaf: "Reads anything. Every rule is ignored.",
  },
  tools: {
    manual: "Asks before each command and tool.",
    cautious:
      "Runs what your Always rules and tool settings cover, asks otherwise.",
    automatic: "As Cautious, and a reviewer model decides what is left.",
    permissive: "Runs anything no rule stops.",
    idgaf: "Runs anything. Every rule is ignored.",
  },
  edits: {
    manual: "You review each diff.",
    cautious: "Accepts what your Always rules cover, you review the rest.",
    automatic: "A reviewer model accepts, refuses or sends it to you.",
    permissive: "Accepts anything no rule stops.",
    idgaf: "Accepts everything. Every rule is ignored.",
  },
  plan: {
    manual: "In Loop, every plan and re-plan waits for you.",
    cautious: "In Loop, re-plans that add no to-do go on. A first plan waits.",
    automatic:
      "In Loop, a reviewer model judges each plan and waits if unsure.",
    permissive: "In Loop, plans go on. A re-plan may add a few to-dos.",
    idgaf: "In Loop, every plan goes on. Nothing is checked.",
  },
  questions: {
    manual: "You decide every question.",
    cautious: "You decide, except types a rule gives the agent.",
    automatic: "A second model decides, or sends it to you if unsure.",
    permissive: "The agent decides, except types a rule gives you.",
    idgaf: "The agent decides everything and never asks.",
  },
};

function questionTypes(value: unknown): QuestionType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is QuestionType =>
    QUESTION_TYPES.includes(v as QuestionType),
  );
}

export interface NormalizedPolicy {
  policy: PolicySettings;
  /** Each value that could not be used, for a notice. */
  problems: string[];
}

/**
 * Saved or written settings made safe to use. An unknown level falls back to
 * that area's default and is reported, so nothing silently does nothing.
 */
export function normalizePolicy(raw: unknown): NormalizedPolicy {
  const input = (raw ?? {}) as Partial<PolicySettings>;
  const given = (input.levels ?? {}) as Partial<Record<string, unknown>>;
  const problems: string[] = [];
  const levels = { ...DEFAULT_POLICY_LEVELS };
  for (const area of POLICY_AREAS) {
    const value = given[area];
    if (value === undefined) continue;
    const level = parsePolicyLevel(value);
    if (level) levels[area] = level;
    else problems.push(`${area}: "${String(value)}" is not a level`);
  }
  const delivery = input.questions?.delivery;
  if (delivery !== undefined && delivery !== "inbox" && delivery !== "wait") {
    problems.push(`questions.delivery: "${String(delivery)}" is not valid`);
  }
  const youDecide = questionTypes(input.questions?.youDecide);
  const agentDecides = questionTypes(input.questions?.agentDecides);
  return {
    policy: {
      levels,
      ...(typeof input.maxNewPlanItems === "number" &&
      input.maxNewPlanItems >= 0
        ? { maxNewPlanItems: input.maxNewPlanItems }
        : {}),
      questions: {
        delivery: delivery === "wait" ? "wait" : "inbox",
        ...(youDecide ? { youDecide } : {}),
        ...(agentDecides ? { agentDecides } : {}),
      },
      ...(input.builtin ? { builtin: input.builtin } : {}),
    },
    problems,
  };
}

export function builtinRuleOn(
  policy: PolicySettings | undefined,
  id: BuiltinRuleId,
): boolean {
  return policy?.builtin?.[id] !== false;
}

/** Automatic needs a reviewer: without one, Cautious, so nothing loosens. */
export function withoutReviewer(policy: PolicySettings): PolicySettings {
  const levels = { ...policy.levels };
  for (const area of POLICY_AREAS) {
    if (levels[area] === "automatic") levels[area] = "cautious";
  }
  return { ...policy, levels };
}

/** The old saved settings (one approval mode and its switches). */
export interface LegacyApproval {
  mode?: string;
  categories?: {
    readFiles?: boolean;
    editFiles?: boolean;
    runAllCommands?: boolean;
  };
  /** A per-tool setting lets an edit tool run without asking. */
  editToolAutoAccepted?: boolean;
}

/** Equal or stricter than what was saved, never looser. */
export function migrateApproval(old: LegacyApproval): PolicyLevels {
  const levels = { ...DEFAULT_POLICY_LEVELS };
  if (old.editToolAutoAccepted) levels.edits = "cautious";
  switch (old.mode) {
    case "autoApprove":
      if (old.categories?.readFiles) levels.context = "permissive";
      if (old.categories?.editFiles) levels.edits = "permissive";
      if (old.categories?.runAllCommands) levels.tools = "permissive";
      break;
    case "auto":
      levels.tools = "automatic";
      levels.context = "automatic";
      break;
    // A saved "yolo" is from 2.4.4, where it still honoured deny rules and
    // protected paths: carrying it over as today's IDGAF would loosen it
    case "review":
    case "yolo":
      levels.tools = "permissive";
      levels.context = "permissive";
      break;
  }
  return levels;
}

const SESSION_TOOLS = new Set<string>([
  BuiltInToolNames.TaskList,
  BuiltInToolNames.PresentPlan,
  BuiltInToolNames.HoldQuestion,
  BuiltInToolNames.FinishItem,
  BuiltInToolNames.RemindMe,
  // The CLI's names
  "TaskList",
  "Checklist",
  "PresentPlan",
  "HoldQuestion",
  "FinishItem",
  "RemindMe",
  "AskQuestion",
  "Status",
  "Exit",
  "ReportFailure",
  "UploadArtifact",
  "CheckBackgroundJob",
]);

const EDIT_RULE_NAMES = new Set<string>([
  "writeFile",
  "Edit",
  "MultiEdit",
  "Write",
]);
/** Web tools can send data out, so they are never just context. */
const WEB_RULE_NAMES = new Set<string>(["fetchUrl", "searchWeb", "Fetch"]);
/**
 * A message to another agent changes what that agent does, so it is a Tools
 * call: Careful asks, Permissive and IDGAF run it. The receiver's own calls
 * are still checked against the person's policies, so a message cannot raise
 * what another agent may do.
 */
const MESSAGE_RULE_NAMES = new Set<string>([BuiltInToolNames.SendMessage]);
const CONTEXT_RULE_NAMES = new Set<string>([
  // Lists the agents of this session: names, tasks and states, nothing else
  BuiltInToolNames.ListSessions,
  "readFile",
  "listDirectory",
  "grepSearch",
  "globSearch",
  BuiltInToolNames.ViewDiff,
  BuiltInToolNames.CodebaseTool,
  BuiltInToolNames.ViewRepoMap,
  BuiltInToolNames.ReadSkill,
  "Read",
  "List",
  "Search",
  "Diff",
  "Skills",
]);

/**
 * Which area governs a tool call. Undefined for tools that only touch the
 * session (the task list, Loop's tools): those are never asked about.
 */
export function areaOfTool(
  toolName: string,
  tool?: Pick<Tool, "readonly"> | undefined,
  /** The call's arguments: a command that only reads is Context use */
  call?: {
    parsedArgs?: Record<string, unknown>;
    cwd?: string;
    shell?: ShellKind;
  },
): "context" | "tools" | "edits" | undefined {
  if (SESSION_TOOLS.has(toolName)) return undefined;
  const name = canonicalRuleName(toolName);
  if (name === "runTerminalCommand" && readOnlyClaim(call)?.vouched) {
    return "context";
  }
  if (EDIT_RULE_NAMES.has(name)) return "edits";
  if (WEB_RULE_NAMES.has(name)) return "tools";
  if (MESSAGE_RULE_NAMES.has(name)) return "tools";
  if (CONTEXT_RULE_NAMES.has(name)) return "context";
  return tool?.readonly ? "context" : "tools";
}

/**
 * What the parser says about a terminal command: vouched read-only, or why
 * not. Undefined when the call has no command.
 */
export function readOnlyClaim(
  call:
    | {
        parsedArgs?: Record<string, unknown>;
        cwd?: string;
        shell?: ShellKind;
      }
    | undefined,
): ReadOnlyClaim | undefined {
  const command = call?.parsedArgs?.command;
  if (typeof command !== "string") return undefined;
  return classifyReadOnly(command, { cwd: call?.cwd, shell: call?.shell });
}

export type QuestionDecider = "person" | "agent" | "reviewer";

/** Who decides a question. A missing or unknown type goes to the person. */
export function questionDecider(
  policy: PolicySettings,
  type: unknown,
): QuestionDecider {
  const level = policy.levels.questions;
  if (level === "idgaf") return "agent";
  if (level === "manual") return "person";
  const known = QUESTION_TYPES.includes(type as QuestionType)
    ? (type as QuestionType)
    : undefined;
  if (level === "automatic" || level === "permissive") {
    // The person opted out of being asked: the agent's choice stands, whatever
    // the question's type. Only a type the person put on their own "you
    // decide" list (not the default list) still reaches them.
    return known && policy.questions?.youDecide?.includes(known)
      ? "person"
      : "agent";
  }
  if (!known) return "person";
  if ((policy.questions?.youDecide ?? DEFAULT_YOU_DECIDE).includes(known)) {
    return "person";
  }
  return (policy.questions?.agentDecides ?? DEFAULT_AGENT_DECIDES).includes(
    known,
  )
    ? "agent"
    : "person";
}

export function questionDelivery(
  policy: PolicySettings | undefined,
): QuestionDelivery {
  return policy?.questions?.delivery ?? "inbox";
}

export interface PlanHandoffInput {
  policy: PolicySettings;
  /** The first plan of a run: every to-do is new, and N does not apply. */
  first: boolean;
  /** To-dos not in the list before. */
  added: number;
  /** What a re-plan weakened (see replanConcern). */
  concern?: string;
}

export interface PlanHandoff {
  /** go: on to acting. wait: for the person. review: ask the reviewer model. */
  decision: "go" | "wait" | "review";
  reason: string;
}

const count = (n: number) => `${n} new to-do${n === 1 ? "" : "s"}`;

/**
 * The one check between a plan turn and the act turn after it. Plan and Agent
 * never get here: Plan has no act turn after it, Agent no plan turn before it.
 */
export function planHandoff(input: PlanHandoffInput): PlanHandoff {
  const { policy, first, added, concern } = input;
  const level = policy.levels.plan;
  if (level === "idgaf") {
    return { decision: "go", reason: "Plan edits is set to IDGAF." };
  }
  switch (level) {
    case "manual":
      return concern && builtinRuleOn(policy, "plan-keeps-checks")
        ? { decision: "wait", reason: concern }
        : { decision: "wait", reason: "Every plan waits for you." };
    case "cautious":
      if (concern && builtinRuleOn(policy, "plan-keeps-checks")) {
        return { decision: "wait", reason: concern };
      }
      return added === 0 && !first
        ? { decision: "go", reason: "The re-plan adds no new to-dos." }
        : {
            decision: "wait",
            reason: first
              ? "The first plan waits for you."
              : `The re-plan adds ${count(added)}.`,
          };
    case "automatic":
    case "permissive": {
      // The person opted out of plan cards: a re-plan goes on, even one that
      // changed a check (the loop's notice says so). A reviewer model for
      // plans is not built, so Automatic goes on without a cap. At Permissive
      // only the cap on new to-dos (the Plan edits setting) holds one back.
      const name = policyLevelLabel("plan", level);
      if (first) return { decision: "go", reason: `Plan edits is ${name}.` };
      const max =
        level === "permissive"
          ? (policy.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS)
          : undefined;
      return max !== undefined && added > max
        ? {
            decision: "wait",
            reason: `The re-plan adds ${count(added)}, more than ${max}.`,
          }
        : {
            decision: "go",
            reason: `Plan edits is ${name}: the re-plan goes on.`,
          };
    }
  }
}

/**
 * The Questions levels at which nobody is asked: an answer is chosen for the
 * agent (see core/util/autoAnswer.ts). The loop's own gates use this one test.
 */
export function questionsAutoAnswer(level: PolicyLevel): boolean {
  return level === "automatic" || level === "permissive" || level === "idgaf";
}

/**
 * Questions is IDGAF (a saved `yolo`, its old name, reads as IDGAF): nothing asks, in a loop or outside one, on any
 * surface. The person's own "you decide" list does not apply, and a question
 * is answered for the agent (core/util/autoAnswer.ts) rather than shown.
 */
export function questionsNeverAsk(level: PolicyLevel | undefined): boolean {
  return typeof level === "string" && parsePolicyLevel(level) === "idgaf";
}
