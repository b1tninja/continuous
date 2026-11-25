import type { Tool } from "../..";
import { BuiltInToolNames } from "../builtIn";
import type { ShellKind } from "../../util/shell";
import { canonicalRuleName } from "./names";
import { classifyReadOnly, type ReadOnlyClaim } from "./readOnlyCommand";
import {
  isRetiredTopLevel,
  parsePolicyLevel,
  POLICY_LEVELS,
  type PolicyLevel,
} from "./levelText";

export {
  DEPRECATED_LEVEL_ALIASES,
  isDeprecatedLevelSpelling,
  isRetiredTopLevel,
  levelRank,
  modernizeLevelText,
  parsePolicyLevel,
  POLICY_LEVELS,
} from "./levelText";
export type { PolicyLevel } from "./levelText";

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

/**
 * The Web area's levels (plans/research/web-fetch-large-pages-and-policy.md,
 * section 8.2): the five shared levels plus two that exist for Web only.
 * `off` offers no agent web tool; `listed` runs allowed domains and refuses
 * the rest without asking.
 */
/** Web has no `delegate`: that is a Questions level. */
export type WebLevel = Exclude<PolicyLevel, "delegate"> | "off" | "listed";

/** Top to bottom by how few decisions reach you, as the dropdown lists them; Off is set apart. */
export const WEB_LEVELS: readonly WebLevel[] = [
  "manual",
  "cautious",
  "listed",
  "automatic",
  "permissive",
  "off",
];

/**
 * The level of each area. `web` is the sixth area and is optional: absent, it
 * follows Tool use (core/tools/permissions/webPolicy.ts, effectiveWebLevel),
 * so no setting saved before it existed changes meaning.
 */
export type PolicyLevels = Record<PolicyArea, PolicyLevel> & {
  web?: WebLevel;
};

/** The levels an area offers: `delegate` is Questions' alone. */
export function levelsOfArea(area: PolicyArea): readonly PolicyLevel[] {
  return area === "questions"
    ? POLICY_LEVELS
    : POLICY_LEVELS.filter((l) => l !== "delegate");
}

