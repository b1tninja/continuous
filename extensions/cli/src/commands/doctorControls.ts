/**
 * The controls of `continuous doctor config`: each one's value in force and
 * its source. Every value is computed by the function a start uses
 * (`loadPolicyFile`, `parsePolicySpec`, `effectiveLevels`, `loadHooksConfig`,
 * `inspectProjectConfig`, `tightenLimits`), so what is printed is what is
 * enforced. Rules are counted, never printed.
 */

import * as path from "node:path";

import {
  inspectProjectConfig,
  isProjectConfigTrustedForRun,
  setProjectConfigTrustedForRun,
  type ProjectScopeStatus,
} from "core/config/projectTrust.js";
import {
  BUILTIN_RULES,
  POLICY_AREA_LABELS,
  POLICY_AREAS,
  POLICY_PRESETS,
  presetOf,
  type PolicyArea,
  type PolicyLevels,
} from "core/tools/permissions/policy.js";
import { readTaintedSessionRule } from "core/tools/permissions/taint/taintSetting.js";
import {
  getTerminalEnvironmentStatus,
  resolveTerminalSettings,
} from "core/util/terminalEnvironment.js";
import { readUserTerminalSettings } from "core/util/userTerminalSettings.js";

import { tightenLimits, type RunLimits } from "../budget/runBudget.js";
import {
  limitsFromFlags,
  loadConfiguredLimits,
  type RunLimitOptions,
} from "../budget/runLimits.js";
import {
  loadHooksConfig,
  type LoadedHooksConfig,
} from "../hooks/hookConfig.js";
import {
  isProjectHooksTrustedForRun,
  setTrustProjectHooksForRun,
} from "../hooks/hookTrust.js";
import type { HooksConfig } from "../hooks/types.js";
import {
  isAutoReviewEnabled,
  setAutoReviewEnabled,
} from "../permissions/coreRules.js";
import {
  effectiveLevels,
  getPolicyExtras,
  getPolicyLevels,
  loadPolicyFile,
  parsePolicySpec,
  resetPolicyLevels,
  setPolicyLevels,
} from "../permissions/policyLevels.js";

export type ControlSource =
  "default" | "user-file" | "project-file" | "flag" | "env";

export interface ControlReport {
  /** Stable id: `level.tools`, `protection.protect-secrets`, `runLimit.maxTurns`, ... */
  id: string;
  group: string;
  label: string;
  value: string | number | boolean | null;
  source: ControlSource;
  /** The file, flag or variable that supplied the value. */
  sourceDetail?: string;
}

/** The root flags of this invocation that change a control. */
export interface DoctorFlags extends RunLimitOptions {
  config?: string;
  policy?: string;
  auto?: boolean;
  autoReview?: boolean;
  readonly?: boolean;
  allow?: string[];
  ask?: string[];
  exclude?: string[];
  trustProjectHooks?: boolean;
  trustProjectConfig?: boolean;
}

/** What the collectors read, resolved once by doctorConfig.ts. */
export interface ControlContext {
  cwd: string;
  /** For tests; undefined means the real home folder. */
  homeDir?: string;
  globalDir: string;
  /** The variable that named the global folder, when one did. */
  globalDirVariable?: string;
  flags: DoctorFlags;
  env: Readonly<Record<string, string | undefined>>;
  /** The global config.yaml (the tainted-session rule is read only there). */
  userConfigFile: string;
  permissionsFile: string;
  /** permissions.yaml as parsed, or {} */
  permissions: Record<string, unknown>;
  /** The user's hook settings files that parsed, by path. */
  userHookSettings: { path: string; value: Record<string, unknown> }[];
}

type Source = Pick<ControlReport, "source" | "sourceDetail">;

function from(source: ControlSource, detail?: string): Source {
  return detail ? { source, sourceDetail: detail } : { source };
}

const AREA_WORDS: Record<string, PolicyArea> = {
  context: "context",
  tools: "tools",
  tool: "tools",
  edits: "edits",
  edit: "edits",
  plan: "plan",
  plans: "plan",
  questions: "questions",
  question: "questions",
};