/** A Web level from stored or typed text: any case, `yolo` read as `idgaf`. */
export function parseWebLevel(value: unknown): WebLevel | undefined {
  if (typeof value !== "string") return undefined;
  const word = value.trim().toLowerCase();
  if (word === "off" || word === "listed") return word;
  const level = parsePolicyLevel(word);
  return level === "delegate" ? undefined : level;
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
  | "check-shell-commands"
  | "steer-repeated-calls"
  | "plan-keeps-checks"
  | "apply-rules"
  | "protect-policy-files"
  | "hold-plan-mode"
  | "ask-odd-paths"
  | "refuse-unsafe-urls"
  | "approve-mcp-tools"
  | "ask-runtime-writes";

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
      "Asks before history rewrites and recursive deletes (`git reset --hard`, `git push --force`, `git clean`, `rm -rf`). Build-output folders such as node_modules are not asked about. Turning this off is a loosening. An Always rule for one exact command exempts that command.",
  },
  {
    id: "ask-large-change",
    label: "Ask before a large change",
    description:
      "Asks before one edit that changes more than 300 lines. Turning this off is a loosening.",
  },
  {
    id: "ask-dependency-change",
    label: "Ask before changing dependencies",
    description:
      "Asks before edits to manifests, lockfiles and registry settings, and commands that add, update or remove a package. Installing what the lockfile names does not ask. Turning this off is a loosening. An Always rule for one exact command exempts that command.",
  },
  {
    id: "ask-unknown-host",
    label: "Ask before contacting an unlisted host",
    description:
      "Asks before a fetch or network command to a host outside the trusted domains you list in your own config. Turning this off is a loosening.",
  },
  {
    id: "ask-outside-paths",
    label: "Ask before a file tool leaves the workspace",
    description:
      "A read, listing or write of a real path outside the workspace folders: an absolute path elsewhere, a `..` climb, a symlink or junction that leaves, another account's home. Device paths, alternate data streams and your global configuration folder ask whatever this says.",
  },
  {
    id: "check-shell-commands",
    label: "Check shell commands before running them",
    description:
      "Off unless you turn it on. On, it stops a command the shell would reject before it runs: bash in PowerShell (`export`, heredocs, `&&` in Windows PowerShell 5.1), PowerShell in bash, an inline script that quoting breaks, and a program that is not installed. Off, the command runs as written and the shell reports any error.",
  },
  {
    id: "steer-repeated-calls",
    label: "Tell the agent when it repeats a call",
    description:
      "When the agent sends the same command again and again (or a small rewrite of one that was refused), the result says so and suggests another approach. Nothing is stopped. On unless you turn it off.",
  },
  {
    id: "plan-keeps-checks",
    label: "Hold a re-plan that weakens a check or adds many to-dos",
    description:
      "In Loop, a re-plan that adds more new to-dos than the Plan edits limit waits for you, and at Cautious so does one that changes a failing check or drops a finished item. Off, no re-plan waits for either.",
  },
  {
    id: "apply-rules",
    label: "Apply my deny, ask and floor rules",
    description:
      "Your Never, Ask and floor rules decide a call, at every level. Off, they are not read. Always rules still work.",
  },
  {
    id: "protect-policy-files",
    label: "Never change the permission files",
    description:
      "Every file the product loads as config, code, rules or hooks: the global folder, a project's .continue and .continuous folders, .claude settings, agents and skills, and .continuerc. A write or delete that names the path asks, and is refused at Automatic. A command that writes to a path built when it runs asks too. Off, none of that is checked.",
  },
  {
    id: "hold-plan-mode",
    label: "Hold changes in Plan mode",
    description:
      "In a Plan turn a call that would change files or state waits for you unless it only reads. Off, Plan mode holds nothing.",
  },
  {
    id: "ask-odd-paths",
    label: "Ask before an oddly spelled file name",
    description:
      "A file named in a way that is not the file it looks like: a Windows device name (NUL, COM1), an alternate data stream (a.txt:x), a trailing dot or space, or an 8.3 short name (JUSTIN~1, PROGRA~1). Off, the call is judged by the folder it reaches, as any other path.",
  },
  {
    id: "refuse-unsafe-urls",
    label: "Refuse unsafe fetch targets",
    description:
      "A fetch of a URL that carries a login or a credential, points at a cloud metadata address, or uses a scheme other than http and https. Off, the fetch goes ahead and only the other web checks decide.",
  },
  {
    id: "approve-mcp-tools",
    label: "Ask before using an MCP tool you have not approved",
    description:
      "A tool of an MCP server you have not approved, or whose definition changed since you did, waits for your approval before it is offered to the model or run. Off, it is offered and runs like any other tool.",
  },
  {
    id: "ask-runtime-writes",
    label: "Ask before a command writes to a path built when it runs",
    description:
      "Off unless you turn it on. On, a command that writes or deletes at a path only known when it runs (`$dir`, a wildcard, a path after `cd` into the home folder) asks, because the path guards cannot read it. Off, it runs as the level allows.",
  },
];

/**
 * Rules with no switch. None remain: the permission-file lock is the
 * `protect-policy-files` switch, so no level and no preset can override a
 * choice the person made on a switch. Kept so callers that list them compile.
 */
export const LOCKED_FLOOR_RULES: readonly {
  id: string;
  label: string;
  description: string;
}[] = [];

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
  {
    label: string;
    description: string;
    levels: PolicyLevels;
    /** How many safety checks the preset leaves on (core/tools/permissions/safetyDegrees.ts) */
    safety: "all" | "some" | "few" | "none";
  }
> = {
  careful: {
    label: "Careful",
    description: "Reads freely, asks for commands, you review edits.",
    safety: "all",
    levels: DEFAULT_POLICY_LEVELS,
  },
  acceptEdits: {
    label: "Accept edits",
    description: "Like Careful, and edits are accepted unless denied.",
    safety: "all",
    levels: { ...DEFAULT_POLICY_LEVELS, edits: "permissive" },
  },
  handsOff: {
    label: "Hands off",
    description:
      "Runs everything your rules do not stop. The agent makes the small calls.",
    safety: "few",
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
    description: "A reviewer model decides what your rules do not decide.",
    safety: "some",
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
    description:
      "Everything runs, nothing asks and no safety check is on. Turn checks back on one by one if you want them.",
    safety: "none",
    levels: {
      context: "permissive",
      tools: "permissive",
      edits: "permissive",
      plan: "permissive",
      // Not a safety check: delegating every decision is Delegate, never part of IDGAF
      questions: DEFAULT_POLICY_LEVELS.questions,
    },
  },
};

export const POLICY_PRESET_ORDER = Object.keys(
  POLICY_PRESETS,
) as PolicyPresetName[];

/**
 * The Web level each preset sets. Every preset's Web level is its Tool use
 * level, so a preset applied as its five levels (Web absent, following Tool
 * use) means the same; `parsePolicySpec` and the GUI may also write it. No
 * preset sets Off or Listed.
 */
export const POLICY_PRESET_WEB: Record<PolicyPresetName, WebLevel> = {
  careful: "cautious",
  acceptEdits: "cautious",
  handsOff: "permissive",
  reviewer: "automatic",
  idgaf: "permissive",
};

/**
 * The preset the levels are, or undefined (Custom). An absent `web` matches,
 * since it follows Tool use; Off or Listed on Web makes it Custom.
 *
 * IDGAF is Permissive with no safety check on, so given the switches it is
 * the preset only while none is on: turn one back on and it is Custom.
 */
export function presetOf(
  levels: PolicyLevels,
  builtin?: Partial<Record<BuiltinRuleId, boolean>>,
): PolicyPresetName | undefined {
  const matches = POLICY_PRESET_ORDER.filter(
    (name) =>
      POLICY_AREAS.every((a) => POLICY_PRESETS[name].levels[a] === levels[a]) &&
      (levels.web === undefined || levels.web === POLICY_PRESET_WEB[name]),
  );
  const name = matches[0];
  if (
    name &&
    builtin !== undefined &&
    POLICY_PRESETS[name].safety === "none" &&
    !noCheckIsOn(builtin)
  ) {
    return undefined;
  }
  return name;
}