/** The areas a `--policy` spec names: all of them for a preset or a bare level. */
export function areasNamed(spec: string): PolicyArea[] {
  const named = new Set<PolicyArea>();
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const [key, value] = part.split("=");
    if (value === undefined) return [...POLICY_AREAS];
    const area = AREA_WORDS[key.trim().toLowerCase()];
    if (area) named.add(area);
  }
  return [...named];
}

// ---------------------------------------------------------------------------
// Levels and preset
// ---------------------------------------------------------------------------

interface LevelInputs {
  levels: PolicyLevels;
  chosen: PolicyLevels;
  fileLevels: PolicyLevels;
  policyAreas: PolicyArea[];
}

function levelSource(
  ctx: ControlContext,
  area: PolicyArea,
  inputs: LevelInputs,
): Source {
  if (inputs.levels[area] !== inputs.chosen[area]) {
    return from("flag", ctx.flags.auto ? "--auto" : "--auto-review");
  }
  if (inputs.policyAreas.includes(area)) return from("flag", "--policy");
  const saved = (ctx.permissions.levels ?? {}) as Record<string, unknown>;
  if (
    saved[area] !== undefined &&
    inputs.levels[area] === inputs.fileLevels[area]
  ) {
    return from("user-file", ctx.permissionsFile);
  }
  return from("default");
}

/** The preset is a name for the five levels: its source is the strongest of theirs. */
function presetControl(levels: PolicyLevels, sources: Source[]): ControlReport {
  const preset = presetOf(levels);
  const strongest =
    sources.find((s) => s.source === "flag") ??
    sources.find((s) => s.source === "user-file") ??
    from("default");
  return {
    id: "preset",
    group: "Permission levels",
    label: "Preset",
    value: preset ? POLICY_PRESETS[preset].label : "Custom",
    ...strongest,
  };
}

function levelControls(ctx: ControlContext): ControlReport[] {
  loadPolicyFile(ctx.permissionsFile);
  const fileLevels = getPolicyLevels();
  const inputs: LevelInputs = {
    levels: fileLevels,
    chosen: fileLevels,
    fileLevels,
    policyAreas: [],
  };
  if (ctx.flags.policy !== undefined) {
    const parsed = parsePolicySpec(ctx.flags.policy);
    if (parsed.ok) {
      inputs.chosen = parsed.levels;
      inputs.policyAreas = areasNamed(ctx.flags.policy);
      setPolicyLevels(parsed.levels);
    }
  }
  setAutoReviewEnabled(ctx.flags.autoReview === true);
  inputs.levels = effectiveLevels(ctx.flags.auto ? "auto" : "normal");
  const sources = POLICY_AREAS.map((area) => levelSource(ctx, area, inputs));
  const controls: ControlReport[] = POLICY_AREAS.map((area, i) => ({
    id: `level.${area}`,
    group: "Permission levels",
    label: POLICY_AREA_LABELS[area],
    value: inputs.levels[area],
    ...sources[i],
  }));
  controls.push(presetControl(inputs.levels, sources));
  if (ctx.flags.readonly) {
    controls.push({
      id: "mode",
      group: "Permission levels",
      label: "Mode",
      value: "plan (read-only tools)",
      ...from("flag", "--readonly"),
    });
  }
  return controls;
}

// ---------------------------------------------------------------------------
// Rules and Protections
// ---------------------------------------------------------------------------

function ruleListControl(
  ctx: ControlContext,
  list: "exclude" | "ask" | "allow",
): ControlReport {
  const saved = ctx.permissions[list];
  const inFile = Array.isArray(saved) ? saved.length : 0;
  const fromFlag = ctx.flags[list]?.length ?? 0;
  let source = from("default");
  if (fromFlag) {
    source = from(
      "flag",
      inFile
        ? `--${list} (${fromFlag}), ${ctx.permissionsFile} (${inFile})`
        : `--${list}`,
    );
  } else if (inFile) {
    source = from("user-file", ctx.permissionsFile);
  }
  return {
    id: `rules.${list}`,
    group: "Rules",
    label: `${list} rules`,
    value: inFile + fromFlag,
    ...source,
  };
}