/** True when every check a preset sets is switched off in `builtin`. */
function noCheckIsOn(
  builtin: Partial<Record<BuiltinRuleId, boolean>>,
): boolean {
  return BUILTIN_RULES.filter((r) => !PRESET_FREE_RULES.has(r.id)).every(
    (r) => builtin[r.id] === false,
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
  return level.charAt(0).toUpperCase() + level.slice(1);
}

/** One line per level for the dropdown; the tooltip uses the same sentence. */
export const POLICY_LEVEL_DESCRIPTIONS: Record<
  PolicyArea,
  Partial<Record<PolicyLevel, string>>
> = {
  context: {
    manual: "Asks before each read.",
    cautious:
      "Reads what your Always rules and tool settings cover, asks otherwise.",
    automatic: "As Cautious, and a reviewer model decides what is left.",
    permissive: "Reads anything no rule stops.",
  },
  tools: {
    manual: "Asks before each command and tool.",
    cautious:
      "Runs what your Always rules and tool settings cover, asks otherwise.",
    automatic: "As Cautious, and a reviewer model decides what is left.",
    permissive: "Runs anything no rule stops.",
  },
  edits: {
    manual: "You review each diff.",
    cautious: "Accepts what your Always rules cover, you review the rest.",
    automatic: "A reviewer model accepts, refuses or sends it to you.",
    permissive: "Accepts anything no rule stops.",
  },
  plan: {
    manual: "In Loop, every plan and re-plan waits for you.",
    cautious:
      "In Loop, the first plan waits. A re-plan goes on unless the re-plan switch holds it.",
    automatic: "In Loop, as Permissive until a plan reviewer exists.",
    permissive:
      "In Loop, plans go on. A re-plan goes on unless the re-plan switch holds it.",
  },
  questions: {
    manual: "You decide every question.",
    cautious: "You decide, except types a rule gives the agent.",
    permissive: "The agent decides, except types a rule gives you.",
    automatic:
      "A second model reviews the agent's answers and sends you the ones it is unsure about. Not built yet: works as Permissive.",
    delegate:
      "The agent decides every question for you and your list is ignored.",
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
    // Questions never had a safety check to switch off: its old IDGAF was
    // "the agent decides everything", which is Delegate
    const level =
      area === "questions" && isRetiredTopLevel(value)
        ? "delegate"
        : parsePolicyLevel(value);
    if (level === "delegate" && area !== "questions") {
      problems.push(`${area}: "delegate" is a Questions level only`);
    } else if (level) levels[area] = level;
    else problems.push(`${area}: "${String(value)}" is not a level`);
  }
  // Web: absent follows Tool use; an unknown value is reported and follows too
  if (given.web !== undefined) {
    const web = parseWebLevel(given.web);
    if (web) levels.web = web;
    else {
      problems.push(
        `web: "${String(given.web)}" is not a level, so Web follows Tool use`,
      );
    }
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

/**
 * Rules that run only when the person turned them on: a key that is absent is
 * off. Every other rule is on unless its key says false. The shell check is
 * here because it stops commands that would otherwise run.
 */
export const OPT_IN_RULES: ReadonlySet<BuiltinRuleId> = new Set([
  "check-shell-commands",
  "ask-runtime-writes",
]);

/**
 * Rules no preset sets: they are the person's own choice, so Careful, IDGAF and
 * the others leave them as they are. The opt-in rules, and the rule that only
 * adds a note to a result.
 */
export const PRESET_FREE_RULES: ReadonlySet<BuiltinRuleId> = new Set([
  ...OPT_IN_RULES,
  "steer-repeated-calls",
]);

/** Whether a rule is on, given the `builtin` map as the person has it. */
export function builtinIsOn(
  builtin: Partial<Record<BuiltinRuleId, boolean>> | undefined,
  id: BuiltinRuleId,
): boolean {
  const set = builtin?.[id];
  return OPT_IN_RULES.has(id) ? set === true : set !== false;
}

export function builtinRuleOn(
  policy: PolicySettings | undefined,
  id: BuiltinRuleId,
): boolean {
  return builtinIsOn(policy?.builtin, id);
}

/** Automatic needs a reviewer: without one, Cautious, so nothing loosens. */
export function withoutReviewer(policy: PolicySettings): PolicySettings {
  const levels = { ...policy.levels };
  for (const area of POLICY_AREAS) {
    if (levels[area] === "automatic") levels[area] = "cautious";
  }
  if (levels.web === "automatic") levels.web = "cautious";
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
  if (level === "manual") return "person";
  // Delegate: the person's own list does not apply
  if (level === "delegate") return "agent";
  const known = QUESTION_TYPES.includes(type as QuestionType)
    ? (type as QuestionType)
    : undefined;
  // Automatic is review and no reviewer for questions is built: as Permissive
  if (level === "permissive" || level === "automatic") {
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
  const holdsReplans = builtinRuleOn(policy, "plan-keeps-checks");
  if (level === "manual") {
    return concern && holdsReplans
      ? { decision: "wait", reason: concern }
      : { decision: "wait", reason: "Every plan waits for you." };
  }
  // Two controls, not a ladder: does the first plan wait (Cautious does), and
  // does a re-plan that weakens a check or adds many to-dos wait (one switch).
  // A re-plan after a finished or impossible task is ordinary work, so it goes on.
  const name = policyLevelLabel("plan", level);
  if (first) {
    return level === "cautious"
      ? { decision: "wait", reason: "The first plan waits for you." }
      : { decision: "go", reason: `Plan edits is ${name}.` };
  }
  if (holdsReplans) {
    // A re-plan that changes a failing check or drops a finished item waits at
    // Cautious. At Permissive and Automatic the person opted out of plan cards,
    // so only its size holds it back.
    if (concern && level === "cautious") {
      return { decision: "wait", reason: concern };
    }
    const max = policy.maxNewPlanItems ?? DEFAULT_MAX_NEW_PLAN_ITEMS;
    if (added > max) {
      return {
        decision: "wait",
        reason: `The re-plan adds ${count(added)}, more than ${max}.`,
      };
    }
  }
  return added === 0
    ? { decision: "go", reason: "The re-plan adds no new to-dos." }
    : { decision: "go", reason: `Plan edits is ${name}: the re-plan goes on.` };
}

/**
 * The Questions levels at which nobody is asked: an answer is chosen for the
 * agent (see core/util/autoAnswer.ts). The loop's own gates use this one test.
 */
export function questionsAutoAnswer(level: PolicyLevel): boolean {
  return (
    level === "automatic" || level === "permissive" || level === "delegate"
  );
}

/**
 * Questions is Delegate (every decision is the agent's; a stored `idgaf` or
 * `yolo`, which meant the same, is migrated to it): nothing asks, in a loop or outside one, on
 * any surface. The person's own "you decide" list does not apply, and a
 * question is answered for the agent (core/util/autoAnswer.ts) rather than shown.
 */
export function questionsNeverAsk(level: PolicyLevel | undefined): boolean {
  return typeof level === "string" && parsePolicyLevel(level) === "delegate";
}