/** Call after levelControls, which loads the file these come from. */
function ruleControls(ctx: ControlContext): ControlReport[] {
  const floor = getPolicyExtras().floor?.length ?? 0;
  return [
    {
      id: "floor",
      group: "Rules",
      label: "Floor (Never at every level)",
      value: floor,
      ...(floor ? from("user-file", ctx.permissionsFile) : from("default")),
    },
    ruleListControl(ctx, "exclude"),
    ruleListControl(ctx, "ask"),
    ruleListControl(ctx, "allow"),
  ];
}

function protectionControls(ctx: ControlContext): ControlReport[] {
  const builtin = getPolicyExtras().builtin ?? {};
  const controls: ControlReport[] = BUILTIN_RULES.map((rule) => {
    const set = builtin[rule.id];
    return {
      id: `protection.${rule.id}`,
      group: "Protections",
      label: rule.label,
      value: set === false ? "off" : "on",
      ...(set === undefined
        ? from("default")
        : from("user-file", ctx.permissionsFile)),
    };
  });
  const taint = readTaintedSessionRule(ctx.userConfigFile);
  controls.push({
    id: "taintedSessionRule",
    group: "Protections",
    label: "Tainted-session rule",
    value: taint,
    ...(taint === "ask"
      ? from("user-file", ctx.userConfigFile)
      : from("default")),
  });
  return controls;
}

// ---------------------------------------------------------------------------
// Hooks and project trust
// ---------------------------------------------------------------------------

function countHandlers(hooks: HooksConfig, project: boolean): number {
  let n = 0;
  for (const groups of Object.values(hooks)) {
    for (const group of groups ?? []) {
      n += group.hooks.filter(
        (h) => (h.origin === "project") === project,
      ).length;
    }
  }
  return n;
}

function projectHookControl(
  ctx: ControlContext,
  loaded: LoadedHooksConfig,
): ControlReport {
  const base = { id: "hooks.project", group: "Hooks", label: "Project hooks" };
  const held = loaded.untrustedProject?.handlers.length ?? 0;
  const running = countHandlers(loaded.hooks, true);
  if (held) {
    return {
      ...base,
      value: `${held} not running (not trusted)`,
      ...from("default"),
    };
  }
  if (running) {
    return {
      ...base,
      value: `${running} running (trusted)`,
      ...(ctx.flags.trustProjectHooks
        ? from("flag", "--trust-project-hooks")
        : from("user-file", path.join(ctx.globalDir, "trusted-hooks.json"))),
    };
  }
  if (loaded.managedOnly) {
    return {
      ...base,
      value: "not read (managedHooksOnly)",
      ...from("user-file"),
    };
  }
  return { ...base, value: "none", ...from("default") };
}

function disableAllSource(
  ctx: ControlContext,
  loaded: LoadedHooksConfig,
): Source {
  if (!loaded.disabled) return from("default");
  const mine = ctx.userHookSettings.find((f) => f.value.disableAllHooks);
  return mine ? from("user-file", mine.path) : from("project-file");
}

function hookControls(ctx: ControlContext): ControlReport[] {
  setTrustProjectHooksForRun(!!ctx.flags.trustProjectHooks);
  const loaded = loadHooksConfig(ctx.cwd, ctx.homeDir);
  const mine = countHandlers(loaded.hooks, false);
  return [
    {
      id: "hooks.user",
      group: "Hooks",
      label: "Your hooks",
      value: loaded.disabled ? `${mine} (all hooks switched off)` : mine,
      ...(mine ? from("user-file") : from("default")),
    },
    projectHookControl(ctx, loaded),
    {
      id: "hooks.disableAllHooks",
      group: "Hooks",
      label: "All hooks switched off",
      value: loaded.disabled,
      ...disableAllSource(ctx, loaded),
    },
  ];
}

function projectScopeControl(
  ctx: ControlContext,
  scope: ProjectScopeStatus,
): ControlReport {
  const byFlag = !!ctx.flags.trustProjectConfig;
  let source = from("default");
  if (byFlag) source = from("flag", "--trust-project-config");
  else if (scope.trusted) {
    source = from(
      "user-file",
      path.join(ctx.globalDir, "trusted-project.json"),
    );
  }
  return {
    id: `project.${scope.scope}`,
    group: "Project trust",
    label: `Project ${scope.scope} files (${scope.files.length})`,
    value:
      byFlag || scope.trusted ? "trusted, loaded" : "not trusted, not loaded",
    ...source,
  };
}

function projectControls(ctx: ControlContext): ControlReport[] {
  // Asked without the flag, so `trusted` means "recorded as trusted".
  setProjectConfigTrustedForRun(false);
  const scopes = inspectProjectConfig(ctx.cwd, ctx.globalDir);
  if (scopes.length === 0) {
    return [
      {
        id: "project.config",
        group: "Project trust",
        label: "Project configuration",
        value: "none in this folder",
        ...from("default"),
      },
    ];
  }
  return scopes.map((scope) => projectScopeControl(ctx, scope));
}

// ---------------------------------------------------------------------------
// Environment and run limits
// ---------------------------------------------------------------------------

function terminalSource(
  ctx: ControlContext,
  source: ReturnType<typeof getTerminalEnvironmentStatus>["source"],
): Source {
  switch (source) {
    case "env":
      return from("env", "CONTINUE_TERMINAL_ENV");
    case "default":
      return from("default");
    default:
      return from("user-file", ctx.userConfigFile);
  }
}

/**
 * `continuous doctor env` (ENV28, planned) reports what the model is told
 * about this machine; it is a topic of its own (DOCTOR_TOPICS in doctor.ts),
 * not a row here.
 */
function environmentControls(ctx: ControlContext): ControlReport[] {
  resolveTerminalSettings(
    readUserTerminalSettings(ctx.userConfigFile),
    undefined,
  );
  const terminal = getTerminalEnvironmentStatus(ctx.env);
  return [
    {
      id: "env.globalDir",
      group: "Environment",
      label: "Global folder",
      value: ctx.globalDir,
      ...(ctx.globalDirVariable
        ? from("env", ctx.globalDirVariable)
        : from("default")),
    },
    {
      id: "env.terminalEnvironment",
      group: "Environment",
      label: "Environment passed to commands",
      value: terminal.mode,
      ...terminalSource(ctx, terminal.source),
    },
  ];
}

const LIMITS: [keyof RunLimits, string, string][] = [
  ["maxBudgetUsd", "--max-budget-usd", "Spend limit (USD)"],
  ["maxTurns", "--max-turns", "Model requests"],
  ["maxDurationMinutes", "--max-duration", "Minutes"],
];

function runLimitControls(ctx: ControlContext): ControlReport[] {
  let flagLimits: RunLimits = {};
  try {
    flagLimits = limitsFromFlags(ctx.flags);
  } catch {
    // A bad flag value is refused by the run itself.
  }
  const configured = loadConfiguredLimits(ctx.cwd, ctx.homeDir);
  const { limits } = tightenLimits(configured, flagLimits);
  return LIMITS.map(([key, flagName, label]) => {
    const value = limits[key];
    let source = from("default");
    if (value !== undefined && value === flagLimits[key]) {
      source = from("flag", flagName);
    } else if (value !== undefined) {
      source = from("user-file", path.join(ctx.globalDir, "settings.json"));
    }
    return {
      id: `runLimit.${key}`,
      group: "Run limits",
      label,
      value: value ?? null,
      ...source,
    };
  });
}

/**
 * Every control, in report order. The collectors use the process-wide state
 * a start uses (levels, the reviewer switch, the trust-for-this-run flags);
 * it is put back afterwards. `doctor` runs in a process of its own, so the
 * other settings `resetPolicyLevels` clears are not in use.
 */
export function collectControls(ctx: ControlContext): ControlReport[] {
  const levels = getPolicyLevels();
  const autoReview = isAutoReviewEnabled();
  const hookTrust = isProjectHooksTrustedForRun();
  const configTrust = isProjectConfigTrustedForRun();
  try {
    return [
      ...levelControls(ctx),
      ...ruleControls(ctx),
      ...protectionControls(ctx),
      ...hookControls(ctx),
      ...projectControls(ctx),
      ...environmentControls(ctx),
      ...runLimitControls(ctx),
    ];
  } finally {
    resetPolicyLevels();
    setPolicyLevels(levels);
    setAutoReviewEnabled(autoReview);
    setTrustProjectHooksForRun(hookTrust);
    setProjectConfigTrustedForRun(configTrust);
  }
}
